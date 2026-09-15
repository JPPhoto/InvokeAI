"""Load-time support for Comfy "nvfp4" quantized linears.

``nvfp4`` is a ComfyUI-wide scheme, not one architecture's format: Comfy-Org ships it for Z-Image,
Krea-2, Qwen-Image, the FLUX.2 Mistral encoder and more, often beside scaled fp8 and plain bf16 in the
same file. It therefore lives next to ``fp8_scaled`` and ``int8_convrot`` rather than in an
architecture package.

A quantized linear ``[out, in]`` is stored as:

- ``<layer>.weight``: uint8 ``[out, in/2]``, two 4-bit E2M1 codes per byte. Element ``2j`` is the
  *upper* nibble; reading the lower one first decodes to noise.
- ``<layer>.weight_scale``: float8_e4m3fn ``[out, in/16]``, one scale per 16-element block, in NVIDIA's
  cuBLAS block-scale layout rather than row by row (see :func:`unblock_scale_grid`).
- ``<layer>.weight_scale_2``: a float32 scalar, multiplied in:
  ``W = E2M1[codes] * block_scale * weight_scale_2``.
- optionally ``<layer>.input_scale``, an activation scale for fp4 compute, and a ``.comfy_quant``
  marker. Some producers name their layers in the ``_quantization_metadata`` header instead; detection
  here is structural -- a ``weight_scale_2`` beside the weight -- so it needs neither.

These facts were established against real checkpoints, not a specification: decoding every nvfp4
tensor of the Mistral FLUX.2 encoder and Z-Image Turbo builds reaches cosine 0.995 against the bf16
build in the same repository, the floor of 4-bit block quantization. Reading the scale grid row by row
instead still loads without an error and reaches 0.68-0.95 -- a model that runs and follows its
conditioning slightly worse. That silence is why tests pin the layout against the measured index
formula and against a slice of a real checkpoint.

The weights are dequantized to the compute dtype at load, so an nvfp4 checkpoint loads correctly but
occupies as much memory as its bf16 build. AWQ builds (``pre_quant_scale``) are refused: their input
channels were rescaled before quantization, so a plain decode would produce wrong weights.
"""

from collections.abc import Callable
from typing import Any

import torch
import torch.nn.functional as F

from invokeai.backend.quantization.fp8_scaled import COMFY_QUANT_SUFFIX, INPUT_SCALE_SUFFIXES, iter_weight_scale_pairs
from invokeai.backend.quantization.int8_convrot import parse_comfy_quant_marker

NVFP4_FORMAT = "nvfp4"
NVFP4_BLOCK_SIZE = 16

WEIGHT_SCALE_2_SUFFIX = ".weight_scale_2"
PRE_QUANT_SCALE_SUFFIX = ".pre_quant_scale"

# What a decoded layer no longer needs besides its weight.
_SIDE_CHANNEL_SUFFIXES = (".weight_scale", WEIGHT_SCALE_2_SUFFIX, COMFY_QUANT_SUFFIX, *INPUT_SCALE_SUFFIXES)

# cuBLAS block-scale tiles span 128 rows and 4 blocks.
_TILE_ROWS = 128
_TILE_BLOCKS = 4

_E2M1_VALUES = torch.tensor([0.0, 0.5, 1.0, 1.5, 2.0, 3.0, 4.0, 6.0, -0.0, -0.5, -1.0, -1.5, -2.0, -3.0, -4.0, -6.0])
# Both decoded elements of every possible byte, upper nibble first: one lookup per byte.
_E2M1_BYTE_PAIRS = torch.stack([_E2M1_VALUES[torch.arange(256) >> 4], _E2M1_VALUES[torch.arange(256) & 0x0F]], dim=1)


def _check_tile_layout(rows: int, blocks: int) -> None:
    if rows % _TILE_ROWS or blocks % _TILE_BLOCKS:
        raise ValueError(
            f"a {rows}x{blocks} block-scale grid is not in the cuBLAS tile layout: rows must be a multiple of "
            f"{_TILE_ROWS} and blocks a multiple of {_TILE_BLOCKS}. Padded grids are not implemented."
        )


def unblock_scale_grid(scale: torch.Tensor) -> torch.Tensor:
    """Reorder a block-scale grid from cuBLAS's tiled layout into row-major ``[rows, blocks]``.

    cuBLAS and TensorRT take block-scale operands tiled: the grid is cut into tiles of 128 rows and 4
    blocks, the tiles are stored in row-major order, and inside a tile the entries run over
    ``row % 32``, then ``row // 32``, then the block. Producers write that layout into a tensor of the
    row-major shape, so nothing about the shape gives it away. It is a permutation, and inverting it is
    a reshape: stored ``(tile row, tile column, row % 32, row // 32, block)`` becomes
    ``(tile row, row // 32, row % 32, tile column, block)``.

    The MXFP8 scales ``fp8_scaled._reject_mx_scale`` refuses are stored reordered too; whether in these
    tiles, with their 32-element blocks, has not been measured.
    """
    if scale.dim() != 2:
        raise ValueError(f"expected a 2-D block-scale grid, got shape {tuple(scale.shape)}")
    rows, blocks = scale.shape
    _check_tile_layout(rows, blocks)
    tiles = scale.reshape(rows // _TILE_ROWS, blocks // _TILE_BLOCKS, 32, 4, _TILE_BLOCKS)
    return tiles.permute(0, 3, 2, 1, 4).reshape(rows, blocks)


def _check_layout(weight: torch.Tensor | None, weight_scale: torch.Tensor | None, weight_scale_2: torch.Tensor) -> None:
    """Refuse tensors this decode would misread. Reads dtypes and shapes only."""
    if weight is None or weight_scale is None:
        raise ValueError(f"has a weight_scale_2 but no {'weight' if weight is None else 'weight_scale'}")
    if weight.dtype is not torch.uint8 or weight.dim() != 2:
        raise ValueError(f"expected a packed uint8 [out, in/2] weight, got {weight.dtype} {tuple(weight.shape)}")
    if weight_scale.dtype is not torch.float8_e4m3fn or weight_scale.dim() != 2:
        raise ValueError(
            f"expected a float8_e4m3fn [out, in/16] block scale, got {weight_scale.dtype} {tuple(weight_scale.shape)}"
        )
    if weight_scale_2.numel() != 1:
        raise ValueError(f"expected a scalar weight_scale_2, got shape {tuple(weight_scale_2.shape)}")
    out_features, packed_width = weight.shape
    rows, blocks = weight_scale.shape
    if rows != out_features or packed_width * 2 != blocks * NVFP4_BLOCK_SIZE:
        raise ValueError(
            f"a {tuple(weight_scale.shape)} block scale does not describe a {tuple(weight.shape)} packed weight "
            f"({NVFP4_BLOCK_SIZE}-element blocks, two elements per byte)"
        )
    _check_tile_layout(rows, blocks)


def dequantize_nvfp4_weight(
    weight: torch.Tensor, weight_scale: torch.Tensor, weight_scale_2: torch.Tensor, dtype: torch.dtype
) -> torch.Tensor:
    """Decode one nvfp4 weight to ``[out, in]`` in ``dtype``, on the weight's device.

    Decodes in ``dtype`` directly. The E2M1 values and the e4m3 block scales are exact in bf16, and the
    rounding the float32 global scale introduces is far below the 4-bit quantization error. That keeps
    the transient at the result plus an int32 byte index, two bytes per weight element each, instead of
    adding a float32 copy on top.
    """
    _check_layout(weight, weight_scale, weight_scale_2)
    out_features, blocks = weight_scale.shape
    device = weight.device
    global_scale = weight_scale_2.to(device=device, dtype=torch.float32).reshape(())
    grid = unblock_scale_grid(weight_scale.to(device=device, dtype=torch.float32)) * global_scale
    values = F.embedding(weight.to(torch.int32), _E2M1_BYTE_PAIRS.to(device=device, dtype=dtype))
    values = values.view(out_features, blocks, NVFP4_BLOCK_SIZE).mul_(grid.to(dtype).unsqueeze(-1))
    return values.view(out_features, blocks * NVFP4_BLOCK_SIZE)


def dequantize_nvfp4_layers(
    sd: dict[str, Any], dtype: torch.dtype, reserve: Callable[[int], object] | None = None
) -> int:
    """Decode every nvfp4 layer in ``sd`` to ``dtype`` in place, drop its side channel, return the count.

    Call it before any fp8 handling. The scaled-fp8 extraction pops every ``weight_scale`` in the file
    and discards those whose weight is not float8 -- nvfp4's block scales included -- and the folds that
    multiply a scale in would stretch the ``[out, in/16]`` grid over the packed ``[out, in/2]`` weight.
    Decided per layer, never per file: the same checkpoints mix nvfp4 with scaled fp8, whose weights,
    scales and markers are left for that path.

    Nothing is widened until everything has been checked: AWQ layers, packed weights with a
    ``weight_scale`` but no ``weight_scale_2``, markers that contradict their tensors and malformed
    layers are refused first, naming the layer. Then ``reserve`` -- a loader's ``make_room`` -- is called
    once with the size ``sd`` will have after decoding. The model cache reserves only the file size
    before a load and decoding more than triples it, so reserving afterwards would let the peak land on
    memory other cached models still hold.
    """
    layers = sorted(
        k[: -len(WEIGHT_SCALE_2_SUFFIX)] for k in sd if isinstance(k, str) and k.endswith(WEIGHT_SCALE_2_SUFFIX)
    )
    claimed = set(layers)

    awq = [path for path in layers if f"{path}{PRE_QUANT_SCALE_SUFFIX}" in sd]
    if awq:
        raise ValueError(
            f"Checkpoint has {len(awq)} nvfp4 layer(s) with an AWQ pre_quant_scale, e.g. {awq[:3]}. AWQ rescales "
            "input channels before quantization and is not supported; decoding these as plain nvfp4 would load "
            "wrong weights."
        )

    for key in [k for k in sd if isinstance(k, str) and k.endswith(COMFY_QUANT_SUFFIX)]:
        path = key[: -len(COMFY_QUANT_SUFFIX)]
        marked = parse_comfy_quant_marker(sd[key]).get("format")
        if marked == NVFP4_FORMAT and path not in claimed:
            raise ValueError(f"nvfp4 layer '{path}' has no weight_scale_2, so it cannot be decoded.")
        if path in claimed and marked not in (None, NVFP4_FORMAT):
            raise ValueError(f"nvfp4 layer '{path}' is marked {marked!r}, which contradicts its tensors.")

    half = sorted(
        weight_key
        for weight_key, _ in iter_weight_scale_pairs(sd)
        if weight_key[: -len(".weight")] not in claimed and getattr(sd[weight_key], "dtype", None) is torch.uint8
    )
    if half:
        raise ValueError(
            f"Checkpoint has {len(half)} packed uint8 weight(s) with a weight_scale but no weight_scale_2, "
            f"e.g. {half[:3]}. They look like nvfp4 missing its global scale; loading them would produce a "
            "model that runs and generates noise."
        )

    for path in layers:
        try:
            _check_layout(
                sd.get(f"{path}.weight"), sd.get(f"{path}.weight_scale"), sd[f"{path}{WEIGHT_SCALE_2_SUFFIX}"]
            )
        except ValueError as e:
            raise ValueError(f"nvfp4 layer '{path}': {e}") from None

    if not layers:
        return 0
    if reserve is not None:
        reserve(_decoded_size(sd, layers, dtype))
    for path in layers:
        weight, scale = sd[f"{path}.weight"], sd[f"{path}.weight_scale"]
        sd[f"{path}.weight"] = dequantize_nvfp4_weight(weight, scale, sd[f"{path}{WEIGHT_SCALE_2_SUFFIX}"], dtype)
        for suffix in _SIDE_CHANNEL_SUFFIXES:
            sd.pop(f"{path}{suffix}", None)
    return len(layers)


def _decoded_size(sd: dict[str, Any], layers: list[str], dtype: torch.dtype) -> int:
    """Bytes ``sd`` occupies once ``layers`` are decoded to ``dtype`` and their side channels dropped."""
    replaced = {f"{path}{suffix}" for path in layers for suffix in (".weight", *_SIDE_CHANNEL_SUFFIXES)}
    kept = sum(tensor.nelement() * tensor.element_size() for key, tensor in sd.items() if key not in replaced)
    decoded = sum(sd[f"{path}.weight"].shape[0] * sd[f"{path}.weight"].shape[1] * 2 for path in layers)
    return kept + decoded * dtype.itemsize
