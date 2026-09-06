from typing import ClassVar
from unittest.mock import MagicMock

import pytest
from pydantic import ValidationError

from invokeai.app.invocations.baseinvocation import (
    BaseInvocation,
    BaseInvocationOutput,
    invocation,
    invocation_output,
)
from invokeai.app.invocations.fields import InputField, OutputField
from invokeai.app.services.shared.execution_effects import (
    AddEdgeEffect,
    ExecutionEffectsRecorder,
    ExecutionRef,
    ExecutionToken,
    SetValueEffect,
)
from invokeai.app.services.shared.invocation_context import InvocationContext


@invocation_output("execution_effects_test_output")
class ExecutionEffectsTestOutput(BaseInvocationOutput):
    value: int = OutputField()


@invocation("execution_effects_test", version="1.0.0")
class ExecutionEffectsTestInvocation(BaseInvocation):
    value: int = InputField(default=1)
    calls: ClassVar[int] = 0

    def invoke(self, context: InvocationContext) -> ExecutionEffectsTestOutput:
        type(self).calls += 1
        context.effects.record(
            SetValueEffect(
                target=ExecutionRef(node_id=self.id, field="value"),
                value=self.value,
            )
        )
        return ExecutionEffectsTestOutput(value=self.value)


def _context() -> InvocationContext:
    context = object.__new__(InvocationContext)
    context.execution_effects = ExecutionEffectsRecorder()
    context.effects = context.execution_effects
    return context


def _services(cache_size: int = 1) -> MagicMock:
    services = MagicMock()
    services.configuration.node_cache_size = cache_size
    return services


def test_execution_token_and_ref_are_frame_aware() -> None:
    token = ExecutionToken(invocation_id="node", port="value", iteration_path=(2, 4))
    ref = ExecutionRef(token=token, scope="iteration")

    assert token.node_id == "node"
    assert token.field == "value"
    assert token.frame == (2, 4)
    assert ref.invocation_id == "node"
    assert ref.iteration_path == (2, 4)


@pytest.mark.parametrize(
    "value",
    [
        {"node_id": "", "field": "value"},
        {"node_id": "node", "field": ""},
        {"node_id": "node", "field": "value", "frame": (-1,)},
        {"node_id": "node", "field": "value", "frame": (1,), "iteration_path": (2,)},
    ],
)
def test_execution_token_rejects_malformed_identity(value: dict[str, object]) -> None:
    with pytest.raises(ValidationError):
        ExecutionToken.model_validate(value)


def test_effect_models_validate_typed_refs() -> None:
    source = ExecutionRef(node_id="source", field="value")
    destination = ExecutionRef(node_id="destination", field="input")

    effect = AddEdgeEffect(source=source, destination=destination)
    assert effect.kind == "add_edge"

    with pytest.raises(ValidationError):
        AddEdgeEffect(source=source, destination={"node_id": "destination"})


def test_recorder_rejects_untyped_values_and_returns_copy() -> None:
    recorder = ExecutionEffectsRecorder()
    effect = SetValueEffect(target=ExecutionRef(node_id="node", field="value"), value=3)

    recorder.record(effect)
    effects = recorder.snapshot()

    assert effects == (effect,)
    with pytest.raises(TypeError, match="Expected ExecutionEffect"):
        recorder.record("not an effect")  # type: ignore[arg-type]


def test_effectful_invoke_bypasses_output_only_cache() -> None:
    ExecutionEffectsTestInvocation.calls = 0
    services = _services()
    cached_output = ExecutionEffectsTestOutput(value=99)
    services.invocation_cache.get.return_value = cached_output
    invocation_instance = ExecutionEffectsTestInvocation(id="node", value=7, use_cache=True)

    ordinary_output = invocation_instance.invoke_internal(_context(), services)
    assert ordinary_output == cached_output
    assert ExecutionEffectsTestInvocation.calls == 0
    services.invocation_cache.get.assert_called_once()

    services.invocation_cache.reset_mock()
    result = invocation_instance.invoke_internal_with_effects(_context(), services)

    assert result.output == ExecutionEffectsTestOutput(value=7)
    assert len(result.effects) == 1
    assert result.effects[0].kind == "set_value"
    assert ExecutionEffectsTestInvocation.calls == 1
    services.invocation_cache.get.assert_not_called()
    services.invocation_cache.save.assert_not_called()


def test_effectful_invoke_clears_stale_effects() -> None:
    context = _context()
    context.effects.record(SetValueEffect(target=ExecutionRef(node_id="stale", field="value"), value=0))
    result = ExecutionEffectsTestInvocation(id="node", value=2).invoke_internal_with_effects(context, _services())

    assert [effect.value for effect in result.effects if isinstance(effect, SetValueEffect)] == [2]
