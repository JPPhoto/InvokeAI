from __future__ import annotations

import json
from pathlib import Path
from typing import Any
from unittest.mock import Mock

import pytest

from invokeai.app.services.shared.execution_state_migration import (
    CURRENT_EXECUTION_STATE_VERSION,
    UnsupportedExecutionStateVersionError,
    dump_execution_state,
    load_execution_state,
)
from invokeai.app.services.shared.graph import GraphExecutionState, _ExecutionScheduler

FIXTURE_PATH = Path(__file__).parents[3] / "fixtures" / "execution_engine" / "static_dag_v1.json"


def _load_fixture(name: str = "static_dag_v1.json") -> GraphExecutionState:
    fixture_path = FIXTURE_PATH.with_name(name)
    with fixture_path.open(encoding="utf-8") as fixture:
        return load_execution_state(json.load(fixture))


def _run(
    state: GraphExecutionState,
    *,
    force_compatibility_scheduler: bool = False,
    stop_after: int | None = None,
    fail_source_id: str | None = None,
) -> tuple[list[str], GraphExecutionState]:
    if force_compatibility_scheduler:
        object.__setattr__(state, "_execution_scheduler", _ExecutionScheduler(state))

    trace: list[str] = []
    while (node := state.next()) is not None:
        source_id = state.prepared_source_mapping[node.id]
        trace.append(source_id)
        if source_id == fail_source_id:
            state.set_node_error(node.id, "injected failure")
            break
        state.complete(node.id, node.invoke(Mock()))
        if stop_after is not None and len(trace) == stop_after:
            break
    return trace, state


def _run_both(**kwargs: Any) -> tuple[tuple[list[str], GraphExecutionState], tuple[list[str], GraphExecutionState]]:
    base_kwargs = {key: value for key, value in kwargs.items() if key != "force_compatibility_scheduler"}
    generic = _run(_load_fixture(), force_compatibility_scheduler=False, **base_kwargs)
    compatibility = _run(_load_fixture(), force_compatibility_scheduler=True, **base_kwargs)
    return generic, compatibility


def _state_projection(state: GraphExecutionState) -> tuple[Any, ...]:
    """Compare durable behavior without depending on generated execution-node IDs."""
    prepared_sources = tuple(sorted(state.prepared_source_mapping.values()))
    executed_prepared_sources = tuple(
        sorted(
            state.prepared_source_mapping[execution_id]
            for execution_id in state.executed
            if execution_id in state.prepared_source_mapping
        )
    )
    completed_sources = tuple(sorted(source_id for source_id in state.graph.nodes if source_id in state.executed))
    results = tuple(
        sorted(
            (
                state.prepared_source_mapping[execution_id],
                json.dumps(output.model_dump(mode="json"), sort_keys=True),
            )
            for execution_id, output in state.results.items()
            if execution_id in state.prepared_source_mapping
        )
    )
    indegree = tuple(
        sorted(
            (state.prepared_source_mapping[execution_id], degree)
            for execution_id, degree in state.indegree.items()
            if execution_id in state.prepared_source_mapping
        )
    )
    errors = tuple(
        sorted(
            (state.prepared_source_mapping.get(execution_id, execution_id), message)
            for execution_id, message in state.errors.items()
        )
    )
    return (
        prepared_sources,
        executed_prepared_sources,
        completed_sources,
        results,
        indegree,
        errors,
        state.is_complete(),
    )


def test_static_dag_fresh_execution_has_matching_source_trace() -> None:
    generic, compatibility = _run_both()

    assert generic[0] == compatibility[0] == ["left", "right", "join"]
    assert generic[1].is_complete()
    assert compatibility[1].is_complete()
    assert _state_projection(generic[1]) == _state_projection(compatibility[1])


def test_static_dag_checkpoint_restore_has_matching_remaining_trace() -> None:
    expected_trace, expected_state = _run(_load_fixture())

    for force_compatibility_scheduler in (False, True):
        checkpoint_trace, checkpoint_state = _run(
            _load_fixture(),
            force_compatibility_scheduler=force_compatibility_scheduler,
            stop_after=1,
        )
        restored = load_execution_state(dump_execution_state(checkpoint_state))
        remaining_trace, restored_state = _run(
            restored,
            force_compatibility_scheduler=force_compatibility_scheduler,
        )

        assert checkpoint_trace + remaining_trace == expected_trace
        assert restored_state.is_complete()
        assert _state_projection(restored_state) == _state_projection(expected_state)


@pytest.mark.parametrize("force_compatibility_scheduler", [False, True])
def test_inflight_checkpoint_replays_claimed_work_after_rehydrate(force_compatibility_scheduler: bool) -> None:
    state = _load_fixture()
    if force_compatibility_scheduler:
        object.__setattr__(state, "_execution_scheduler", _ExecutionScheduler(state))

    claimed = state.next()
    assert claimed is not None
    snapshot = dump_execution_state(state)
    restored = load_execution_state(snapshot)
    if force_compatibility_scheduler:
        object.__setattr__(restored, "_execution_scheduler", _ExecutionScheduler(restored))

    replayed = restored.next()
    assert replayed is not None
    assert state.prepared_source_mapping[claimed.id] == "left"
    assert restored.prepared_source_mapping[replayed.id] == "left"
    assert restored.executed == set()


def test_injected_failure_stops_both_schedulers_without_further_scheduling() -> None:
    for trace, state in _run_both(fail_source_id="right"):
        assert trace == ["left", "right"]
        assert {
            state.prepared_source_mapping.get(node_id, node_id): message for node_id, message in state.errors.items()
        } == {"right": "injected failure"}
        assert state.next() is None
        assert "join" not in state.results


def test_injected_failure_round_trip_preserves_both_scheduler_terminal_state() -> None:
    generic, compatibility = _run_both(fail_source_id="right")
    restored_generic = load_execution_state(dump_execution_state(generic[1]))
    restored_compatibility = load_execution_state(dump_execution_state(compatibility[1]))
    object.__setattr__(restored_compatibility, "_execution_scheduler", _ExecutionScheduler(restored_compatibility))

    assert restored_generic.next() is None
    assert restored_compatibility.next() is None
    assert restored_generic.is_complete()
    assert restored_compatibility.is_complete()
    assert _state_projection(restored_generic) == _state_projection(restored_compatibility)


@pytest.mark.parametrize("fixture_name", ["static_dag_partial_v1.json", "static_dag_failed_v1.json"])
def test_durable_snapshot_corpus_round_trips_without_losing_terminal_state(fixture_name: str) -> None:
    state = _load_fixture(fixture_name)
    restored = load_execution_state(dump_execution_state(state))

    assert restored.id == state.id
    assert restored.executed == state.executed
    assert restored.executed_history == state.executed_history
    assert restored.errors == state.errors
    assert restored.indegree == state.indegree

    if state.errors:
        for force_compatibility_scheduler in (False, True):
            candidate = load_execution_state(dump_execution_state(state))
            if force_compatibility_scheduler:
                object.__setattr__(candidate, "_execution_scheduler", _ExecutionScheduler(candidate))
            assert candidate.next() is None
            assert candidate.is_complete()
        generic = load_execution_state(dump_execution_state(state))
        compatibility = load_execution_state(dump_execution_state(state))
        object.__setattr__(compatibility, "_execution_scheduler", _ExecutionScheduler(compatibility))
        assert _state_projection(generic) == _state_projection(compatibility)
    else:
        generic_trace, generic_state = _run(restored)
        compatibility_trace, compatibility_state = _run(
            load_execution_state(dump_execution_state(state)),
            force_compatibility_scheduler=True,
        )
        assert generic_trace == compatibility_trace == ["right", "join"]
        assert generic_state.is_complete()
        assert compatibility_state.is_complete()


def test_fixture_is_versioned_and_future_versions_are_explicitly_rejected() -> None:
    with FIXTURE_PATH.open(encoding="utf-8") as fixture:
        snapshot = json.load(fixture)

    assert snapshot["execution_state_version"] == CURRENT_EXECUTION_STATE_VERSION
    assert load_execution_state(snapshot).id == "fixture-state"

    future_snapshot = dict(snapshot)
    future_snapshot["execution_state_version"] = CURRENT_EXECUTION_STATE_VERSION + 1
    with pytest.raises(UnsupportedExecutionStateVersionError, match="newer than supported"):
        load_execution_state(future_snapshot)
