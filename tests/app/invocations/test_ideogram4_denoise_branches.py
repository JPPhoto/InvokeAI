"""How `Ideogram4DenoiseInvocation` resolves its two transformer branches.

Ideogram 4 guides one branch against the other and runs both at every step. A diffusers pipeline
delivers them as one cache entity; Comfy-Org's single files are two models, and both must be locked
for the whole loop -- releasing one between steps would make the cache stream it back for the next.
The mismatches are rejected rather than tolerated: either one would otherwise surface deep in the
loop, as a missing attribute or as a branch guiding against itself.
"""

from contextlib import ExitStack, contextmanager
from types import SimpleNamespace

import pytest
import torch

from invokeai.app.invocations.fields import Ideogram4ConditioningField
from invokeai.app.invocations.ideogram4.ideogram4_denoise import Ideogram4DenoiseInvocation
from invokeai.app.invocations.model import ModelIdentifierField, TransformerField
from invokeai.backend.ideogram4.modeling_ideogram4 import Ideogram4Config, Ideogram4Transformer
from invokeai.backend.ideogram4.transformer_pair import Ideogram4TransformerPair
from invokeai.backend.model_manager.taxonomy import BaseModelType, ModelType
from invokeai.backend.quantization.int8_convrot import Int8ConvrotLinear
from invokeai.backend.stable_diffusion.diffusion.conditioning_data import (
    ConditioningFieldData,
    Ideogram4ConditioningInfo,
)

TINY = Ideogram4Config(
    emb_dim=64,
    num_layers=1,
    num_heads=2,
    intermediate_size=128,
    adanln_dim=16,
    in_channels=8,
    llm_features_dim=32,
    mrope_section=(4, 2, 2),
)


def _field(key: str) -> TransformerField:
    return TransformerField(
        transformer=ModelIdentifierField(
            key=key, hash=f"hash-{key}", name=key, base=BaseModelType.Ideogram4, type=ModelType.Main
        ),
        loras=[],
    )


class _LoadedModel:
    """The slice of `LoadedModel` this method uses, plus a record of how it was entered and left.

    `model` is the real attribute name: the node reads it before locking, to see whether the branch
    is an int8 build whose per-forward dequantization needs headroom of its own.
    """

    def __init__(self, model: torch.nn.Module, calls: list[tuple[str, int]], released: list[str], key: str) -> None:
        self.model = model
        self._model = model
        self._calls = calls
        self._released = released
        self._key = key

    @contextmanager
    def model_on_device(self, working_mem_bytes: int = 0):
        self._calls.append((self._key, working_mem_bytes))
        try:
            yield (None, self._model)
        finally:
            self._released.append(self._key)


def _context(
    models: dict[str, torch.nn.Module],
    released: list[str],
    calls: list[tuple[str, int]] | None = None,
    loaded: list[str] | None = None,
) -> SimpleNamespace:
    """`calls` records the *locks* and their reservations; `loaded` records the RAM-level loads.

    They are separate because the node's ordering distinguishes them: it reads both branches before
    locking either, and refuses a mis-wired graph before reading the second.
    """
    recorded = calls if calls is not None else []
    reads = loaded if loaded is not None else []

    def load(identifier: ModelIdentifierField) -> _LoadedModel:
        reads.append(identifier.key)
        return _LoadedModel(models[identifier.key], recorded, released, identifier.key)

    return SimpleNamespace(models=SimpleNamespace(load=load))


def _invocation(**fields) -> Ideogram4DenoiseInvocation:
    return Ideogram4DenoiseInvocation.model_construct(unconditional_transformer=None, **fields)


def test_a_bundled_pair_supplies_both_branches_from_one_model() -> None:
    pair = Ideogram4TransformerPair(conditional=Ideogram4Transformer(TINY), unconditional=Ideogram4Transformer(TINY))
    released: list[str] = []
    invocation = _invocation(transformer=_field("pipeline"))

    with ExitStack() as stack:
        conditional, unconditional = invocation._load_branches(_context({"pipeline": pair}, released), stack, 0)

        assert conditional is pair.conditional
        assert unconditional is pair.unconditional
        assert released == []

    assert released == ["pipeline"]


def test_two_single_files_are_both_held_for_the_whole_loop() -> None:
    models = {"cond": Ideogram4Transformer(TINY), "uncond": Ideogram4Transformer(TINY)}
    released: list[str] = []
    invocation = _invocation(transformer=_field("cond"))
    invocation.unconditional_transformer = _field("uncond")

    loaded: list[str] = []
    calls: list[tuple[str, int]] = []
    with ExitStack() as stack:
        conditional, unconditional = invocation._load_branches(_context(models, released, calls, loaded), stack, 0)

        assert conditional is models["cond"]
        assert unconditional is models["uncond"]
        # Neither is handed back while the other is still being loaded.
        assert released == []

    assert sorted(released) == ["cond", "uncond"]
    # Both branches are read before either is locked, which is what lets the reservation below be
    # the maximum of the two rather than each branch's own.
    assert loaded == ["cond", "uncond"]
    assert [key for key, _ in calls] == ["cond", "uncond"]


def test_a_lone_single_file_is_refused() -> None:
    # Without this the loop would ask a bare transformer for `.conditional` and die on an
    # AttributeError with no hint about what the user should have connected.
    released: list[str] = []
    invocation = _invocation(transformer=_field("cond"))

    with pytest.raises(ValueError, match="only one branch"), ExitStack() as stack:
        invocation._load_branches(_context({"cond": Ideogram4Transformer(TINY)}, released), stack, 0)


def test_a_bundled_pair_with_a_second_branch_connected_is_refused() -> None:
    pair = Ideogram4TransformerPair(conditional=Ideogram4Transformer(TINY), unconditional=Ideogram4Transformer(TINY))
    released: list[str] = []
    invocation = _invocation(transformer=_field("pipeline"))
    invocation.unconditional_transformer = _field("uncond")

    loaded: list[str] = []
    with pytest.raises(ValueError, match="already carries both"), ExitStack() as stack:
        invocation._load_branches(
            _context({"pipeline": pair, "uncond": Ideogram4Transformer(TINY)}, released, loaded=loaded), stack, 0
        )

    # The refusal comes before the second branch is read: a mis-wired graph costs an error, not a
    # ~9 GiB load of a model the node is about to reject. The node reads both branches before it
    # locks either, so this is the ordering that has to be pinned, not the locking.
    assert loaded == ["pipeline"]


def _int8_branch() -> Ideogram4Transformer:
    """A tiny branch whose largest linear is stored int8, as the `int8_convrot` build's are.

    In bfloat16 because that is what the loader produces, and the transient is two weight-sized
    tensors *in the compute dtype* -- a float32 model would quietly double the expected number.
    """
    model = Ideogram4Transformer(TINY).to(torch.bfloat16)
    linear = model.layers[0].feed_forward.w1
    model.layers[0].feed_forward.w1 = Int8ConvrotLinear(
        weight=torch.zeros(linear.out_features, linear.in_features, dtype=torch.int8),
        weight_scale=torch.ones(linear.out_features, 1),
        convrot=False,
    )
    return model


def test_an_int8_branch_adds_its_dequantization_headroom() -> None:
    """`Int8ConvrotLinear` materializes the dequantized weight inside `forward`.

    That peak is not part of the model's resident size, so it has to be reserved — and it is
    measured from the model, since a bf16 or fp8 branch needs none of it.
    """
    dense = Ideogram4Transformer(TINY).to(torch.bfloat16)
    int8 = _int8_branch()
    largest = int8.layers[0].feed_forward.w1

    assert Ideogram4DenoiseInvocation._dequant_transient(dense) == 0
    assert Ideogram4DenoiseInvocation._dequant_transient(int8) == (
        2 * largest.in_features * largest.out_features * torch.bfloat16.itemsize
    )


@pytest.mark.parametrize("int8_branch", ["cond", "uncond"])
def test_a_mixed_pair_reserves_for_the_hungrier_branch(int8_branch: str) -> None:
    """The cache keeps the *last* lock's reservation, not the sum.

    Free VRAM is recomputed as `capacity - working_mem - in_use` at every lock, so a branch that
    reserves less hands back exactly the headroom the other one still needs. Both orders are pinned
    because both occur: the loader node allows an int8 branch guided against an fp8 one in either
    slot, and reserving only for the first branch would leave one of the two orders green.
    """
    models = {"cond": Ideogram4Transformer(TINY).to(torch.bfloat16), "uncond": Ideogram4Transformer(TINY)}
    models[int8_branch] = _int8_branch()
    calls: list[tuple[str, int]] = []
    invocation = _invocation(transformer=_field("cond"))
    invocation.unconditional_transformer = _field("uncond")
    transient = Ideogram4DenoiseInvocation._dequant_transient(models[int8_branch])
    assert transient > 0

    with ExitStack() as stack:
        invocation._load_branches(_context(models, [], calls), stack, 4 * 1024**3)

    assert calls == [("cond", 4 * 1024**3 + transient), ("uncond", 4 * 1024**3 + transient)]


def test_both_branches_reserve_the_same_activation_headroom() -> None:
    """A reservation given to only the first branch is spent by the second.

    The cache decides per model how much of it fits in what is left, so the second `model_on_device`
    would fill the headroom the first one set aside — which is how the pair ended up occupying every
    byte of a 24 GB card and copying weights instead of computing.
    """
    models = {"cond": Ideogram4Transformer(TINY), "uncond": Ideogram4Transformer(TINY)}
    calls: list[tuple[str, int]] = []
    invocation = _invocation(transformer=_field("cond"))
    invocation.unconditional_transformer = _field("uncond")

    with ExitStack() as stack:
        invocation._load_branches(_context(models, [], calls), stack, 4 * 1024**3)

    assert calls == [("cond", 4 * 1024**3), ("uncond", 4 * 1024**3)]


def test_the_headroom_estimate_grows_with_the_image() -> None:
    """It is an estimate, so what is pinned is the shape: it scales with the token count and is
    never zero. A flat value would under-reserve at 2048px and over-reserve at 512px."""
    small = _invocation(transformer=_field("cond"))
    small.width, small.height = 512, 512
    large = _invocation(transformer=_field("cond"))
    large.width, large.height = 2048, 2048

    assert small._estimate_working_memory(64) > 1024**3
    # Sixteen times the image tokens, so the token-proportional part must dominate the fixed base.
    assert large._estimate_working_memory(64) > 4 * small._estimate_working_memory(64)


TEXT_TOKENS = 7


class _StopAfterLoad(Exception):
    """Ends `invoke` where this test's interest ends."""


def test_invoke_passes_its_own_estimate_into_the_load(monkeypatch) -> None:
    """The wiring, not the estimate.

    Every other test here drives `_load_branches` directly, so a call in `invoke` that forgot the
    argument -- or passed a constant -- would leave them all green while the cache went back to
    filling VRAM with weights and leaving none for the activations.
    """
    reserved: list[int] = []
    invocation = _invocation(
        transformer=_field("cond"),
        positive_conditioning=Ideogram4ConditioningField(conditioning_name="cond-1"),
        sampler_preset="V4_TURBO_12",
        steps=None,
        guidance_scale=None,
        mu=None,
        width=1024,
        height=1024,
        seed=0,
    )

    def load_branches(_context, _stack, working_mem_bytes: int):
        reserved.append(working_mem_bytes)
        raise _StopAfterLoad

    monkeypatch.setattr(invocation, "_load_branches", load_branches)

    conditioning = ConditioningFieldData(
        conditionings=[Ideogram4ConditioningInfo(prompt_embeds=torch.zeros(TEXT_TOKENS, 32))]
    )
    context = SimpleNamespace(
        conditioning=SimpleNamespace(load=lambda _name: conditioning),
        util=SimpleNamespace(signal_progress=lambda *_args, **_kwargs: None),
    )

    with pytest.raises(_StopAfterLoad):
        invocation.invoke(context)

    assert reserved == [invocation._estimate_working_memory(TEXT_TOKENS)]
