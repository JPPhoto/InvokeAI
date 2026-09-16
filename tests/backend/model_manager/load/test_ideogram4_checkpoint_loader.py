"""Loader-level tests for the single-file Ideogram 4 path.

These drive `Ideogram4CheckpointModel._load_model` and assert the *end state* of the module, not
the decisions that produced it: what a scaled-fp8 checkpoint leaves resident, which layers keep
their codes, and which two must not -- `Ideogram4Transformer.forward` and
`Ideogram4EmbedScalar.forward` derive the dtype they cast their inputs to from `input_proj` and
`t_embedding`, so an fp8 weight on either turns every activation into float8.

A tiny `Ideogram4Config` stands in for the released geometry: same module tree, 29 tensors instead
of 458.
"""

from types import SimpleNamespace
from unittest.mock import MagicMock

import pytest
import torch

from invokeai.backend.ideogram4.modeling_ideogram4 import Ideogram4Config, Ideogram4Transformer
from invokeai.backend.model_manager.configs.main import Main_Checkpoint_Ideogram4_Config
from invokeai.backend.model_manager.load.model_loaders.ideogram4 import Ideogram4CheckpointModel
from invokeai.backend.model_manager.taxonomy import SubModelType

FP8 = torch.float8_e4m3fn

TINY_CONFIG = Ideogram4Config(
    emb_dim=64,
    num_layers=1,
    num_heads=2,
    intermediate_size=128,
    adanln_dim=16,
    in_channels=8,
    llm_features_dim=32,
    mrope_section=(4, 2, 2),
)

# One Linear the cast must keep quantized, and the two it must not.
KEPT = "layers.0.feed_forward.w1"
SKIPPED = ("input_proj", "t_embedding.mlp_in")


def _quantize_scaled_fp8(weight: torch.Tensor) -> tuple[torch.Tensor, torch.Tensor]:
    """ComfyUI 'scaled fp8': one scale per tensor, folded back in by `dequantize_fp8_scaled`."""
    scale = weight.abs().max() / 448.0
    return (weight / scale).to(FP8), scale.to(torch.float32)


def _checkpoint(paths: tuple[str, ...]) -> tuple[dict[str, torch.Tensor], dict[str, torch.Tensor]]:
    """A full state dict for the tiny geometry, with `paths` stored as scaled fp8.

    Returns the checkpoint and the float originals of the quantized layers, so a test can compare
    what the loader produced against what the file meant.
    """
    torch.manual_seed(0)
    reference = Ideogram4Transformer(TINY_CONFIG)
    state_dict = {key: value.clone().to(torch.float32) for key, value in reference.state_dict().items()}

    originals: dict[str, torch.Tensor] = {}
    for path in paths:
        key = f"{path}.weight"
        originals[key] = state_dict[key].clone()
        state_dict[key], state_dict[f"{path}.weight_scale"] = _quantize_scaled_fp8(state_dict[key])

    return state_dict, originals


def _driver(monkeypatch, tmp_path, state_dict: dict, *, keep_fp8: bool, trace: dict | None = None):
    """Drive the loader with the cache and the fp8 storage pass recorded rather than stubbed out.

    `trace` collects what the loader *did*: `casting_calls` counts entries into
    `_apply_fp8_layerwise_casting`, and `weights_at_make_room` snapshots the state dict's dtypes at
    the moment room is reserved. Both are invariants the module documents in prose and both are
    invisible to an end-state assertion.
    """
    import invokeai.backend.model_manager.load.model_loaders.ideogram4 as module

    recorded = trace if trace is not None else {}
    recorded.setdefault("casting_calls", 0)
    recorded.setdefault("fp8_weights_at_make_room", None)

    checkpoint = tmp_path / "ideogram4_fp8_scaled.safetensors"
    checkpoint.touch()
    config = Main_Checkpoint_Ideogram4_Config.model_construct(
        path=str(checkpoint), name="ideogram4", branch="conditional"
    )

    def make_room(_bytes: int) -> None:
        recorded["fp8_weights_at_make_room"] = sum(1 for v in state_dict.values() if v.dtype is FP8)

    def apply_casting(model, _config, _submodel):
        recorded["casting_calls"] += 1
        return model

    loader = object.__new__(Ideogram4CheckpointModel)
    loader._ram_cache = SimpleNamespace(make_room=make_room)
    loader._logger = MagicMock()
    loader._torch_device = torch.device("cpu")
    loader._torch_dtype = torch.float32
    loader._apply_fp8_layerwise_casting = apply_casting

    monkeypatch.setattr(module, "load_file", lambda _path: state_dict)
    monkeypatch.setattr(module, "should_keep_fp8_weights", lambda _device: keep_fp8)
    monkeypatch.setattr(module, "read_safetensors_metadata", lambda _path, _logger: None)
    monkeypatch.setattr(module.TorchDevice, "choose_torch_device", staticmethod(lambda: torch.device("cpu")))
    monkeypatch.setattr(module.TorchDevice, "choose_bfloat16_safe_dtype", staticmethod(lambda _device: torch.float32))
    monkeypatch.setattr(
        "invokeai.backend.ideogram4.modeling_ideogram4.Ideogram4Config", lambda: TINY_CONFIG, raising=True
    )
    return loader, config


def _load(monkeypatch, tmp_path, state_dict, *, keep_fp8: bool, trace: dict | None = None) -> torch.nn.Module:
    loader, config = _driver(monkeypatch, tmp_path, state_dict, keep_fp8=keep_fp8, trace=trace)
    return loader._load_model(config, SubModelType.Transformer)


def test_without_the_fp8_matmul_the_scales_are_folded_into_full_precision_weights(monkeypatch, tmp_path) -> None:
    state_dict, originals = _checkpoint((KEPT, *SKIPPED))

    model = _load(monkeypatch, tmp_path, state_dict, keep_fp8=False)

    for key, original in originals.items():
        weight = model.get_parameter(key)
        assert weight.dtype is torch.float32
        # fp8 has ~2 decimal digits, so this is a "the scale was applied" check, not a bit compare:
        # a dropped scale would be off by 1/scale, which is orders of magnitude.
        assert torch.allclose(weight, original, rtol=0.1, atol=0.02)
    assert not any(hasattr(module, "weight_scale") for module in model.modules())


def test_with_the_fp8_matmul_the_codes_stay_and_the_scales_are_attached(monkeypatch, tmp_path) -> None:
    state_dict, _ = _checkpoint((KEPT,))
    trace: dict = {}

    model = _load(monkeypatch, tmp_path, state_dict, keep_fp8=True, trace=trace)

    kept = model.get_submodule(KEPT)
    assert kept.weight.dtype is FP8
    assert kept.weight_scale.shape == ()
    # Non-persistent: a re-save that carried it would scale the weight twice.
    assert "weight_scale" not in kept.state_dict()
    # And the layerwise storage pass must not have run: its hooks restore the compute dtype without
    # applying `weight_scale` (a silently wrong weight) and disable the matmul this path exists for.
    assert trace["casting_calls"] == 0


def test_room_is_reserved_before_the_scales_are_folded(monkeypatch, tmp_path) -> None:
    # `split_fp8_scaled_layers` dequantizes what it cannot keep through float32, so a reservation
    # made afterwards lets that transient peak land on an unreserved cache. Reserving first is
    # invisible in the loaded model, so it is asserted where it happens.
    state_dict, _ = _checkpoint((KEPT, *SKIPPED))
    trace: dict = {}

    _load(monkeypatch, tmp_path, state_dict, keep_fp8=True, trace=trace)

    assert trace["fp8_weights_at_make_room"] == 3, "the fold ran before the cache was asked for room"


@pytest.mark.parametrize("path", SKIPPED)
def test_the_two_dtype_deriving_layers_never_stay_quantized(monkeypatch, tmp_path, path: str) -> None:
    # The regression this guards: both forwards read `<layer>.weight.dtype` (or its `compute_dtype`)
    # and cast x, t and the conditioning to it. With an fp8 weight there, the first matmul dies with
    # "addmm_cpu" not implemented for 'Float8_e4m3fn' -- and on a device where it does not die, it
    # computes in a dtype the model never intended.
    state_dict, originals = _checkpoint((KEPT, path))

    model = _load(monkeypatch, tmp_path, state_dict, keep_fp8=True)

    skipped = model.get_submodule(path)
    assert skipped.weight.dtype is torch.float32
    assert getattr(skipped, "weight_scale", None) is None
    assert torch.allclose(skipped.weight, originals[f"{path}.weight"], rtol=0.1, atol=0.02)
    # The layer that is allowed to stay fp8 still did.
    assert model.get_submodule(KEPT).weight.dtype is FP8


def test_a_plain_checkpoint_loads_verbatim_and_is_offered_to_the_storage_pass(monkeypatch, tmp_path) -> None:
    state_dict, _ = _checkpoint(())
    expected = {key: value.clone() for key, value in state_dict.items()}
    trace: dict = {}

    model = _load(monkeypatch, tmp_path, state_dict, keep_fp8=False, trace=trace)

    for key, value in expected.items():
        assert torch.equal(model.get_parameter(key), value), key
    # Nothing here is fp8, so the model's own FP8 Storage setting is the only thing that could make
    # it so -- this is the one path that must reach `_apply_fp8_layerwise_casting`.
    assert trace["casting_calls"] == 1


def test_only_the_transformer_submodel_is_served(monkeypatch, tmp_path) -> None:
    # A single file has no encoder, tokenizer or VAE in it; those are selected on the loader node.
    state_dict, _ = _checkpoint(())
    loader, config = _driver(monkeypatch, tmp_path, state_dict, keep_fp8=False)

    with pytest.raises(ValueError, match="holds only a transformer"):
        loader._load_model(config, SubModelType.VAE)
