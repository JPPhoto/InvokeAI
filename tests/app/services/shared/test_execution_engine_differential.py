from __future__ import annotations

import json
from pathlib import Path
from typing import Any
from unittest.mock import Mock

import pytest
from pydantic import ValidationError

from invokeai.app.invocations.logic import IfInvocation
from invokeai.app.invocations.loops import ForInvocation, ForReturnInvocation, LoopState, StateSetInvocation
from invokeai.app.invocations.math import AddInvocation
from invokeai.app.invocations.primitives import BooleanInvocation
from invokeai.app.services.shared import graph as graph_module
from invokeai.app.services.shared.execution_state_migration import (
    CURRENT_EXECUTION_STATE_VERSION,
    UnsupportedExecutionStateVersionError,
    dump_execution_state,
    load_execution_state,
)
from invokeai.app.services.shared.graph import (
    Edge,
    EdgeConnection,
    Graph,
    GraphExecutionState,
    _ExecutionScheduler,
    _GenericGraphSchedulerAdapter,
    _IfBranchScheduler,
)
from tests.test_nodes import AnyTypeTestInvocation

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
        state._execution_scheduler = _ExecutionScheduler(state)

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


def _restore_compatibility_scheduler(state: GraphExecutionState) -> None:
    state._ready_queues = {}
    state._ready_node_ids = set()
    state._active_class = None
    state._execution_scheduler = _ExecutionScheduler(state)
    state._rehydrate_ready_queues()


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


def _flat_for_graph(*, with_after: bool = False) -> Graph:
    graph = Graph()
    graph.add_node(ForInvocation(id="for", collection=[1, 2]))
    graph.add_node(AddInvocation(id="body", b=10))
    graph.add_node(ForReturnInvocation(id="return"))
    if with_after:
        graph.add_node(AnyTypeTestInvocation(id="after"))
    graph.add_edge(
        Edge(
            source=EdgeConnection(node_id="for", field="item"),
            destination=EdgeConnection(node_id="body", field="a"),
        )
    )
    graph.add_edge(
        Edge(
            source=EdgeConnection(node_id="body", field="value"),
            destination=EdgeConnection(node_id="return", field="output"),
        )
    )
    graph.add_edge(
        Edge(
            type="loop_linkage",
            source=EdgeConnection(node_id="for", field="loop_linkage"),
            destination=EdgeConnection(node_id="return", field="loop_linkage"),
        )
    )
    if with_after:
        graph.add_edge(
            Edge(
                source=EdgeConnection(node_id="for", field="output_collection"),
                destination=EdgeConnection(node_id="after", field="value"),
            )
        )
    return graph


def _flat_for_state_graph(continue_condition: bool) -> Graph:
    graph = Graph()
    graph.add_node(ForInvocation(id="for", collection=[1, 2, 3], state=LoopState(values={"count": 0})))
    graph.add_node(StateSetInvocation(id="body", key="count"))
    graph.add_node(ForReturnInvocation(id="return", continue_condition=continue_condition))
    graph.add_edge(
        Edge(
            source=EdgeConnection(node_id="for", field="state"),
            destination=EdgeConnection(node_id="body", field="state"),
        )
    )
    graph.add_edge(
        Edge(
            source=EdgeConnection(node_id="for", field="item"),
            destination=EdgeConnection(node_id="body", field="value"),
        )
    )
    graph.add_edge(
        Edge(
            source=EdgeConnection(node_id="for", field="item"),
            destination=EdgeConnection(node_id="return", field="output"),
        )
    )
    graph.add_edge(
        Edge(
            source=EdgeConnection(node_id="body", field="state"),
            destination=EdgeConnection(node_id="return", field="state"),
        )
    )
    graph.add_edge(
        Edge(
            type="loop_linkage",
            source=EdgeConnection(node_id="for", field="loop_linkage"),
            destination=EdgeConnection(node_id="return", field="loop_linkage"),
        )
    )
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
        state._execution_scheduler = _ExecutionScheduler(state)

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


def _run_until_source(
    state: GraphExecutionState,
    source_id_to_stop: str,
    *,
    force_compatibility_scheduler: bool = False,
) -> tuple[list[str], GraphExecutionState]:
    """Run through one source node, modeling a queue cancellation boundary."""
    if force_compatibility_scheduler:
        state._execution_scheduler = _ExecutionScheduler(state)

    trace: list[str] = []
    while (node := state.next()) is not None:
        source_id = state.prepared_source_mapping[node.id]
        trace.append(source_id)
        state.complete(node.id, node.invoke(Mock()))
        if source_id == source_id_to_stop:
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


def _execution_identity_projection(state: GraphExecutionState) -> tuple[Any, ...]:
    references = tuple(
        sorted(
            (
                state.prepared_source_mapping.get(exec_node_id, exec_node_id),
                reference.source_node_id,
                tuple(reference.frame.iteration_path),
                reference.frame.workflow_call_depth,
                reference.effect_count,
            )
            for exec_node_id, reference in state.execution_refs.items()
            if exec_node_id in state.prepared_source_mapping
        )
    )
    tokens = tuple(
        sorted(
            (
                state.prepared_source_mapping.get(token.owner_node_id, token.owner_node_id),
                token.port,
                json.dumps(token.value, sort_keys=True),
                token.token_kind,
                token.sequence,
                tuple(token.frame.iteration_path),
                token.frame.workflow_call_depth,
            )
            for token in state.execution_tokens.values()
        )
    )
    effects = tuple(
        sorted(
            (
                state.prepared_source_mapping.get(
                    next(
                        (
                            execution_id
                            for execution_id, reference in state.execution_refs.items()
                            if reference.reference_id == reference_id
                        ),
                        reference_id,
                    ),
                    reference_id,
                ),
                json.dumps(
                    [
                        effect.model_dump(mode="json", warnings=False) if hasattr(effect, "model_dump") else effect
                        for effect in effect_values
                    ],
                    sort_keys=True,
                ),
            )
            for reference_id, effect_values in state.execution_effects.items()
        )
    )
    return references, tokens, effects


def _execution_edge_projection(state: GraphExecutionState) -> tuple[tuple[str, str, str, str, str], ...]:
    return tuple(
        sorted(
            (
                state.prepared_source_mapping[edge.source.node_id],
                edge.source.field,
                state.prepared_source_mapping[edge.destination.node_id],
                edge.destination.field,
                edge.type,
            )
            for edge in state.execution_graph.edges
        )
    )


def _source_edge_projection(graph: Graph) -> tuple[tuple[str, str, str, str, str], ...]:
    return tuple(
        sorted(
            (
                edge.source.node_id,
                edge.source.field,
                edge.destination.node_id,
                edge.destination.field,
                edge.type,
            )
            for edge in graph.edges
        )
    )


def _expected_edge_projection(
    graph: Graph,
    *,
    force_compatibility_scheduler: bool,
    outer_condition: bool,
    inner_condition: bool,
) -> tuple[tuple[str, str, str, str, str], ...]:
    """Project the source graph using the explicit compatibility If lowering rules."""
    source_edges = _source_edge_projection(graph)
    if not force_compatibility_scheduler:
        return source_edges

    # The compatibility scheduler prunes only the inactive input edge at each If that it resolves. If the outer
    # branch is false, the inner If is never resolved, so its two branch edges remain in the compatibility graph.
    pruned_edges = {
        (
            "outer_false" if outer_condition else "inner_if",
            "value",
            "outer_if",
            "false_input" if outer_condition else "true_input",
            "default",
        ),
    }
    if outer_condition:
        pruned_edges.add(
            (
                "inner_false" if inner_condition else "inner_true",
                "value",
                "inner_if",
                "false_input" if inner_condition else "true_input",
                "default",
            )
        )
    return tuple(edge for edge in source_edges if edge not in pruned_edges)


def _normalized_indegree(state: GraphExecutionState) -> tuple[tuple[str, tuple[int, ...]], ...]:
    return tuple(
        sorted(
            (
                source_id,
                tuple(
                    sorted(
                        degree
                        for execution_id, degree in state.indegree.items()
                        if state.prepared_source_mapping.get(execution_id) == source_id
                    )
                ),
            )
            for source_id in state.graph.nodes
        )
    )


def _expected_remaining_input_indegree(
    state: GraphExecutionState,
    *,
    force_compatibility_scheduler: bool,
    outer_condition: bool,
    inner_condition: bool,
) -> dict[str, int]:
    """Calculate remaining indegrees from source edges and durable source completion only."""
    expected_edges = _expected_edge_projection(
        state.graph,
        force_compatibility_scheduler=force_compatibility_scheduler,
        outer_condition=outer_condition,
        inner_condition=inner_condition,
    )
    completed_sources = {
        source_id for execution_id, source_id in state.prepared_source_mapping.items() if execution_id in state.executed
    }
    return {
        execution_id: sum(
            source_id not in completed_sources
            for source_id, _source_field, destination_id, _destination_field, _edge_type in expected_edges
            if destination_id == state.prepared_source_mapping[execution_id]
        )
        for execution_id in state.prepared_source_mapping
    }


def _assert_execution_identity_consistent(state: GraphExecutionState) -> None:
    for exec_node_id, reference in state.execution_refs.items():
        if exec_node_id not in state.prepared_source_mapping:
            continue
        expected = state._expected_execution_ref(exec_node_id, effect_count=reference.effect_count)
        assert reference.reference_id == expected.reference_id
        assert reference.state_id == expected.state_id
        assert reference.exec_node_id == expected.exec_node_id
        assert reference.source_node_id == expected.source_node_id
        assert reference.frame == expected.frame
    for token_key, token in state.execution_tokens.items():
        expected = state.execution_refs.get(token.owner_node_id) or state._expected_execution_ref(token.owner_node_id)
        assert token_key == token.token_id
        assert token.reference_id == expected.reference_id
        assert token.owner_node_id == expected.exec_node_id
        assert token.frame.state_id == expected.frame.state_id
        assert token.frame.frame_id == expected.frame.frame_id
        assert token.frame.iteration_path == expected.frame.iteration_path
        assert token.frame.workflow_call_depth == expected.frame.workflow_call_depth
        if token.token_kind == "activation":
            owner = state.execution_graph.nodes[token.owner_node_id]
            activation_fields = getattr(type(owner), "execution_activation_fields", frozenset())
            assert token.port in activation_fields
            assert token.token_id == f"{expected.reference_id}:activation:{token.port}"
            assert token.value == token.port


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
    assert _execution_edge_projection(generic_state) == _expected_edge_projection(
        generic_state.graph,
        force_compatibility_scheduler=False,
        outer_condition=outer_condition,
        inner_condition=inner_condition,
    )
    assert _execution_edge_projection(compatibility_state) == _expected_edge_projection(
        compatibility_state.graph,
        force_compatibility_scheduler=True,
        outer_condition=outer_condition,
        inner_condition=inner_condition,
    )
    assert dict(generic_state.indegree) == _expected_remaining_input_indegree(
        generic_state,
        force_compatibility_scheduler=False,
        outer_condition=outer_condition,
        inner_condition=inner_condition,
    )
    assert dict(compatibility_state.indegree) == _expected_remaining_input_indegree(
        compatibility_state,
        force_compatibility_scheduler=True,
        outer_condition=outer_condition,
        inner_condition=inner_condition,
    )
    assert generic_state.is_complete()
    assert compatibility_state.is_complete()


def test_flat_for_fresh_execution_matches_compatibility_scheduler() -> None:
    generic_trace, generic_state = _run_graph(GraphExecutionState(graph=_flat_for_graph()))
    compatibility_trace, compatibility_state = _run_graph(
        GraphExecutionState(graph=_flat_for_graph()),
        force_compatibility_scheduler=True,
    )

    assert generic_trace == compatibility_trace == ["for", "body", "return", "for", "body", "return"]
    assert _state_projection(generic_state) == _state_projection(compatibility_state)
    assert generic_state.is_complete()
    assert compatibility_state.is_complete()
    assert isinstance(generic_state._execution_scheduler, _GenericGraphSchedulerAdapter)
    final_for_id = max(
        (
            exec_node_id
            for exec_node_id, source_node_id in generic_state.prepared_source_mapping.items()
            if source_node_id == "for"
        ),
        key=lambda exec_node_id: generic_state.execution_graph.get_node(exec_node_id).index,
    )
    assert generic_state.results[final_for_id].output_collection == [11, 12]
    assert generic_state._generic_runtime().continuations
    assert all(
        continuation.status == "completed" for continuation in generic_state._generic_runtime().continuations.values()
    )
    assert len(generic_state._generic_runtime().continuations) == 2
    assert {continuation.owner_id for continuation in generic_state._generic_runtime().continuations.values()} == {
        exec_node_id
        for exec_node_id, source_node_id in generic_state.prepared_source_mapping.items()
        if source_node_id == "for"
    }
    assert isinstance(compatibility_state._execution_scheduler, _ExecutionScheduler)


def test_flat_for_fresh_execution_releases_after_loop_consumer() -> None:
    generic_trace, generic_state = _run_graph(
        GraphExecutionState(graph=_flat_for_graph(with_after=True)),
    )
    compatibility_trace, compatibility_state = _run_graph(
        GraphExecutionState(graph=_flat_for_graph(with_after=True)),
        force_compatibility_scheduler=True,
    )

    assert generic_trace == compatibility_trace == ["for", "body", "return", "for", "body", "return", "after"]
    after_id = next(
        exec_node_id
        for exec_node_id, source_node_id in generic_state.prepared_source_mapping.items()
        if source_node_id == "after"
    )
    assert generic_state.results[after_id].value == [11, 12]
    assert compatibility_state.results[
        next(
            exec_node_id
            for exec_node_id, source_node_id in compatibility_state.prepared_source_mapping.items()
            if source_node_id == "after"
        )
    ].value == [11, 12]
    assert _state_projection(generic_state) == _state_projection(compatibility_state)


@pytest.mark.parametrize(
    ("continue_condition", "expected_trace", "expected_collection", "expected_state"),
    [
        (True, ["for", "body", "return"] * 3, [1, 2, 3], {"count": 3}),
        (False, ["for", "body", "return"], [1], {"count": 1}),
    ],
)
def test_flat_for_fresh_execution_matches_state_and_break_semantics(
    continue_condition: bool,
    expected_trace: list[str],
    expected_collection: list[int],
    expected_state: dict[str, int],
) -> None:
    generic_trace, generic_state = _run_graph(
        GraphExecutionState(graph=_flat_for_state_graph(continue_condition)),
    )
    compatibility_trace, compatibility_state = _run_graph(
        GraphExecutionState(graph=_flat_for_state_graph(continue_condition)),
        force_compatibility_scheduler=True,
    )

    assert generic_trace == compatibility_trace == expected_trace
    final_for_id = max(
        (
            exec_node_id
            for exec_node_id, source_node_id in generic_state.prepared_source_mapping.items()
            if source_node_id == "for"
        ),
        key=lambda exec_node_id: generic_state.execution_graph.get_node(exec_node_id).index,
    )
    final_for_output = generic_state.results[final_for_id]
    assert final_for_output.output_collection == expected_collection
    assert final_for_output.final_state == LoopState(values=expected_state)
    assert _state_projection(generic_state) == _state_projection(compatibility_state)


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
            _restore_compatibility_scheduler(restored)
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
    _restore_compatibility_scheduler(restored_compatibility)
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
    _restore_compatibility_scheduler(restored_compatibility)

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
                _restore_compatibility_scheduler(candidate)
            assert candidate.next() is None
            assert candidate.is_complete()
        generic = load_execution_state(dump_execution_state(state))
        compatibility = load_execution_state(dump_execution_state(state))
        _restore_compatibility_scheduler(compatibility)
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


def test_generic_legacy_shaped_if_does_not_prune_or_skip_during_resolution(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    graph = _nested_if_graph()
    state = GraphExecutionState(graph=graph)
    deleted_edges: list[Edge] = []

    def fail_prune(*_: object, **__: object) -> None:
        raise AssertionError("generic If execution called _prune_unselected_if_inputs")

    def fail_skip(*_: object, **__: object) -> None:
        raise AssertionError("generic If execution called mark_exec_node_skipped")

    def fail_topology(*_: object, **__: object) -> dict[str, set[str]]:
        raise AssertionError("generic If execution consulted legacy branch topology")

    def fail_legacy_scheduler(*_: object, **__: object) -> None:
        raise AssertionError("generic If execution instantiated the legacy branch scheduler")

    def record_deleted_edge(self: GraphExecutionState, edge: Edge) -> None:
        deleted_edges.append(edge)

    monkeypatch.setattr(_IfBranchScheduler, "_prune_unselected_if_inputs", fail_prune)
    monkeypatch.setattr(_IfBranchScheduler, "mark_exec_node_skipped", fail_skip)
    monkeypatch.setattr(_IfBranchScheduler, "__init__", fail_legacy_scheduler)
    monkeypatch.setattr(graph_module, "_get_if_branch_exclusive_sources", fail_topology)
    monkeypatch.setattr(GraphExecutionState, "_tx_delete_execution_edge", record_deleted_edge)

    trace, state = _run_graph(state)

    assert trace == ["outer_condition", "inner_condition", "inner_false", "inner_if", "outer_if", "sink"]
    sink_id = next(iter(state.source_prepared_mapping["sink"]))
    assert state.results[sink_id].value == 7
    assert state.is_complete()
    assert deleted_edges == []


@pytest.mark.parametrize(
    ("outer_condition", "inner_condition", "expected_trace", "expected_history", "expected_value"),
    [
        (
            True,
            True,
            ["outer_condition", "inner_condition", "inner_true", "inner_if", "outer_if", "sink"],
            [
                "outer_condition",
                "outer_false",
                "inner_condition",
                "inner_false",
                "inner_true",
                "inner_if",
                "outer_if",
                "sink",
            ],
            5,
        ),
        (
            True,
            False,
            ["outer_condition", "inner_condition", "inner_false", "inner_if", "outer_if", "sink"],
            [
                "outer_condition",
                "outer_false",
                "inner_condition",
                "inner_true",
                "inner_false",
                "inner_if",
                "outer_if",
                "sink",
            ],
            7,
        ),
        (
            False,
            True,
            ["outer_condition", "outer_false", "outer_if", "sink"],
            [
                "outer_condition",
                "inner_condition",
                "inner_true",
                "inner_false",
                "inner_if",
                "outer_false",
                "outer_if",
                "sink",
            ],
            11,
        ),
        (
            False,
            False,
            ["outer_condition", "outer_false", "outer_if", "sink"],
            [
                "outer_condition",
                "inner_condition",
                "inner_true",
                "inner_false",
                "inner_if",
                "outer_false",
                "outer_if",
                "sink",
            ],
            11,
        ),
    ],
)
def test_fresh_generic_nested_if_preserves_state_without_legacy_branch_projection(
    outer_condition: bool,
    inner_condition: bool,
    expected_trace: list[str],
    expected_history: list[str],
    expected_value: int,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    graph = _nested_if_graph()
    graph.get_node("outer_condition").value = outer_condition
    graph.get_node("inner_condition").value = inner_condition

    def fail_legacy_path(*_: object, **__: object) -> None:
        raise AssertionError("fresh generic If execution used a legacy branch projection")

    generic_retired_nodes: list[str] = []
    original_discard = _GenericGraphSchedulerAdapter._retire_unselected_node

    def record_generic_discard(adapter: _GenericGraphSchedulerAdapter, exec_node_id: str) -> None:
        generic_retired_nodes.append(exec_node_id)
        original_discard(adapter, exec_node_id)

    monkeypatch.setattr(graph_module, "_get_if_branch_exclusive_sources", fail_legacy_path)
    monkeypatch.setattr(_GenericGraphSchedulerAdapter, "_retire_unselected_node", record_generic_discard)
    monkeypatch.setattr(_IfBranchScheduler, "_prune_unselected_if_inputs", fail_legacy_path)
    monkeypatch.setattr(_IfBranchScheduler, "mark_exec_node_skipped", fail_legacy_path)
    monkeypatch.setattr(GraphExecutionState, "_tx_delete_execution_edge", fail_legacy_path)

    trace, state = _run_graph(GraphExecutionState(graph=graph))

    assert trace == expected_trace
    assert state.executed_history == expected_history
    assert set(state.indegree) == set(state.prepared_source_mapping)
    assert set(state.indegree.values()) == {0}
    assert state.is_complete()
    sink_id = next(iter(state.source_prepared_mapping["sink"]))
    assert state.results[sink_id].value == expected_value
    assert _execution_edge_projection(state) == _source_edge_projection(graph)
    expected_retired_sources = (
        {"inner_false" if inner_condition else "inner_true", "outer_false"}
        if outer_condition
        else {"inner_condition", "inner_true", "inner_false", "inner_if"}
    )
    assert {state.prepared_source_mapping[exec_id] for exec_id in generic_retired_nodes} == expected_retired_sources


@pytest.mark.parametrize("stop_after_source", ["outer_if", "inner_false"])
def test_if_partial_state_round_trip_rebuilds_fresh_runtime_and_matches_both_scheduler_paths(
    stop_after_source: str,
) -> None:
    """A partial If state round-trips and a fresh runtime matches both scheduler paths."""
    expected_trace, expected_state = _run_graph(GraphExecutionState(graph=_nested_if_graph()))
    partial_projections: list[tuple[Any, ...]] = []
    projections: list[tuple[list[str], GraphExecutionState]] = []

    for force_compatibility_scheduler in (False, True):
        partial_trace, canceled_state = _run_until_source(
            GraphExecutionState(graph=_nested_if_graph()),
            stop_after_source,
            force_compatibility_scheduler=force_compatibility_scheduler,
        )
        expected_partial_trace = ["outer_condition", "inner_condition"]
        if stop_after_source == "inner_false":
            expected_partial_trace.append("inner_false")
        else:
            expected_partial_trace.extend(["inner_false", "inner_if", "outer_if"])
        assert partial_trace == expected_partial_trace
        assert "inner_true" not in {
            canceled_state.prepared_source_mapping[execution_id] for execution_id in canceled_state.results
        }
        assert "outer_false" not in {
            canceled_state.prepared_source_mapping[execution_id] for execution_id in canceled_state.results
        }
        assert not canceled_state.is_complete()
        assert dict(canceled_state.indegree) == _expected_remaining_input_indegree(
            canceled_state,
            force_compatibility_scheduler=force_compatibility_scheduler,
            outer_condition=True,
            inner_condition=False,
        )
        assert _activation_projection(canceled_state) == (
            ("inner_if", "false_input", "false_input", ()),
            ("outer_if", "true_input", "true_input", ()),
        )
        partial_snapshot = dump_execution_state(canceled_state)
        restored_canceled = load_execution_state(partial_snapshot)
        restored_expected = load_execution_state(partial_snapshot)
        if force_compatibility_scheduler:
            _restore_compatibility_scheduler(restored_canceled)
        assert _state_projection(restored_canceled) == _state_projection(canceled_state)
        assert _activation_projection(restored_canceled) == _activation_projection(canceled_state)
        assert dump_execution_state(restored_canceled)["execution_tokens"] == partial_snapshot["execution_tokens"]
        assert dump_execution_state(restored_canceled)["execution_effects"] == partial_snapshot["execution_effects"]
        assert _execution_identity_projection(restored_canceled) == _execution_identity_projection(restored_expected)
        _assert_execution_identity_consistent(restored_canceled)
        assert dict(restored_canceled.indegree) == _expected_remaining_input_indegree(
            restored_canceled,
            force_compatibility_scheduler=force_compatibility_scheduler,
            outer_condition=True,
            inner_condition=False,
        )
        partial_projections.append(
            (_state_projection(restored_canceled), _execution_identity_projection(restored_canceled))
        )

        remaining_trace, resumed_state = _run_graph(
            restored_canceled,
            force_compatibility_scheduler=force_compatibility_scheduler,
        )
        assert partial_trace + remaining_trace == expected_trace
        assert resumed_state.executed_history == expected_state.executed_history
        assert _state_projection(resumed_state) == _state_projection(expected_state)
        assert resumed_state.results[next(iter(resumed_state.source_prepared_mapping["sink"]))].value == 7
        assert resumed_state.is_complete()
        assert dict(resumed_state.indegree) == _expected_remaining_input_indegree(
            resumed_state,
            force_compatibility_scheduler=force_compatibility_scheduler,
            outer_condition=True,
            inner_condition=False,
        )

        retried_state = GraphExecutionState(graph=canceled_state.graph.model_copy(deep=True))
        assert retried_state.id != canceled_state.id
        assert retried_state.results == {}
        assert retried_state.execution_refs == {}
        assert retried_state.execution_tokens == {}

        retried_trace, retried_state = _run_graph(
            retried_state,
            force_compatibility_scheduler=force_compatibility_scheduler,
        )
        projections.append((retried_trace, retried_state))

    assert partial_projections[0] == partial_projections[1]
    assert (
        projections[0][0]
        == projections[1][0]
        == [
            "outer_condition",
            "inner_condition",
            "inner_false",
            "inner_if",
            "outer_if",
            "sink",
        ]
    )
    assert _state_projection(projections[0][1]) == _state_projection(projections[1][1])
    assert _activation_projection(projections[0][1]) == _activation_projection(projections[1][1])
    assert _execution_identity_projection(projections[0][1]) == _execution_identity_projection(projections[1][1])
    _assert_execution_identity_consistent(projections[0][1])
    _assert_execution_identity_consistent(projections[1][1])
    assert projections[0][1].results[next(iter(projections[0][1].source_prepared_mapping["sink"]))].value == 7


@pytest.mark.parametrize(
    "tampered_field",
    [
        "token_id",
        "owner_node_id",
        "reference_id",
        "frame_id",
        "state_id",
        "iteration_path",
        "workflow_call_depth",
        "blank_owner_node_id",
        "blank_frame_id",
        "blank_state_id",
        "mapping_key",
        "both_ids",
    ],
)
def test_rehydrated_if_rejects_tampered_activation_identity(tampered_field: str) -> None:
    """A persisted activation token with stale identity or frame data is rejected."""
    _, partial_state = _run_until_source(GraphExecutionState(graph=_nested_if_graph()), "outer_if")
    snapshot = dump_execution_state(partial_state)
    token_id, token = next(
        (token_id, token)
        for token_id, token in snapshot["execution_tokens"].items()
        if token["token_kind"] == "activation"
    )
    source_if_id = partial_state.prepared_source_mapping[token["owner_node_id"]]

    valid_restored = load_execution_state(snapshot)
    valid_plan = valid_restored._scheduler()._scheduler.plan
    dependency = next(
        dependency
        for plan_node in valid_plan.nodes.values()
        for dependency in plan_node.activation_dependencies
        if dependency.owner_id == source_if_id
    )
    assert valid_restored._is_activation_dependency_satisfied(dependency)
    restored_token = valid_restored.execution_tokens[token_id]
    expected_ref = valid_restored.execution_refs[restored_token.owner_node_id]
    assert restored_token.token_id == token_id == f"{expected_ref.reference_id}:activation:{restored_token.port}"
    assert restored_token.reference_id == expected_ref.reference_id
    assert restored_token.owner_node_id == expected_ref.exec_node_id
    assert restored_token.frame == expected_ref.frame

    stale_snapshot = json.loads(json.dumps(snapshot))
    stale_token = stale_snapshot["execution_tokens"][token_id]
    if tampered_field == "token_id":
        stale_token["token_id"] = "stale-token"
    elif tampered_field == "owner_node_id":
        stale_token["owner_node_id"] = "stale-owner"
    elif tampered_field == "reference_id":
        stale_token["reference_id"] = "stale-reference"
    elif tampered_field == "frame_id":
        stale_token["frame"]["frame_id"] = "stale-frame"
    elif tampered_field == "state_id":
        stale_token["frame"]["state_id"] = "stale-state"
    elif tampered_field == "iteration_path":
        stale_token["frame"]["iteration_path"] = [1]
    elif tampered_field == "workflow_call_depth":
        stale_token["frame"]["workflow_call_depth"] = 1
    elif tampered_field == "blank_owner_node_id":
        stale_token["owner_node_id"] = ""
    elif tampered_field == "blank_frame_id":
        stale_token["frame"]["frame_id"] = ""
    elif tampered_field == "blank_state_id":
        stale_token["frame"]["state_id"] = ""
    elif tampered_field == "mapping_key":
        stale_snapshot["execution_tokens"]["stale-key"] = stale_snapshot["execution_tokens"].pop(token_id)
    else:
        stale_snapshot["execution_tokens"]["stale-key"] = stale_snapshot["execution_tokens"].pop(token_id)
        stale_snapshot["execution_tokens"]["stale-key"]["token_id"] = "stale-key"
    with pytest.raises(ValidationError, match="Activation token|Execution token"):
        load_execution_state(stale_snapshot)


def test_rehydrated_if_rejects_activation_token_with_ghost_owner_and_reference() -> None:
    _, partial_state = _run_until_source(GraphExecutionState(graph=_nested_if_graph()), "outer_if")
    snapshot = dump_execution_state(partial_state)
    token_id, token = next(
        (token_id, token)
        for token_id, token in snapshot["execution_tokens"].items()
        if token["token_kind"] == "activation"
    )
    expected_ref = partial_state._expected_execution_ref(token["owner_node_id"]).model_dump(mode="json")
    ghost_ref = {**expected_ref, "exec_node_id": "ghost", "reference_id": f"{snapshot['id']}:ghost"}
    snapshot["execution_refs"]["ghost"] = ghost_ref
    ghost_token_id = f"{ghost_ref['reference_id']}:activation:{token['port']}"
    ghost_token = {
        **token,
        "token_id": ghost_token_id,
        "reference_id": ghost_ref["reference_id"],
        "owner_node_id": "ghost",
    }
    snapshot["execution_tokens"].pop(token_id)
    snapshot["execution_tokens"][ghost_token_id] = ghost_token

    with pytest.raises(ValidationError, match="Activation token|Execution token"):
        load_execution_state(snapshot)


def test_rehydrated_if_rejects_activation_token_on_invocation_without_declared_field() -> None:
    _, partial_state = _run_until_source(GraphExecutionState(graph=_nested_if_graph()), "outer_if")
    snapshot = dump_execution_state(partial_state)
    ordinary_exec_id = next(
        execution_id
        for execution_id, source_id in partial_state.prepared_source_mapping.items()
        if source_id == "inner_false"
    )
    reference = partial_state._expected_execution_ref(ordinary_exec_id).model_dump(mode="json")
    token_id = f"{reference['reference_id']}:activation:value"
    snapshot["execution_tokens"][token_id] = {
        "token_id": token_id,
        "reference_id": reference["reference_id"],
        "owner_node_id": ordinary_exec_id,
        "port": "value",
        "frame": reference["frame"],
        "value": "value",
        "token_kind": "activation",
    }

    with pytest.raises(ValidationError, match="Activation token|Execution token"):
        load_execution_state(snapshot)


def test_rehydrated_activation_token_allows_unknown_frame_metadata() -> None:
    _, partial_state = _run_until_source(GraphExecutionState(graph=_nested_if_graph()), "outer_if")
    snapshot = dump_execution_state(partial_state)
    token_id, token = next(
        (token_id, token)
        for token_id, token in snapshot["execution_tokens"].items()
        if token["token_kind"] == "activation"
    )
    snapshot["execution_tokens"][token_id]["frame"]["future_frame_metadata"] = "preserved"

    restored = load_execution_state(snapshot)
    assert restored.execution_tokens[token_id].frame.model_extra["future_frame_metadata"] == "preserved"
