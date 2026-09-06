import pytest

from invokeai.app.services.shared.execution_state_migration import (
    CURRENT_EXECUTION_STATE_VERSION,
    UnsupportedExecutionStateVersionError,
    dump_execution_state,
    load_execution_state,
)
from invokeai.app.services.shared.graph import Graph, GraphExecutionState


def _make_state() -> GraphExecutionState:
    return GraphExecutionState(
        id="state-id",
        graph=Graph(),
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

    assert snapshot["version"] == CURRENT_EXECUTION_STATE_VERSION
    assert set(snapshot) == {"version", "state"}
    assert restored.model_dump(mode="json", warnings=False, exclude_none=True) == snapshot["state"]


def test_rejects_future_execution_state_versions() -> None:
    snapshot = dump_execution_state(_make_state())
    snapshot["version"] = CURRENT_EXECUTION_STATE_VERSION + 1

    with pytest.raises(UnsupportedExecutionStateVersionError, match="newer than supported"):
        load_execution_state(snapshot)
