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
from invokeai.app.invocations.logic import IfInvocation, IfInvocationOutput
from invokeai.app.services.shared.execution_effects import (
    AddEdgeEffect,
    AwaitEffect,
    ChildExecutionHandle,
    CloseStreamEffect,
    EmitEffect,
    ExecutionEffectsRecorder,
    ExecutionInterface,
    ExecutionRef,
    ExecutionToken,
    FailEffect,
    RemoveEdgeEffect,
    SetValueEffect,
    SpawnExecutionEffect,
    UnsupportedExecutionEffectError,
)
from invokeai.app.services.shared.execution_engine.child import ChildExecutionCapability
from invokeai.app.services.shared.execution_state_migration import dump_execution_state, load_execution_state
from invokeai.app.services.shared.graph import Edge, EdgeConnection, Graph, GraphExecutionState
from invokeai.app.services.shared.invocation_context import (
    InvocationContext,
    InvocationContextData,
    build_invocation_context,
)


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
            EmitEffect(
                token=ExecutionToken(node_id=self.id, field="value", value=self.value),
                value=self.value,
            )
        )
        return ExecutionEffectsTestOutput(value=self.value)


@invocation("execution_effects_override_test", version="1.0.0")
class ExecutionEffectsOverrideInvocation(BaseInvocation):
    execution_effects_enabled = True
    value: int = InputField(default=1)
    calls: ClassVar[int] = 0

    def invoke(self, context: InvocationContext) -> ExecutionEffectsTestOutput:
        type(self).calls += 1
        context.effects.record(
            EmitEffect(
                token=ExecutionToken(node_id=self.id, field="value", value=self.value),
                value=self.value,
            )
        )
        return ExecutionEffectsTestOutput(value=self.value)

    def invoke_internal(self, context: InvocationContext, services: MagicMock) -> ExecutionEffectsTestOutput:
        cached_value = services.invocation_cache.get("override-cache-key")
        if cached_value is not None:
            return cached_value
        return self.invoke(context)


def _context() -> InvocationContext:
    context = object.__new__(InvocationContext)
    context.execution_effects = ExecutionEffectsRecorder()
    context.effects = context.execution_effects
    return context


def _services(cache_size: int = 1) -> MagicMock:
    services = MagicMock()
    services.configuration.node_cache_size = cache_size
    return services


def test_context_default_recorder_preserves_execution_frame() -> None:
    context = build_invocation_context(
        services=MagicMock(),
        data=InvocationContextData(
            queue_item=None,  # type: ignore[arg-type]
            invocation=ExecutionEffectsTestInvocation(id="node"),
            source_invocation_id="source",
            execution_frame=(2, 1),
        ),
        is_canceled=lambda: False,
    )

    assert context.execution_effects.source_node_id == "node"
    assert context.execution_effects.frame_path == (2, 1)


@pytest.mark.parametrize(
    ("condition", "selected_field"),
    [(True, "true_input"), (False, "false_input")],
)
def test_if_invocation_declares_selected_branch_activation_effect(condition: bool, selected_field: str) -> None:
    context = _context()
    context.execution_effects = ExecutionEffectsRecorder(source_node_id="if")
    context.execution = ExecutionInterface(context.execution_effects)
    invocation = IfInvocation(id="if", condition=condition, true_input="true", false_input="false")

    result = invocation.invoke_internal_with_effects(context, _services())

    assert result.output.value == ("true" if condition else "false")
    assert len(result.effects) == 1
    effect = result.effects[0]
    assert isinstance(effect, EmitEffect)
    assert effect.token.node_id == "if"
    assert effect.token.field == selected_field
    assert effect.token.value == selected_field
    assert effect.token.token_kind == "activation"


@pytest.mark.parametrize("condition", [True, False])
def test_graph_state_applies_if_activation_and_releases_selected_branch(condition: bool) -> None:
    graph = Graph()
    graph.add_node(IfInvocation(id="if", condition=condition))
    graph.add_node(ExecutionEffectsTestInvocation(id="true_branch", value=1))
    graph.add_node(ExecutionEffectsTestInvocation(id="false_branch", value=2))
    graph.add_node(ExecutionEffectsTestInvocation(id="successor"))
    graph.add_edge(
        Edge(
            source=EdgeConnection(node_id="true_branch", field="value"),
            destination=EdgeConnection(node_id="if", field="true_input"),
        )
    )
    graph.add_edge(
        Edge(
            source=EdgeConnection(node_id="false_branch", field="value"),
            destination=EdgeConnection(node_id="if", field="false_input"),
        )
    )
    graph.add_edge(
        Edge(
            source=EdgeConnection(node_id="if", field="value"),
            destination=EdgeConnection(node_id="successor", field="value"),
        )
    )
    state = GraphExecutionState(graph=graph)
    executed_source_ids: list[str] = []
    while True:
        invocation = state.next()
        if invocation is None:
            break
        executed_source_ids.append(state.prepared_source_mapping[invocation.id])
        execution_ref = state.get_execution_ref(invocation.id)
        if isinstance(invocation, IfInvocation):
            context = _context()
            context.execution_effects = ExecutionEffectsRecorder(
                source_node_id=invocation.id,
                frame_path=execution_ref.frame.iteration_path,
            )
            context.execution = ExecutionInterface(context.execution_effects)
            run_result = invocation.invoke_internal_with_effects(context, _services())
            execution_ref = state.get_execution_ref(invocation.id, effect_count=len(run_result.effects))
            state.apply(execution_ref, run_result)
        else:
            state.complete(invocation.id, invocation.invoke(context=MagicMock()))

    selected_branch = "true_branch" if condition else "false_branch"
    unselected_branch = "false_branch" if condition else "true_branch"
    assert selected_branch in executed_source_ids
    assert unselected_branch not in executed_source_ids
    assert "successor" in executed_source_ids
    activation_tokens = [token for token in state.execution_tokens.values() if token.token_kind == "activation"]
    assert len(activation_tokens) == 1
    assert activation_tokens[0].port == ("true_input" if condition else "false_input")
    if_exec_id = next(iter(state.source_prepared_mapping["if"]))
    if_execution_ref = state.get_execution_ref(if_exec_id)
    persisted_effects = state.execution_effects[if_execution_ref.reference_id]
    assert len(persisted_effects) == 1
    assert isinstance(persisted_effects[0], EmitEffect)
    assert persisted_effects[0].token.token_kind == "activation"
    snapshot = dump_execution_state(state)
    restored = load_execution_state(snapshot)
    assert (
        dump_execution_state(restored)["execution_effects"][if_execution_ref.reference_id]
        == snapshot["execution_effects"][if_execution_ref.reference_id]
    )
    assert not any(stream.owner_id == if_exec_id for stream in state._generic_runtime().streams.values())


def test_graph_state_rejects_unknown_if_activation_port() -> None:
    graph = Graph()
    graph.add_node(IfInvocation(id="if", condition=True, true_input="true", false_input="false"))
    state = GraphExecutionState(graph=graph)
    invocation = state.next()
    assert invocation is not None
    execution_ref = state.get_execution_ref(invocation.id)
    tokens_before = state.execution_tokens.copy()
    invalid_effect = EmitEffect(
        token=ExecutionToken(
            node_id=invocation.id,
            field="bogus",
            value="bogus",
            token_kind="activation",
        ),
        value="bogus",
    )

    with pytest.raises(ValueError, match="unknown activation port"):
        state.apply(
            execution_ref,
            IfInvocationOutput(value="true"),
            effects=[invalid_effect],
        )

    assert state.execution_tokens == tokens_before
    assert not state.execution_effects


def test_graph_state_rejects_unselected_if_activation_port() -> None:
    graph = Graph()
    graph.add_node(IfInvocation(id="if", condition=True, true_input="true", false_input="false"))
    state = GraphExecutionState(graph=graph)
    invocation = state.next()
    assert invocation is not None
    execution_ref = state.get_execution_ref(invocation.id)
    tokens_before = state.execution_tokens.copy()
    invalid_effect = EmitEffect(
        token=ExecutionToken(
            node_id=invocation.id,
            field="false_input",
            value="false_input",
            token_kind="activation",
        ),
        value="false_input",
    )

    with pytest.raises(ValueError, match="resolved If branch"):
        state.apply(
            execution_ref,
            IfInvocationOutput(value="true"),
            effects=[invalid_effect],
        )

    assert state.execution_tokens == tokens_before
    assert not state.execution_effects


def test_graph_state_rejects_if_activation_value_mismatch() -> None:
    graph = Graph()
    graph.add_node(IfInvocation(id="if", condition=True, true_input="true", false_input="false"))
    state = GraphExecutionState(graph=graph)
    invocation = state.next()
    assert invocation is not None
    execution_ref = state.get_execution_ref(invocation.id)
    tokens_before = state.execution_tokens.copy()
    invalid_effect = EmitEffect(
        token=ExecutionToken(
            node_id=invocation.id,
            field="true_input",
            value="false_input",
            token_kind="activation",
        ),
        value="false_input",
    )

    with pytest.raises(ValueError, match="activation value"):
        state.apply(
            execution_ref,
            IfInvocationOutput(value="true"),
            effects=[invalid_effect],
        )

    assert state.execution_tokens == tokens_before
    assert not state.execution_effects


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


@pytest.mark.parametrize(
    "alias, value",
    [
        ("node_id", "other"),
        ("invocation_id", "other"),
        ("field", "other"),
        ("port", "other"),
        ("output", "other"),
        ("output_name", "other"),
        ("frame", (9,)),
        ("iteration_path", (9,)),
    ],
)
def test_execution_ref_rejects_conflicting_legacy_alias_with_token(alias: str, value: object) -> None:
    token = ExecutionToken(node_id="node", field="value", frame=(2,))

    with pytest.raises(ValidationError, match="conflicts"):
        ExecutionRef(token=token, **{alias: value})


def test_execution_interface_rejects_unsupported_lifecycle_effects() -> None:
    recorder = ExecutionEffectsRecorder(source_node_id="parent")
    execution = ExecutionInterface(recorder)

    with pytest.raises(UnsupportedExecutionEffectError, match="not supported"):
        execution.spawn(graph={"nodes": {}}, inputs={})
    with pytest.raises(UnsupportedExecutionEffectError, match="not supported"):
        execution.await_dependency(ExecutionRef(execution_node_id="child"))
    with pytest.raises(UnsupportedExecutionEffectError, match="not supported"):
        execution.fail("failed")

    assert recorder.snapshot() == ()


def test_execution_interface_spawn_is_guarded() -> None:
    recorder = ExecutionEffectsRecorder(source_node_id="parent")
    execution = ExecutionInterface(recorder)

    with pytest.raises(UnsupportedExecutionEffectError):
        execution.spawn(
            graph={"nodes": {}},
            inputs={"value": {"items": [1, True, None]}},
            authorization_context={"user_id": "user"},
        )


def test_capability_enabled_execution_interface_records_child_lifecycle_effects() -> None:
    capability = ChildExecutionCapability(
        parent_execution_id="parent",
        parent_frame=(),
        authorization_context={"user_id": "user"},
    )
    recorder = ExecutionEffectsRecorder(
        source_node_id="parent",
        allow_lifecycle_effects=True,
        child_capability=capability,
    )
    execution = ExecutionInterface(recorder)

    handle = execution.spawn(graph={"nodes": {}}, inputs={})
    execution.await_dependency(ExecutionRef(execution_node_id="dependency"))
    execution.fail("failed")

    assert handle.child_execution_id
    assert handle.parent_execution_id == "parent"
    assert [effect.kind for effect in recorder.snapshot()] == ["spawn_execution", "await", "fail"]
    spawn = recorder.snapshot()[0]
    assert isinstance(spawn, SpawnExecutionEffect)
    assert spawn.child_execution_id == handle.child_execution_id
    assert spawn.authorization_context == {"user_id": "user"}


def test_capability_enabled_execution_interface_rejects_wrong_parent_scope() -> None:
    capability = ChildExecutionCapability(parent_execution_id="other", parent_frame=())
    recorder = ExecutionEffectsRecorder(
        source_node_id="parent",
        allow_lifecycle_effects=True,
        child_capability=capability,
    )

    with pytest.raises(PermissionError, match="another execution"):
        ExecutionInterface(recorder).spawn(graph={"nodes": {}}, inputs={})


def test_lifecycle_effects_require_a_child_capability() -> None:
    execution = ExecutionInterface(ExecutionEffectsRecorder(allow_lifecycle_effects=True))

    with pytest.raises(PermissionError, match="unavailable"):
        execution.await_dependency(ExecutionRef(execution_node_id="dependency"))
    with pytest.raises(PermissionError, match="unavailable"):
        execution.fail("failed")


@pytest.mark.parametrize(
    "effect",
    [
        SetValueEffect(target=ExecutionRef(node_id="node", field="value"), value=3),
        AddEdgeEffect(
            source=ExecutionRef(node_id="source", field="value"),
            destination=ExecutionRef(node_id="destination", field="input"),
        ),
        RemoveEdgeEffect(
            source=ExecutionRef(node_id="source", field="value"),
            destination=ExecutionRef(node_id="destination", field="input"),
        ),
    ],
)
def test_recorder_rejects_effects_without_graph_dispatch(effect: object) -> None:
    recorder = ExecutionEffectsRecorder(source_node_id="node")

    with pytest.raises(UnsupportedExecutionEffectError, match="not supported"):
        recorder.record(effect)  # type: ignore[arg-type]

    assert recorder.snapshot() == ()


def test_execution_interface_preserves_explicit_empty_frame() -> None:
    recorder = ExecutionEffectsRecorder(source_node_id="node", frame_path=(2,))
    execution = ExecutionInterface(recorder)

    execution.emit("value", 1, frame=())
    execution.close_stream("value", frame=())

    emit_effect, close_effect = recorder.snapshot()
    assert isinstance(emit_effect, EmitEffect)
    assert isinstance(close_effect, CloseStreamEffect)
    assert emit_effect.token.frame == ()
    assert close_effect.token.frame == ()


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
    with pytest.raises((TypeError, ValidationError)):
        SpawnExecutionEffect(
            parent=ExecutionRef(execution_node_id="parent"),
            graph=graph,
            inputs=inputs,  # type: ignore[arg-type]
            child_execution_id="child",
        )


def test_recorder_drain_returns_and_clears_effects() -> None:
    recorder = ExecutionEffectsRecorder()
    effect = EmitEffect(token=ExecutionToken(node_id="node", field="value", value=3), value=3)
    recorder.record(effect)

    assert recorder.drain() == (effect,)
    assert recorder.snapshot() == ()


def test_effect_values_accept_json_serializable_values_and_reject_runtime_values() -> None:
    target = ExecutionRef(node_id="node", field="value")
    nested_value = {"items": [1, True, None, {"name": "value"}]}

    assert SetValueEffect(target=target, value=nested_value).value == nested_value
    with pytest.raises(ValidationError, match="JSON-serializable"):
        SetValueEffect(target=target, value=object())
    with pytest.raises(ValidationError, match="JSON-serializable"):
        EmitEffect(token=ExecutionToken(node_id="node", field="value"), value=object())
    with pytest.raises(ValidationError, match="JSON-serializable"):
        ExecutionToken(node_id="node", field="value", value=object())
    with pytest.raises(ValidationError, match="JSON-serializable"):
        SpawnExecutionEffect(parent=ExecutionRef(execution_node_id="node"), graph=object(), child_execution_id="child")
    with pytest.raises(ValidationError, match="JSON-serializable"):
        SpawnExecutionEffect(
            parent=ExecutionRef(execution_node_id="node"),
            graph={},
            inputs={"value": object()},
            child_execution_id="child",
        )
    with pytest.raises(ValidationError, match="JSON-serializable"):
        SpawnExecutionEffect(
            parent=ExecutionRef(execution_node_id="node"),
            graph={},
            authorization_context={"user": object()},
            child_execution_id="child",
        )


def test_effect_values_survive_execution_state_json_dump() -> None:
    effect = SetValueEffect(
        target=ExecutionRef(node_id="node", field="value"),
        value={"items": [1, True, None, {"name": "value"}]},
    )
    state = GraphExecutionState(graph=Graph(), execution_effects={"reference": [effect]})

    snapshot = dump_execution_state(state)

    assert snapshot["execution_effects"]["reference"][0]["value"] == effect.value


def test_set_value_effect_requires_a_value() -> None:
    with pytest.raises(ValidationError):
        SetValueEffect(target=ExecutionRef(node_id="node", field="value"))


def test_lifecycle_effect_models_validate_owner_refs() -> None:
    await_effect = AwaitEffect(
        execution_ref=ExecutionRef(execution_node_id="parent"),
        dependency=ExecutionRef(execution_node_id="child"),
    )
    fail_effect = FailEffect(execution_ref=ExecutionRef(execution_node_id="parent"), message="failed")
    assert isinstance(await_effect, AwaitEffect)
    assert isinstance(fail_effect, FailEffect)


@pytest.mark.parametrize(
    "effect",
    [
        SpawnExecutionEffect(
            parent=ExecutionRef(execution_node_id="parent"),
            graph={},
            child_execution_id="child",
        ),
        AwaitEffect(
            execution_ref=ExecutionRef(execution_node_id="parent"),
            dependency=ExecutionRef(execution_node_id="child"),
        ),
        FailEffect(execution_ref=ExecutionRef(execution_node_id="parent"), message="failed"),
    ],
)
def test_recorder_rejects_unsupported_lifecycle_effects(effect: object) -> None:
    recorder = ExecutionEffectsRecorder(source_node_id="parent")

    with pytest.raises(UnsupportedExecutionEffectError, match="not supported"):
        recorder.record(effect)  # type: ignore[arg-type]

    assert recorder.snapshot() == ()


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
    effect = EmitEffect(
        token=ExecutionToken(node_id="node", field="value", value=3),
        value=3,
    )

    recorder.record(effect)
    effects = recorder.snapshot()

    assert effects == (effect,)
    with pytest.raises(TypeError, match="Expected ExecutionEffect"):
        recorder.record("not an effect")  # type: ignore[arg-type]

    invalid_effect = effect.model_copy(update={"value": object()})
    with pytest.raises(ValueError, match="JSON-serializable"):
        recorder.record(invalid_effect)
    assert recorder.snapshot() == (effect,)


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
    assert result.effects[0].kind == "emit"
    assert ExecutionEffectsTestInvocation.calls == 1
    services.invocation_cache.get.assert_not_called()
    services.invocation_cache.save.assert_not_called()


def test_effectful_invoke_clears_stale_effects() -> None:
    context = _context()
    context.effects.record(EmitEffect(token=ExecutionToken(node_id="stale", field="value", value=0), value=0))
    result = ExecutionEffectsTestInvocation(id="node", value=2).invoke_internal_with_effects(context, _services())

    assert [effect.value for effect in result.effects if isinstance(effect, EmitEffect)] == [2]


def test_effectful_invoke_disables_cache_in_invoke_internal_override() -> None:
    ExecutionEffectsOverrideInvocation.calls = 0
    services = _services()
    services.invocation_cache.get.return_value = ExecutionEffectsTestOutput(value=99)
    invocation_instance = ExecutionEffectsOverrideInvocation(id="node", value=7, use_cache=True)

    result = invocation_instance.invoke_internal_with_effects(_context(), services)

    assert result.output == ExecutionEffectsTestOutput(value=7)
    assert len(result.effects) == 1
    assert ExecutionEffectsOverrideInvocation.calls == 1
    assert invocation_instance.use_cache is True
    services.invocation_cache.get.assert_not_called()
