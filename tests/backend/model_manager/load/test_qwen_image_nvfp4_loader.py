"""Qwen-Image's single-file loaders keep Comfy's nvfp4 builds packed.

Both Comfy files mix nvfp4 with scaled fp8, and both loaders fold ComfyUI fp8 with `_dequantize_comfyui_fp8`, which
multiplies every `.weight_scale` into its weight -- nvfp4's block scales included. So what these tests pin is the order:
the nvfp4 layers leave the state dict before the fold, come back packed under the paths the model uses (the encoder's
legacy `model.X` keys become `model.language_model.X`), the fp8 layers are still folded, and one reservation is made
before the fold widens anything. The compute dtype is bf16, as in production: the packed global scale must not be cast.
"""

import json
from types import SimpleNamespace
from unittest.mock import MagicMock

import pytest
import torch

from invokeai.backend.model_manager.configs.main import Main_Checkpoint_QwenImage_Config
from invokeai.backend.model_manager.configs.qwen_vl_encoder import QwenVLEncoder_Checkpoint_Config
from invokeai.backend.model_manager.load.model_loaders import qwen_image
from invokeai.backend.model_manager.load.model_loaders.qwen_image import (
    QwenImageCheckpointModel,
    QwenVLEncoderCheckpointLoader,
)
from invokeai.backend.quantization.nvfp4 import NVFP4Linear

COMPUTE_DTYPE = torch.bfloat16


def _nvfp4_tensors(path: str, shape: tuple[int, int]) -> tuple[dict[str, torch.Tensor], torch.Tensor]:
    """Codes 2 and 10 are +1.0 and -1.0; with a block scale of 2 and a global scale of 0.25 the weight is +-0.5. Comfy
    ships an activation scale beside each layer, which the loader has no use for."""
    positive = torch.randint(0, 2, shape, dtype=torch.bool)
    codes = torch.where(positive, 2, 10).to(torch.uint8)
    tensors = {
        f"{path}.weight": (codes[:, 0::2] << 4) | codes[:, 1::2],
        f"{path}.weight_scale": torch.full((shape[0], shape[1] // 16), 2.0).to(torch.float8_e4m3fn),
        f"{path}.weight_scale_2": torch.tensor(0.25),
        f"{path}.input_scale": torch.tensor(1.0),
    }
    return tensors, torch.where(positive, 0.5, -0.5)


def _packed_bytes(rows: int, columns: int) -> int:
    return rows * columns // 2 + rows * (columns // 16) + 4


def _marker(fmt: str) -> torch.Tensor:
    return torch.frombuffer(bytearray(json.dumps({"format": fmt}).encode("utf-8")), dtype=torch.uint8).clone()


def _patch_common(monkeypatch: pytest.MonkeyPatch, state_dict: dict, metadata: dict) -> list[bool]:
    """Patch file access and devices; return a log of whether room had been made when the fp8 fold ran."""
    import safetensors.torch

    monkeypatch.setattr(safetensors.torch, "load_file", lambda _path: state_dict)
    monkeypatch.setattr(qwen_image, "read_safetensors_metadata", lambda _path, _logger: metadata)
    monkeypatch.setattr(qwen_image.TorchDevice, "choose_torch_device", lambda: torch.device("cpu"))
    monkeypatch.setattr(qwen_image.TorchDevice, "choose_bfloat16_safe_dtype", lambda _device: COMPUTE_DTYPE)
    return []


def _record_fold(monkeypatch: pytest.MonkeyPatch, loader, log: list[bool]) -> None:
    fold = qwen_image._dequantize_comfyui_fp8

    def recording_fold(*args, **kwargs):
        log.append(loader._ram_cache.make_room.called)
        return fold(*args, **kwargs)

    monkeypatch.setattr(qwen_image, "_dequantize_comfyui_fp8", recording_fold)


class _TinyQwenImageTransformer(torch.nn.Module):
    """The diffusers module names Comfy's Qwen-Image build uses, at toy width."""

    _skip_layerwise_casting_patterns = ["pos_embed", "norm"]

    def __init__(self, **_kwargs) -> None:
        super().__init__()
        block = torch.nn.Module()
        block.attn = torch.nn.Module()
        block.attn.to_q = torch.nn.Linear(64, 128)
        block.img_mlp = torch.nn.Module()
        block.img_mlp.net = torch.nn.ModuleList([torch.nn.Module()])
        block.img_mlp.net[0].proj = torch.nn.Linear(64, 256)
        block.txt_mlp = torch.nn.Module()
        block.txt_mlp.net = torch.nn.ModuleList([torch.nn.Identity(), torch.nn.Identity(), torch.nn.Linear(64, 128)])
        self.transformer_blocks = torch.nn.ModuleList([block])
        self.img_in = torch.nn.Linear(64, 128)


def test_the_transformer_keeps_header_named_nvfp4_layers_packed_beside_folded_fp8(
    monkeypatch: pytest.MonkeyPatch, tmp_path
) -> None:
    import diffusers

    torch.manual_seed(0)
    state_dict: dict[str, torch.Tensor] = {}
    expected: dict[str, torch.Tensor] = {}
    header: dict[str, dict[str, str]] = {}
    for path, shape in (
        ("transformer_blocks.0.attn.to_q", (128, 64)),
        ("transformer_blocks.0.img_mlp.net.0.proj", (256, 64)),
    ):
        tensors, weight = _nvfp4_tensors(path, shape)
        state_dict.update(tensors)
        state_dict[f"{path}.bias"] = torch.randn(shape[0])
        expected[path] = weight
        header[path] = {"format": "nvfp4"}
    fp8_values = torch.randint(-8, 9, (128, 64)).float()
    fp8 = "transformer_blocks.0.txt_mlp.net.2"
    state_dict[f"{fp8}.weight"] = fp8_values.to(torch.float8_e4m3fn)
    state_dict[f"{fp8}.weight_scale"] = torch.tensor(0.5)
    state_dict[f"{fp8}.input_scale"] = torch.tensor(1.0)
    state_dict[f"{fp8}.bias"] = torch.randn(128)
    header[fp8] = {"format": "float8_e4m3fn"}
    state_dict["img_in.weight"] = torch.randn(128, 64)
    state_dict["img_in.bias"] = torch.randn(128)

    log = _patch_common(monkeypatch, state_dict, {"_quantization_metadata": json.dumps({"layers": header})})
    monkeypatch.setattr(diffusers, "QwenImageTransformer2DModel", _TinyQwenImageTransformer, raising=False)
    checkpoint = tmp_path / "qwen_image_nvfp4.safetensors"
    checkpoint.touch()
    loader = object.__new__(QwenImageCheckpointModel)
    loader._ram_cache = SimpleNamespace(make_room=MagicMock())
    _record_fold(monkeypatch, loader, log)
    biases = {path: state_dict[f"{path}.bias"] for path in expected}

    model = loader._load_from_singlefile(Main_Checkpoint_QwenImage_Config.model_construct(path=str(checkpoint)))

    for path, weight in expected.items():
        module = model.get_submodule(path)
        assert isinstance(module, NVFP4Linear), path
        assert module.weight.dtype is torch.uint8, path
        assert module.weight_scale_2.dtype is torch.float32, path
        x = torch.randn(3, module.in_features, dtype=COMPUTE_DTYPE)
        expected_out = torch.nn.functional.linear(x, weight.to(COMPUTE_DTYPE), biases[path].to(COMPUTE_DTYPE))
        torch.testing.assert_close(module(x), expected_out)
    folded = model.transformer_blocks[0].txt_mlp.net[2]
    assert type(folded) is torch.nn.Linear
    assert torch.equal(folded.weight, (fp8_values * 0.5).to(COMPUTE_DTYPE))
    assert log == [True]

    # Counted by hand: the packed layers as stored; their biases, the folded fp8 weight and its bias, its two scale
    # scalars, and the dense input projection at bf16. The packed layers' scales are part of their stored size.
    packed = _packed_bytes(128, 64) + _packed_bytes(256, 64)
    widened = (128 + 256) + (128 * 64 + 128 + 2) + (128 * 64 + 128)
    loader._ram_cache.make_room.assert_called_once_with(packed + widened * COMPUTE_DTYPE.itemsize)


class _TinyQwenVL(torch.nn.Module):
    """transformers' `Qwen2_5_VLForConditionalGeneration` layout at toy width: the language model and the vision tower
    under `model.`, the LM head at the top."""

    _checkpoint_conversion_mapping: dict = {}

    def __init__(self, _config) -> None:
        super().__init__()
        layer = torch.nn.Module()
        layer.self_attn = torch.nn.Module()
        layer.self_attn.q_proj = torch.nn.Linear(64, 128)
        layer.mlp = torch.nn.Module()
        layer.mlp.down_proj = torch.nn.Linear(64, 128, bias=False)
        self.model = torch.nn.Module()
        self.model.language_model = torch.nn.Module()
        self.model.language_model.layers = torch.nn.ModuleList([layer])
        self.model.visual = torch.nn.Module()
        self.model.visual.proj = torch.nn.Linear(8, 4)
        self.lm_head = torch.nn.Linear(64, 32, bias=False)


def test_the_encoder_keeps_marker_named_nvfp4_layers_packed_under_their_transformers_paths(
    monkeypatch: pytest.MonkeyPatch, tmp_path
) -> None:
    import transformers

    torch.manual_seed(1)
    state_dict: dict[str, torch.Tensor] = {}
    expected: dict[str, torch.Tensor] = {}
    for legacy, shape in (("model.layers.0.self_attn.q_proj", (128, 64)), ("model.layers.0.mlp.down_proj", (128, 64))):
        tensors, weight = _nvfp4_tensors(legacy, shape)
        state_dict.update(tensors)
        state_dict[f"{legacy}.comfy_quant"] = _marker("nvfp4")
        expected[legacy.replace("model.", "model.language_model.", 1)] = weight
    state_dict["model.layers.0.self_attn.q_proj.bias"] = torch.randn(128)
    fp8_values = torch.randint(-8, 9, (32, 64)).float()
    fp8_marker = _marker("float8_e4m3fn")
    # The fp8_scaled encoder's own scale spelling, beside the marker the nvfp4 build adds.
    state_dict["lm_head.weight"] = fp8_values.to(torch.float8_e4m3fn)
    state_dict["lm_head.scale_weight"] = torch.tensor(0.5)
    state_dict["lm_head.scale_input"] = torch.tensor(1.0)
    state_dict["lm_head.comfy_quant"] = fp8_marker
    state_dict["visual.proj.weight"] = torch.randn(4, 8)
    state_dict["visual.proj.bias"] = torch.randn(4)

    log = _patch_common(monkeypatch, state_dict, {})
    monkeypatch.setattr(transformers, "Qwen2_5_VLForConditionalGeneration", _TinyQwenVL, raising=False)
    monkeypatch.setattr(
        transformers.AutoConfig,
        "from_pretrained",
        lambda *_args, **_kwargs: SimpleNamespace(torch_dtype=None, tie_word_embeddings=False),
    )
    checkpoint = tmp_path / "qwen_2.5_vl_7b_nvfp4.safetensors"
    checkpoint.touch()
    loader = object.__new__(QwenVLEncoderCheckpointLoader)
    loader._ram_cache = SimpleNamespace(make_room=MagicMock())
    _record_fold(monkeypatch, loader, log)
    q_bias = state_dict["model.layers.0.self_attn.q_proj.bias"]
    visual_weight = state_dict["visual.proj.weight"]

    model = loader._load_text_encoder_from_singlefile(
        QwenVLEncoder_Checkpoint_Config.model_construct(path=str(checkpoint))
    )

    for path, weight in expected.items():
        module = model.get_submodule(path)
        assert isinstance(module, NVFP4Linear), path
        assert module.weight_scale_2.dtype is torch.float32, path
        x = torch.randn(3, module.in_features, dtype=COMPUTE_DTYPE)
        bias = q_bias.to(COMPUTE_DTYPE) if module.bias is not None else None
        torch.testing.assert_close(module(x), torch.nn.functional.linear(x, weight.to(COMPUTE_DTYPE), bias))
    assert torch.equal(model.lm_head.weight, (fp8_values * 0.5).to(COMPUTE_DTYPE))
    assert torch.equal(model.model.visual.proj.weight, visual_weight.to(COMPUTE_DTYPE))
    assert log == [True]

    # Counted by hand: the packed layers as stored, the q_proj bias, the folded LM head with its two scale scalars and
    # the vision projection at bf16, and the LM head's 27-byte marker as stored.
    packed = 2 * _packed_bytes(128, 64)
    widened = 128 + (32 * 64 + 2) + (4 * 8 + 4)
    loader._ram_cache.make_room.assert_called_once_with(packed + widened * COMPUTE_DTYPE.itemsize + fp8_marker.numel())
