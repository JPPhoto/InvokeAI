"""Loader-level test for single-file Qwen3 encoders in Comfy's fp4_mixed layout.

Drives `Qwen3EncoderCheckpointLoader._load_from_singlefile` on a real, tiny safetensors file laid out like
`Comfy-Org/z_image`'s `qwen_3_4b_fp4_mixed`: nvfp4 projections named by `comfy_quant` markers -- or, as another
producer might write them, only in the `_quantization_metadata` header -- one scaled-fp8 projection, dense tensors
for the rest. What it pins is order inside the loader: room is reserved before the scaled-fp8 fold widens anything;
the nvfp4 layers leave the state dict before that fold, which would pair their block scales with the packed codes,
and come back only after the blanket cast, which would widen them; and an nvfp4 `lm_head` is dropped rather than
packed, since the loader ties `lm_head` to the embeddings. And that the returned model encodes exactly like a dense
Qwen3 holding the same weights.
"""

import json
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import MagicMock

import pytest
import torch
from safetensors.torch import save_file
from transformers import Qwen3Config, Qwen3ForCausalLM

from invokeai.backend.model_manager.configs.qwen3_encoder import Qwen3Encoder_Checkpoint_Config
from invokeai.backend.model_manager.load.model_loaders import z_image
from invokeai.backend.model_manager.load.model_loaders.z_image import Qwen3EncoderCheckpointLoader
from invokeai.backend.model_manager.taxonomy import Qwen3VariantType
from invokeai.backend.quantization.nvfp4 import NVFP4Linear

# Not a known Qwen3 size, so the loader reads the head counts off the projections at its fixed head_dim of 128:
# a one-head model.
HIDDEN = 128
INTERMEDIATE = 256
# A multiple of 128, so an nvfp4 `lm_head` over it is a valid block-scale grid.
VOCAB = 128

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


def _nvfp4_layer(path: str, positive: torch.Tensor, evidence: str) -> dict[str, torch.Tensor]:
    """Codes 2 and 10 are +1.0 and -1.0; with a block scale of 2 and a global scale of 0.25 the weight is +-0.5."""
    rows, columns = positive.shape
    codes = torch.where(positive, 2, 10).to(torch.uint8)
    layer = {
        f"{path}.weight": (codes[:, 0::2] << 4) | codes[:, 1::2],
        f"{path}.weight_scale": torch.full((rows, columns // 16), 2.0).to(torch.float8_e4m3fn),
        f"{path}.weight_scale_2": torch.tensor(0.25),
    }
    if evidence == "marker":
        layer[f"{path}.comfy_quant"] = _marker_blob({"format": "nvfp4"})
    return layer


def _write_checkpoint(tmp_path: Path, evidence: str) -> tuple[Path, dict[str, torch.Tensor]]:
    """Returns the file and the dense weights it has to load as."""
    torch.manual_seed(0)
    tensors: dict[str, torch.Tensor] = {}
    dense: dict[str, torch.Tensor] = {}
    nvfp4_paths = [f"model.layers.0.{name}" for name in NVFP4_PROJECTIONS] + ["lm_head"]
    for path, shape in zip(nvfp4_paths, [*NVFP4_PROJECTIONS.values(), (VOCAB, HIDDEN)], strict=True):
        positive = torch.randint(0, 2, shape, dtype=torch.bool)
        tensors.update(_nvfp4_layer(path, positive, evidence))
        if path != "lm_head":
            dense[f"{path}.weight"] = torch.where(positive, 0.5, -0.5)

    fp8_values = torch.randint(-8, 9, (HIDDEN, HIDDEN)).float()
    tensors["model.layers.0.self_attn.v_proj.weight"] = fp8_values.to(torch.float8_e4m3fn)
    tensors["model.layers.0.self_attn.v_proj.weight_scale"] = torch.tensor(0.5)
    tensors["model.layers.0.self_attn.v_proj.comfy_quant"] = _marker_blob({"format": "float8_e4m3fn"})
    dense["model.layers.0.self_attn.v_proj.weight"] = fp8_values * 0.5

    for key, tensor in {
        "model.embed_tokens.weight": torch.randn(VOCAB, HIDDEN),
        "model.layers.0.input_layernorm.weight": torch.rand(HIDDEN) + 0.5,
        "model.layers.0.post_attention_layernorm.weight": torch.rand(HIDDEN) + 0.5,
        "model.layers.0.self_attn.q_norm.weight": torch.rand(128) + 0.5,
        "model.layers.0.self_attn.k_norm.weight": torch.rand(128) + 0.5,
        "model.norm.weight": torch.rand(HIDDEN) + 0.5,
    }.items():
        tensors[key] = tensor
        dense[key] = tensor

    checkpoint = tmp_path / "qwen_3_4b_fp4_mixed.safetensors"
    header = {path: {"format": "nvfp4"} for path in nvfp4_paths}
    metadata = {"_quantization_metadata": json.dumps({"layers": header})} if evidence == "header" else None
    save_file(tensors, checkpoint, metadata=metadata)
    return checkpoint, dense


def _dense_reference(dense: dict[str, torch.Tensor]) -> Qwen3ForCausalLM:
    """The same encoder as a plain Qwen3 holding the decoded weights, configured the way the loader does it."""
    config = Qwen3Config(
        vocab_size=VOCAB,
        hidden_size=HIDDEN,
        intermediate_size=INTERMEDIATE,
        num_hidden_layers=1,
        num_attention_heads=1,
        num_key_value_heads=1,
        head_dim=128,
        max_position_embeddings=40960,
        rms_norm_eps=1e-6,
        tie_word_embeddings=True,
        rope_theta=1000000.0,
        use_sliding_window=False,
        attention_bias=False,
        attention_dropout=0.0,
    )
    model = Qwen3ForCausalLM(config)
    model.load_state_dict(dense, strict=False)
    model.tie_weights()
    return model.eval()


@pytest.mark.parametrize("evidence", ["marker", "header"])
def test_an_fp4_mixed_encoder_loads_packed_and_encodes_like_its_dense_weights(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path, evidence: str
) -> None:
    checkpoint, dense = _write_checkpoint(tmp_path, evidence)
    monkeypatch.setattr(z_image.TorchDevice, "choose_torch_device", lambda: torch.device("cpu"))
    monkeypatch.setattr(z_image.TorchDevice, "choose_bfloat16_safe_dtype", lambda _device: torch.float32)
    loader = object.__new__(Qwen3EncoderCheckpointLoader)
    loader._ram_cache = SimpleNamespace(make_room=MagicMock())
    reserved_before_fold: list[bool] = []
    fold = z_image._fold_comfy_scaled_weights

    def recording_fold(sd: dict, dtype: torch.dtype) -> int:
        reserved_before_fold.append(loader._ram_cache.make_room.called)
        return fold(sd, dtype)

    monkeypatch.setattr(z_image, "_fold_comfy_scaled_weights", recording_fold)
    config = Qwen3Encoder_Checkpoint_Config.model_construct(path=str(checkpoint), variant=Qwen3VariantType.Qwen3_4B)

    model = loader._load_from_singlefile(config)

    layer = model.model.layers[0]
    for name in NVFP4_PROJECTIONS:
        module = layer.get_submodule(name)
        assert isinstance(module, NVFP4Linear), name
        # Still as stored: installed before the cast, the buffers would be widened.
        assert module.weight.dtype is torch.uint8 and module.weight_scale.dtype is torch.uint8, name
    assert type(layer.self_attn.v_proj) is torch.nn.Linear
    assert type(model.lm_head) is torch.nn.Linear
    assert model.lm_head.weight is model.model.embed_tokens.weight
    assert reserved_before_fold == [True]

    input_ids = torch.tensor([[1, 5, 7, 2, 30]])
    with torch.no_grad():
        encoded = model(input_ids=input_ids, output_hidden_states=True).hidden_states[-1]
        expected = _dense_reference(dense)(input_ids=input_ids, output_hidden_states=True).hidden_states[-1]
    assert torch.equal(encoded, expected)

    # One reservation: the rest of the state dict at float32 plus the packed projections as stored. The dropped
    # `lm_head` costs nothing, and the packed layers are not charged their decoded size.
    packed_paths = {f"model.layers.0.{name}.weight" for name in NVFP4_PROJECTIONS}
    rest = sum(tensor.nelement() * 4 for key, tensor in dense.items() if key not in packed_paths)
    packed = sum(rows * columns // 2 + rows * columns // 16 + 4 for rows, columns in NVFP4_PROJECTIONS.values())
    loader._ram_cache.make_room.assert_called_once()
    (reserved,), _ = loader._ram_cache.make_room.call_args
    assert rest + packed <= reserved < rest + packed + 1024
