"""Loader-level tests for the Mistral encoder's single-file path.

These drive `_load_text_encoder` on a real, tiny safetensors file, because what they pin is order
inside the loader: nvfp4 layers have to be decoded before either scaled-fp8 branch reads the side
channel, with room reserved for the result first. Without the decode both branches hand a packed
weight to `load_state_dict`. With it only in the dequantizing branch, the branch that keeps fp8 pops the
block scales first and loads the packed weight anyway -- which is why both branches are exercised.
"""

import json
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import MagicMock

import pytest
import torch
from safetensors.torch import save_file

from invokeai.backend.model_manager.configs.mistral_encoder import MistralEncoder_Checkpoint_Config
from invokeai.backend.model_manager.load.model_loaders import mistral_encoder
from invokeai.backend.model_manager.load.model_loaders.mistral_encoder import MistralEncoderCheckpointLoader
from invokeai.backend.model_manager.taxonomy import MistralVariantType

# The loader derives the head count as `q_proj` rows // 128, so this is a one-head model.
HIDDEN = 128
INTERMEDIATE = 256
VOCAB = 32

NVFP4_PROJECTIONS = {
    "self_attn.q_proj": (HIDDEN, HIDDEN),
    "self_attn.k_proj": (HIDDEN, HIDDEN),
    "self_attn.o_proj": (HIDDEN, HIDDEN),
    "mlp.gate_proj": (INTERMEDIATE, HIDDEN),
    "mlp.up_proj": (INTERMEDIATE, HIDDEN),
    "mlp.down_proj": (HIDDEN, INTERMEDIATE),
}


def _marker_blob(marker: dict) -> torch.Tensor:
    return torch.frombuffer(bytearray(json.dumps(marker).encode("utf-8")), dtype=torch.uint8)


def _write_checkpoint(tmp_path: Path, evidence: str) -> tuple[Path, dict[str, torch.Tensor], torch.Tensor]:
    """A Comfy-style fp4_mixed Mistral: nvfp4 projections, one scaled-fp8 projection, bf16 for the rest.

    The nvfp4 layers are named by per-tensor markers, as in Comfy-Org's build, or -- with `evidence="header"` --
    only in the `_quantization_metadata` header, with every key under the `language_model.` wrapper prefix some
    redistributions add. The loader strips that prefix from the keys and has to strip it from the header's
    names as well, or it refuses the layers as unnamed.

    Returns the file, the weights the nvfp4 projections must load as, and the fp8 projection's
    dequantized weight. Codes 2 and 10 decode to +1.0 and -1.0, so no E2M1 table is needed here.
    """
    torch.manual_seed(0)
    prefix = "language_model." if evidence == "header" else ""
    tensors: dict[str, torch.Tensor] = {}
    expected: dict[str, torch.Tensor] = {}
    header: dict[str, dict[str, str]] = {}
    for name, shape in NVFP4_PROJECTIONS.items():
        positive = torch.randint(0, 2, shape, dtype=torch.bool)
        codes = torch.where(positive, 2, 10).to(torch.uint8)
        path = f"{prefix}model.layers.0.{name}"
        tensors[f"{path}.weight"] = (codes[:, 0::2] << 4) | codes[:, 1::2]
        tensors[f"{path}.weight_scale"] = torch.full((shape[0], shape[1] // 16), 2.0).to(torch.float8_e4m3fn)
        tensors[f"{path}.weight_scale_2"] = torch.tensor(0.25)
        if evidence == "header":
            header[path] = {"format": "nvfp4"}
        else:
            tensors[f"{path}.comfy_quant"] = _marker_blob({"format": "nvfp4"})
        expected[f"layers.0.{name}.weight"] = torch.where(positive, 0.5, -0.5)

    fp8_values = torch.randint(-8, 9, (HIDDEN, HIDDEN)).float()
    tensors[f"{prefix}model.layers.0.self_attn.v_proj.weight"] = fp8_values.to(torch.float8_e4m3fn)
    tensors[f"{prefix}model.layers.0.self_attn.v_proj.weight_scale"] = torch.tensor(0.5)
    tensors[f"{prefix}model.layers.0.self_attn.v_proj.comfy_quant"] = _marker_blob({"format": "float8_e4m3fn"})

    tensors[f"{prefix}model.embed_tokens.weight"] = torch.randn(VOCAB, HIDDEN)
    for norm in ("model.layers.0.input_layernorm", "model.layers.0.post_attention_layernorm", "model.norm"):
        tensors[f"{prefix}{norm}.weight"] = torch.ones(HIDDEN)
    tensors["tekken_model"] = torch.randint(0, 256, (64,), dtype=torch.uint8)

    checkpoint = tmp_path / "mistral_3_small_flux2_fp4_mixed.safetensors"
    metadata = {"_quantization_metadata": json.dumps({"layers": header})} if header else None
    save_file(tensors, checkpoint, metadata=metadata)
    return checkpoint, expected, fp8_values * 0.5


def _loader(monkeypatch: pytest.MonkeyPatch, keep_fp8: bool) -> MistralEncoderCheckpointLoader:
    monkeypatch.setattr(mistral_encoder.TorchDevice, "choose_torch_device", lambda: torch.device("cpu"))
    monkeypatch.setattr(mistral_encoder.TorchDevice, "choose_bfloat16_safe_dtype", lambda _device: torch.float32)
    monkeypatch.setattr(mistral_encoder, "should_keep_fp8_weights", lambda _device: keep_fp8)
    loader = object.__new__(MistralEncoderCheckpointLoader)
    loader._ram_cache = SimpleNamespace(make_room=MagicMock())
    return loader


@pytest.mark.parametrize(
    ("keep_fp8", "evidence"),
    [(False, "marker"), (True, "marker"), (False, "header")],
    ids=["fp8_dequantized", "fp8_kept", "named_in_prefixed_header"],
)
def test_an_nvfp4_mixed_checkpoint_loads_under_either_fp8_branch(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path, keep_fp8: bool, evidence: str
) -> None:
    checkpoint, expected, fp8_dequantized = _write_checkpoint(tmp_path, evidence)
    loader = _loader(monkeypatch, keep_fp8)
    config = MistralEncoder_Checkpoint_Config.model_construct(path=str(checkpoint), variant=MistralVariantType.Cow)

    model = loader._load_text_encoder(config)

    for name, weight in expected.items():
        assert torch.equal(model.get_parameter(name), weight), name
    v_proj = model.layers[0].self_attn.v_proj
    if keep_fp8:
        assert v_proj.weight.dtype is torch.float8_e4m3fn
        assert torch.equal(v_proj.weight.float() * v_proj.weight_scale, fp8_dequantized)
    else:
        assert torch.equal(v_proj.weight, fp8_dequantized)
    # The base loader reserved only the file size; the decode has to ask for its float32 result.
    (reserved,), _ = loader._ram_cache.make_room.call_args
    assert loader._ram_cache.make_room.call_count == 1
    assert reserved >= sum(rows * columns * 4 for rows, columns in NVFP4_PROJECTIONS.values())
