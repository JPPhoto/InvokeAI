from __future__ import annotations

import json
from pathlib import Path
from typing import Any
from unittest.mock import Mock

import pytest

from invokeai.app.invocations.logic import IfInvocation
from invokeai.app.invocations.math import AddInvocation
from invokeai.app.invocations.primitives import BooleanInvocation
from invokeai.app.services.shared.execution_state_migration import (
    CURRENT_EXECUTION_STATE_VERSION,
    UnsupportedExecutionStateVersionError,
    dump_execution_state,
    load_execution_state,
)
from invokeai.app.services.shared.graph import Edge, EdgeConnection, Graph, GraphExecutionState, _ExecutionScheduler

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


def _nested_if_graph() -> Graph:
    """Build a mixed graph whose selected outer branch contains an inner If."""
    graph = Graph()
    graph.add_node(BooleanInvocation(id="outer_condition", value=True))
    graph.add_node(BooleanInvocation(id="inner_condition", value=False))
    graph.add_node(AddInvocation(id="inner_true", a=2, b=2))
    graph.add_node(AddInvocation(id="inner_false", a=3, b=3))
    graph.add_node(AddInvocation(id="outer_false", a=10, b=0))
    graph.add_node(IfInvocation(id="inner_if"))
    graph.add_node(IfInvocation(id="outer_if"))
    graph.add_node(AddInvocation(id="sink", b=1))

    def connect(source: str, source_field: str, destination: str, destination_field: str) -> None:
        graph.add_edge(
            Edge(
                source=EdgeConnection(node_id=source, field=source_field),
                destination=EdgeConnection(node_id=destination, field=destination_field),
            )
        )

    connect("outer_condition", "value", "outer_if", "condition")
    connect("inner_condition", "value", "inner_if", "condition")
    connect("inner_true", "value", "inner_if", "true_input")
    connect("inner_false", "value", "inner_if", "false_input")
    connect("inner_if", "value", "outer_if", "true_input")
    connect("outer_false", "value", "outer_if", "false_input")
    connect("outer_if", "value", "sink", "a")
    return graph


def _run_graph(
    state: GraphExecutionState,
    *,
    force_compatibility_scheduler: bool = False,
    stop_after: int | None = None,
    fail_source_id: str | None = None,
) -> tuple[list[str], GraphExecutionState]:
    """Run a constructed graph through either scheduler path."""
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
        tuple(state.executed_history),
        results,
        indegree,
        errors,
        state.is_complete(),
    )


def _activation_projection(state: GraphExecutionState) -> tuple[tuple[str, str, Any, tuple[int, ...]], ...]:
    """Normalize activation tokens to source IDs and frame paths."""
    return tuple(
        sorted(
            (
                state.prepared_source_mapping[token.owner_node_id],
                token.port,
                token.value,
                tuple(token.frame.iteration_path),
            )
            for token in state.execution_tokens.values()
            if token.token_kind == "activation"
        )
    )


def test_static_dag_fresh_execution_has_matching_source_trace() -> None:
    generic, compatibility = _run_both()

    assert generic[0] == compatibility[0] == ["left", "right", "join"]
    assert generic[1].is_complete()
    assert compatibility[1].is_complete()
    assert _state_projection(generic[1]) == _state_projection(compatibility[1])


@pytest.mark.parametrize(
    ("outer_condition", "inner_condition", "expected_sources", "expected_value"),
    [
        (
            True,
            True,
            {"outer_condition", "inner_condition", "inner_true", "inner_if", "outer_if", "sink"},
            5,
        ),
        (
            True,
            False,
            {"outer_condition", "inner_condition", "inner_false", "inner_if", "outer_if", "sink"},
            7,
        ),
        (
            False,
            True,
            {"outer_condition", "outer_false", "outer_if", "sink"},
            11,
        ),
        (
            False,
            False,
            {"outer_condition", "outer_false", "outer_if", "sink"},
            11,
        ),
    ],
)
def test_nested_if_fresh_execution_matches_compatibility_scheduler(
    outer_condition: bool,
    inner_condition: bool,
    expected_sources: set[str],
    expected_value: int,
) -> None:
    def run(force_compatibility_scheduler: bool) -> tuple[list[str], GraphExecutionState]:
        graph = _nested_if_graph()
        graph.get_node("outer_condition").value = outer_condition
        graph.get_node("inner_condition").value = inner_condition
        return _run_graph(
            GraphExecutionState(graph=graph),
            force_compatibility_scheduler=force_compatibility_scheduler,
        )

    generic_trace, generic_state = run(False)
    compatibility_trace, compatibility_state = run(True)

    assert generic_trace == compatibility_trace
    assert {
        source_id
        for exec_node_id, source_id in generic_state.prepared_source_mapping.items()
        if exec_node_id in generic_state.results
    } == expected_sources
    assert {
        source_id
        for exec_node_id, source_id in compatibility_state.prepared_source_mapping.items()
        if exec_node_id in compatibility_state.results
    } == expected_sources
    assert generic_state.results[next(iter(generic_state.source_prepared_mapping["sink"]))].value == expected_value
    assert (
        compatibility_state.results[next(iter(compatibility_state.source_prepared_mapping["sink"]))].value
        == expected_value
    )
    assert _state_projection(generic_state) == _state_projection(compatibility_state)
    expected_activations = [
        ("outer_if", "true_input" if outer_condition else "false_input"),
    ]
    if outer_condition:
        expected_activations.append(("inner_if", "true_input" if inner_condition else "false_input"))
    expected_activation_projection = tuple(
        sorted((*activation, activation[1], ()) for activation in expected_activations)
    )
    assert (
        _activation_projection(generic_state)
        == _activation_projection(compatibility_state)
        == expected_activation_projection
    )
    assert generic_state.is_complete()
    assert compatibility_state.is_complete()


def test_nested_if_checkpoint_restore_matches_compatibility_scheduler() -> None:
    graph = _nested_if_graph()
    expected_trace, expected_state = _run_graph(GraphExecutionState(graph=graph.model_copy(deep=True)))

    for force_compatibility_scheduler in (False, True):
        checkpoint_trace, checkpoint_state = _run_graph(
            GraphExecutionState(graph=graph.model_copy(deep=True)),
            force_compatibility_scheduler=force_compatibility_scheduler,
            stop_after=4,
        )
        restored = load_execution_state(dump_execution_state(checkpoint_state))
        if force_compatibility_scheduler:
            object.__setattr__(restored, "_execution_scheduler", _ExecutionScheduler(restored))
        remaining_trace, restored_state = _run_graph(
            restored,
            force_compatibility_scheduler=force_compatibility_scheduler,
        )

        assert checkpoint_trace + remaining_trace == expected_trace
        assert _state_projection(restored_state) == _state_projection(expected_state)
        assert _activation_projection(restored_state) == _activation_projection(expected_state)
        assert restored_state.is_complete()


def test_nested_if_failure_round_trip_matches_compatibility_scheduler() -> None:
    expected_trace = ["outer_condition", "inner_condition", "inner_false"]
    expected_errors = {"inner_false": "injected failure"}

    generic_trace, generic_state = _run_graph(
        GraphExecutionState(graph=_nested_if_graph()),
        fail_source_id="inner_false",
    )
    compatibility_trace, compatibility_state = _run_graph(
        GraphExecutionState(graph=_nested_if_graph()),
        force_compatibility_scheduler=True,
        fail_source_id="inner_false",
    )

    assert generic_trace == compatibility_trace == expected_trace
    assert generic_state.next() is None
    assert compatibility_state.next() is None
    for state in (generic_state, compatibility_state):
        assert {
            state.prepared_source_mapping.get(execution_id, execution_id): message
            for execution_id, message in state.errors.items()
        } == expected_errors
        result_sources = {state.prepared_source_mapping[execution_id] for execution_id in state.results}
        assert "inner_if" not in result_sources
        assert "outer_if" not in result_sources
        assert "sink" not in result_sources
    assert _state_projection(generic_state) == _state_projection(compatibility_state)

    restored_generic = load_execution_state(dump_execution_state(generic_state))
    restored_compatibility = load_execution_state(dump_execution_state(compatibility_state))
    object.__setattr__(restored_compatibility, "_execution_scheduler", _ExecutionScheduler(restored_compatibility))
    assert restored_generic.next() is None
    assert restored_compatibility.next() is None
    assert _state_projection(restored_generic) == _state_projection(restored_compatibility)


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
