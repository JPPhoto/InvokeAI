import pytest

from invokeai.app.invocations.fields import OutputScope
from invokeai.app.services.shared.graph import (
    ForInvocation,
    ForReturnInvocation,
    LoopState,
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
