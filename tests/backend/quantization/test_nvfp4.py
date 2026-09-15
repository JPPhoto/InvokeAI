"""nvfp4 decode: byte layout, block-scale layout, and the per-layer state-dict pass.

No expected value here comes from `nvfp4.py` itself. Nibble order and the E2M1 table are checked
against literal bytes; the block-scale layout against the index formula measured on real checkpoints,
written out as arithmetic; and the whole decode against a slice of a real Comfy-Org checkpoint and its
bf16 build. That slice is one tile row high: it pins the layout inside a row of tiles against real data,
while the order of the tile rows rests on the formula test.
"""

import json
from pathlib import Path

import pytest
import torch
from safetensors.torch import load_file

from invokeai.backend.quantization.nvfp4 import dequantize_nvfp4_layers, dequantize_nvfp4_weight, unblock_scale_grid

FIXTURE = Path(__file__).parent / "data" / "z_image_turbo_nvfp4_slices.safetensors"

E2M1 = torch.tensor([0.0, 0.5, 1.0, 1.5, 2.0, 3.0, 4.0, 6.0, -0.0, -0.5, -1.0, -1.5, -2.0, -3.0, -4.0, -6.0])


def _marker_blob(marker: dict) -> torch.Tensor:
    return torch.frombuffer(bytearray(json.dumps(marker).encode("utf-8")), dtype=torch.uint8)


def _stored_layout(grid: torch.Tensor) -> torch.Tensor:
    """Lay a row-major grid out the way the checkpoints store it, by the index formula measured
    against real files: element ``[m, k]`` lands at flat position ``position``."""
    rows, blocks = grid.shape
    flat = torch.full((rows * blocks,), float("nan"), dtype=grid.dtype)
    for m in range(rows):
        for k in range(blocks):
            position = ((((m // 128) * (blocks // 4) + k // 4) * 32 + m % 32) * 4 + (m % 128) // 32) * 4 + k % 4
            flat[position] = grid[m, k]
    return flat.reshape(rows, blocks)


def _nvfp4_tensors(path: str, codes: torch.Tensor, block_scale: float, global_scale: float) -> dict[str, torch.Tensor]:
    """One layer in checkpoint layout. A uniform block scale keeps the expectation independent of the
    tile layout, which the tests above pin on their own."""
    rows, in_features = codes.shape
    return {
        f"{path}.weight": (codes[:, 0::2] << 4) | codes[:, 1::2],
        f"{path}.weight_scale": torch.full((rows, in_features // 16), block_scale).to(torch.float8_e4m3fn),
        f"{path}.weight_scale_2": torch.tensor(global_scale),
    }


def _zero_layer(path: str, rows: int = 128) -> dict[str, torch.Tensor]:
    return _nvfp4_tensors(path, torch.zeros(rows, 64, dtype=torch.uint8), 1.0, 1.0)


def test_the_upper_nibble_is_the_first_element_and_both_scales_multiply() -> None:
    weight = torch.zeros(128, 32, dtype=torch.uint8)
    # Every code once: 0x7F is 7 then 15, 0x19 is 1 then 9, and so on.
    weight[0, :8] = torch.tensor([0x7F, 0x19, 0x2C, 0x35, 0x46, 0xAB, 0xDE, 0x08], dtype=torch.uint8)
    scale = torch.full((128, 4), 4.0).to(torch.float8_e4m3fn)

    decoded = dequantize_nvfp4_weight(weight, scale, torch.tensor(0.125), torch.float32)

    codes = [6.0, -6.0, 0.5, -0.5, 1.0, -2.0, 1.5, 3.0, 2.0, 4.0, -1.0, -1.5, -3.0, -4.0, 0.0, -0.0]
    assert torch.equal(decoded[0, :16], torch.tensor(codes) * 0.5)
    assert decoded.shape == (128, 64)


@pytest.mark.parametrize("shape", [(128, 4), (128, 8), (256, 16), (384, 8)])
def test_the_block_scale_grid_is_unblocked_the_way_checkpoints_store_it(shape: tuple[int, int]) -> None:
    """(384, 8) is three tile rows by two tile columns, so a swap of the tile axes cannot pass."""
    grid = torch.arange(shape[0] * shape[1], dtype=torch.float64).reshape(shape)

    assert torch.equal(unblock_scale_grid(_stored_layout(grid)), grid)


@pytest.mark.parametrize("shape", [(100, 8), (128, 6)])
def test_a_grid_outside_the_tile_layout_is_refused_rather_than_guessed(shape: tuple[int, int]) -> None:
    with pytest.raises(ValueError, match="tile layout"):
        unblock_scale_grid(torch.zeros(shape))


@pytest.mark.parametrize("layer", ["layers.0.attention.out", "layers.5.feed_forward.w2"])
def test_a_real_checkpoint_slice_decodes_to_its_bf16_build(layer: str) -> None:
    """Comfy-Org/z_image_turbo at revision 08d04455279082882deaabc8d0d09fc914c071e1 (Apache-2.0): the
    first 128 rows and input columns of `split_files/diffusion_models/z_image_turbo_nvfp4.safetensors`
    and of `z_image_turbo_bf16.safetensors` beside it. The block scales are the first 8x128 entries of
    the stored grid, which is exactly the tiled layout of that 128x8 sub-grid.

    Measured when cut: cosine 0.9953 and 0.9955 decoded, 0.9102 and 0.8801 with the grid read row by
    row. The latter loads without an error and quietly degrades the model -- the failure pinned here.
    The norm check is what catches a global scale applied the wrong way, which leaves the cosine alone.
    """
    fixture = load_file(FIXTURE)
    weight, scale = fixture[f"{layer}.weight"], fixture[f"{layer}.weight_scale"]
    scale_2 = fixture[f"{layer}.weight_scale_2"]
    reference = fixture[f"{layer}.bf16_reference"].float().flatten()

    decoded = dequantize_nvfp4_weight(weight, scale, scale_2, torch.float32).flatten()
    assert torch.cosine_similarity(decoded, reference, dim=0).item() > 0.99
    assert (decoded.norm() / reference.norm()).item() == pytest.approx(1.0, abs=0.01)

    # Laying the stored grid out once more makes the unblock hand back the raw grid: a row-major read.
    row_major = _stored_layout(scale.float()).to(torch.float8_e4m3fn)
    naive = dequantize_nvfp4_weight(weight, row_major, scale_2, torch.float32).flatten()
    assert torch.cosine_similarity(naive, reference, dim=0).item() < 0.95


@pytest.mark.parametrize("dtype", [torch.float32, torch.bfloat16])
def test_only_nvfp4_layers_are_decoded_and_the_rest_is_left_for_the_fp8_path(dtype: torch.dtype) -> None:
    torch.manual_seed(0)
    codes = torch.randint(0, 16, (128, 64), dtype=torch.uint8)
    fp8_weight = torch.randn(32, 32).to(torch.float8_e4m3fn)
    fp8_scale = torch.tensor(0.5)
    fp8_marker = _marker_blob({"format": "float8_e4m3fn"})
    dense = torch.randn(8)
    tekken = torch.randint(0, 256, (64,), dtype=torch.uint8)
    sd = {
        **_nvfp4_tensors("blocks.0.mlp", codes, block_scale=2.0, global_scale=0.25),
        "blocks.0.mlp.input_scale": torch.tensor(1.0),
        "blocks.0.mlp.comfy_quant": _marker_blob({"format": "nvfp4"}),
        "blocks.0.attn.weight": fp8_weight,
        "blocks.0.attn.weight_scale": fp8_scale,
        "blocks.0.attn.comfy_quant": fp8_marker,
        "blocks.0.norm.weight": dense,
        "tekken_model": tekken,
    }

    assert dequantize_nvfp4_layers(sd, dtype) == 1

    assert sd["blocks.0.mlp.weight"].dtype is dtype
    assert torch.equal(sd["blocks.0.mlp.weight"], (E2M1[codes.long()] * 0.5).to(dtype))
    assert [k for k in sd if k.startswith("blocks.0.mlp.")] == ["blocks.0.mlp.weight"]
    # The scaled-fp8 layer, its scale and its marker belong to the fp8 path.
    assert sd["blocks.0.attn.weight"] is fp8_weight
    assert sd["blocks.0.attn.weight_scale"] is fp8_scale
    assert sd["blocks.0.attn.comfy_quant"] is fp8_marker
    assert sd["blocks.0.norm.weight"] is dense
    assert sd["tekken_model"] is tekken


def test_room_for_the_decoded_state_dict_is_reserved_before_any_layer_is_widened() -> None:
    sd = {**_zero_layer("layer", rows=256), "layer.input_scale": torch.tensor(1.0), "norm.weight": torch.zeros(10)}
    reservations: list[tuple[int, torch.dtype]] = []

    dequantize_nvfp4_layers(
        sd, torch.bfloat16, reserve=lambda size: reservations.append((size, sd["layer.weight"].dtype))
    )

    # The decoded [256, 64] weight at two bytes per element plus the untouched float32 norm; the packed
    # payload and the side channel are gone by then. Still uint8 when asked: nothing was widened yet.
    assert reservations == [(256 * 64 * 2 + 10 * 4, torch.uint8)]


def test_nothing_is_reserved_for_a_checkpoint_without_nvfp4_layers() -> None:
    reservations: list[int] = []

    assert dequantize_nvfp4_layers({"norm.weight": torch.zeros(10)}, torch.bfloat16, reserve=reservations.append) == 0
    assert reservations == []


def test_an_awq_checkpoint_is_refused_before_anything_is_decoded() -> None:
    sd = {**_zero_layer("layer"), "layer.pre_quant_scale": torch.ones(64)}

    with pytest.raises(ValueError, match="AWQ"):
        dequantize_nvfp4_layers(sd, torch.float32)
    assert sd["layer.weight"].dtype is torch.uint8


def test_a_packed_weight_without_its_global_scale_is_refused() -> None:
    sd = _zero_layer("layer")
    del sd["layer.weight_scale_2"]

    with pytest.raises(ValueError, match="with a weight_scale but no weight_scale_2"):
        dequantize_nvfp4_layers(sd, torch.float32)


@pytest.mark.parametrize("missing", ["weight", "weight_scale"])
def test_a_global_scale_without_its_layer_is_refused_naming_it(missing: str) -> None:
    sd = _zero_layer("layer")
    del sd[f"layer.{missing}"]

    with pytest.raises(ValueError, match=f"nvfp4 layer 'layer': has a weight_scale_2 but no {missing}$"):
        dequantize_nvfp4_layers(sd, torch.float32)


def test_a_global_scale_on_a_dense_weight_is_refused() -> None:
    sd = _zero_layer("layer")
    sd["layer.weight"] = torch.zeros(128, 64)

    with pytest.raises(ValueError, match="nvfp4 layer 'layer': expected a packed uint8"):
        dequantize_nvfp4_layers(sd, torch.float32)


def test_a_malformed_layer_is_refused_before_any_layer_is_decoded_or_reserved() -> None:
    sd = {**_zero_layer("a"), **_zero_layer("b")}
    sd["b.weight_scale"] = torch.ones(128, 8).to(torch.float8_e4m3fn)
    reservations: list[int] = []

    with pytest.raises(ValueError, match="nvfp4 layer 'b': .* does not describe"):
        dequantize_nvfp4_layers(sd, torch.float32, reserve=reservations.append)
    assert sd["a.weight"].dtype is torch.uint8
    assert reservations == []


@pytest.mark.parametrize(
    ("tensors", "marker", "message"),
    [
        ("dense", {"format": "nvfp4"}, "nvfp4 layer 'layer' has no weight_scale_2"),
        ("nvfp4", {"format": "float8_e4m3fn"}, "marked 'float8_e4m3fn'"),
    ],
)
def test_a_marker_that_contradicts_its_tensors_is_refused(tensors: str, marker: dict, message: str) -> None:
    sd = {"layer.weight": torch.zeros(128, 64)} if tensors == "dense" else _zero_layer("layer")
    sd["layer.comfy_quant"] = _marker_blob(marker)

    with pytest.raises(ValueError, match=message):
        dequantize_nvfp4_layers(sd, torch.float32)
