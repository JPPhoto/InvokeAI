import pytest

from invokeai.app.invocations.fields import OutputScope
from invokeai.app.services.invocation_cache.invocation_cache_memory import MemoryInvocationCache
from invokeai.app.services.shared.graph import (
    ForInvocation,
    ForReturnInvocation,
    LoopState,
    StateEmptyInvocation,
    StateGetInvocation,
    StateMergeInvocation,
    StateSetInvocation,
    get_output_field_scope,
)


def test_loop_state_defaults_to_empty_values() -> None:
    assert LoopState().values == {}


def test_for_invocation_outputs_have_iteration_and_final_scopes() -> None:
    node = ForInvocation(id="for")

    assert get_output_field_scope(node, "item") == OutputScope.Iteration
    assert get_output_field_scope(node, "index") == OutputScope.Iteration
    assert get_output_field_scope(node, "total") == OutputScope.Iteration
    assert get_output_field_scope(node, "state") == OutputScope.Iteration
    assert get_output_field_scope(node, "output_collection") == OutputScope.Final
    assert get_output_field_scope(node, "final_state") == OutputScope.Final


def test_for_invocation_is_not_directly_executable() -> None:
    node = ForInvocation(id="for")

    with pytest.raises(NotImplementedError, match="scheduler-special"):
        node.invoke(None)  # type: ignore[arg-type]


def test_for_return_invocation_returns_body_output_and_state() -> None:
    state = LoopState(values={"count": 1})
    node = ForReturnInvocation(id="return", output="value", state=state)

    output = node.invoke(None)  # type: ignore[arg-type]

    assert output.output == "value"
    assert output.state == state


def test_state_empty_invocation_returns_empty_loop_state() -> None:
    node = StateEmptyInvocation(id="state_empty")

    output = node.invoke(None)  # type: ignore[arg-type]

    assert output.state == LoopState()


def test_state_get_invocation_returns_value_for_key() -> None:
    state = LoopState(values={"count": 2})
    node = StateGetInvocation(id="state_get", state=state, key="count")

    output = node.invoke(None)  # type: ignore[arg-type]

    assert output.value == 2


def test_state_get_invocation_returns_default_for_missing_key() -> None:
    state = LoopState(values={"count": 2})
    node = StateGetInvocation(id="state_get", state=state, key="missing", default="fallback")

    output = node.invoke(None)  # type: ignore[arg-type]

    assert output.value == "fallback"


def test_state_set_invocation_returns_new_state_with_value() -> None:
    state = LoopState(values={"count": 2})
    node = StateSetInvocation(id="state_set", state=state, key="count", value=3)

    output = node.invoke(None)  # type: ignore[arg-type]

    assert output.state == LoopState(values={"count": 3})
    assert state == LoopState(values={"count": 2})


def test_state_set_invocation_defaults_to_empty_input_state() -> None:
    node = StateSetInvocation(id="state_set", key="count", value=1)

    output = node.invoke(None)  # type: ignore[arg-type]

    assert output.state == LoopState(values={"count": 1})


def test_state_merge_invocation_returns_new_state_with_updates() -> None:
    state = LoopState(values={"count": 2, "name": "old"})
    node = StateMergeInvocation(id="state_merge", state=state, values={"name": "new", "done": True})

    output = node.invoke(None)  # type: ignore[arg-type]

    assert output.state == LoopState(values={"count": 2, "name": "new", "done": True})
    assert state == LoopState(values={"count": 2, "name": "old"})


def test_state_merge_invocation_default_values_are_not_shared() -> None:
    first = StateMergeInvocation(id="first")
    second = StateMergeInvocation(id="second")
    first.values["count"] = 1

    assert second.values == {}


def test_loop_body_cache_key_ignores_rematerialized_node_id_when_inputs_match() -> None:
    first = StateGetInvocation(id="state_get_0", state=LoopState(values={"count": 1}), key="count")
    second = StateGetInvocation(id="state_get_1", state=LoopState(values={"count": 1}), key="count")

    assert MemoryInvocationCache.create_key(first) == MemoryInvocationCache.create_key(second)


def test_loop_body_cache_key_includes_loop_state_input() -> None:
    first = StateGetInvocation(id="state_get_0", state=LoopState(), key="last_item", default=None)
    second = StateGetInvocation(
        id="state_get_1", state=LoopState(values={"last_item": "alpha"}), key="last_item", default=None
    )

    assert MemoryInvocationCache.create_key(first) != MemoryInvocationCache.create_key(second)


def test_loop_body_cache_key_includes_loop_item_input() -> None:
    first = StateSetInvocation(id="state_set_0", state=LoopState(), key="last_item", value="alpha")
    second = StateSetInvocation(id="state_set_1", state=LoopState(), key="last_item", value="beta")

    assert MemoryInvocationCache.create_key(first) != MemoryInvocationCache.create_key(second)
