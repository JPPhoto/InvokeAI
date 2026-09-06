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
    AwaitEffect,
    ChildExecutionHandle,
    ExecutionEffectsRecorder,
    ExecutionInterface,
    ExecutionRef,
    ExecutionToken,
    FailEffect,
    SetValueEffect,
    SpawnExecutionEffect,
)
from invokeai.app.services.shared.invocation_context import InvocationContext


@invocation_output("execution_effects_test_output")
class ExecutionEffectsTestOutput(BaseInvocationOutput):
    value: int = OutputField()


@invocation("execution_effects_test", version="1.0.0")
class ExecutionEffectsTestInvocation(BaseInvocation):
    execution_effects_enabled = True
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

    with pytest.raises(ValidationError, match="conflicts"):
        ExecutionRef(token=token, execution_node_id="other")
    with pytest.raises(ValidationError, match="conflicts"):
        ExecutionRef(token=token, frame_path=(9,))


def test_execution_ref_identity_aliases_are_safe_without_token() -> None:
    ref = ExecutionRef(execution_node_id="node")

    assert ref.invocation_id == "node"
    assert ref.output_name == ""


def test_spawn_returns_validated_child_handle_and_records_owner() -> None:
    recorder = ExecutionEffectsRecorder(source_node_id="parent")
    execution = ExecutionInterface(recorder)

    handle = execution.spawn(
        graph={"nodes": {}},
        inputs={"value": {"items": [1, True, None]}},
        authorization_context={"user_id": "user"},
    )

    assert isinstance(handle, ChildExecutionHandle)
    assert handle.child_execution_id
    assert handle.parent_execution_id == "parent"
    assert handle.authorization_context == {"user_id": "user"}
    assert isinstance(recorder.snapshot()[0], SpawnExecutionEffect)
    effect = recorder.snapshot()[0]
    assert isinstance(effect, SpawnExecutionEffect)
    assert effect.parent == effect.execution_ref
    assert effect.child_execution_id == handle.child_execution_id
    assert effect.authorization_context == handle.authorization_context


@pytest.mark.parametrize(
    "value",
    [
        {"child_execution_id": "", "parent_execution_id": "parent"},
        {"child_execution_id": "child", "parent_execution_id": ""},
        {"child_execution_id": "child", "parent_execution_id": "parent", "authorization_context": ""},
    ],
)
def test_child_execution_handle_rejects_invalid_identity_or_authorization(value: dict[str, object]) -> None:
    with pytest.raises(ValidationError):
        ChildExecutionHandle.model_validate(value)


@pytest.mark.parametrize(
    "graph, inputs",
    [
        (None, {}),
        ({"nodes": {}}, []),
        ({"nodes": {}}, {"": 1}),
    ],
)
def test_spawn_rejects_invalid_inputs(graph: object, inputs: object) -> None:
    execution = ExecutionInterface(ExecutionEffectsRecorder(source_node_id="parent"))

    with pytest.raises((TypeError, ValidationError)):
        execution.spawn(graph, inputs)  # type: ignore[arg-type]


def test_recorder_drain_returns_and_clears_effects() -> None:
    recorder = ExecutionEffectsRecorder()
    effect = SetValueEffect(target=ExecutionRef(node_id="node", field="value"), value=3)
    recorder.record(effect)

    assert recorder.drain() == (effect,)
    assert recorder.snapshot() == ()


def test_set_value_effect_accepts_nested_and_runtime_values() -> None:
    target = ExecutionRef(node_id="node", field="value")
    nested_value = {"items": [1, True, None, {"name": "value"}]}

    assert SetValueEffect(target=target, value=nested_value).value == nested_value
    runtime_value = object()
    assert SetValueEffect(target=target, value=runtime_value).value is runtime_value


def test_set_value_effect_requires_a_value() -> None:
    with pytest.raises(ValidationError):
        SetValueEffect(target=ExecutionRef(node_id="node", field="value"))


def test_recorder_created_control_effects_carry_owner_refs() -> None:
    recorder = ExecutionEffectsRecorder(source_node_id="parent")
    execution = ExecutionInterface(recorder)

    execution.await_dependency(ExecutionRef(execution_node_id="child"))
    execution.fail("failed")

    await_effect, fail_effect = recorder.snapshot()
    assert isinstance(await_effect, AwaitEffect)
    assert isinstance(fail_effect, FailEffect)
    assert await_effect.execution_ref == ExecutionRef(execution_node_id="parent")
    assert fail_effect.execution_ref == ExecutionRef(execution_node_id="parent")


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
