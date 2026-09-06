import pytest

from invokeai.app.invocations.math import AddInvocation
from invokeai.app.services.shared.execution_state_migration import (
    CURRENT_EXECUTION_STATE_VERSION,
    UnsupportedExecutionStateVersionError,
    dump_execution_state,
    load_execution_state,
)
from invokeai.app.services.shared.graph import Graph, GraphExecutionState


def _make_state() -> GraphExecutionState:
    graph = Graph()
    graph.add_node(AddInvocation(id="node-id", a=1, b=2))
    execution_graph = Graph()
    execution_graph.add_node(AddInvocation(id="exec-node", a=1, b=2))
    return GraphExecutionState(
        id="state-id",
        graph=graph,
        execution_graph=execution_graph,
        executed={"node-id"},
        executed_history=["node-id"],
        errors={"node-id": "failure"},
        prepared_source_mapping={"exec-node": "node-id"},
        source_prepared_mapping={"node-id": {"exec-node"}},
        finalized_loop_contexts={("loop", (0, 1))},
        prepared_iteration_paths={"exec-node": (0, 1)},
        ready_order=["exec-node"],
        indegree={"exec-node": 0},
    )


def test_loads_legacy_unwrapped_graph_execution_state() -> None:
    state = _make_state()
    legacy_payload = state.model_dump(mode="json", warnings=False, exclude_none=True)

    restored = load_execution_state(legacy_payload)

    assert restored.model_dump(mode="json", warnings=False, exclude_none=True) == legacy_payload


def test_dumps_and_loads_versioned_execution_state_envelope() -> None:
    state = _make_state()

    snapshot = dump_execution_state(state)
    restored = load_execution_state(snapshot)

    assert snapshot["execution_state_version"] == CURRENT_EXECUTION_STATE_VERSION
    assert "state" not in snapshot
    expected = dict(snapshot)
    expected.pop("execution_state_version")
    assert restored.model_dump(mode="json", warnings=False, exclude_none=True) == expected


def test_loads_temporary_versioned_envelope() -> None:
    state = _make_state()
    raw = state.model_dump(mode="json", warnings=False, exclude_none=True)

    restored = load_execution_state({"version": CURRENT_EXECUTION_STATE_VERSION, "state": raw})

    assert restored.id == state.id


def test_rejects_future_execution_state_versions() -> None:
    snapshot = dump_execution_state(_make_state())
    snapshot["execution_state_version"] = CURRENT_EXECUTION_STATE_VERSION + 1

    with pytest.raises(UnsupportedExecutionStateVersionError, match="newer than supported"):
        load_execution_state(snapshot)
