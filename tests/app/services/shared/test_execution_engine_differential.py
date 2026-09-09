from __future__ import annotations

import json
from pathlib import Path
from typing import Any
from unittest.mock import Mock, patch

import pytest
from pydantic import ValidationError

from invokeai.app.invocations.call_saved_workflow import CallSavedWorkflowInvocation
from invokeai.app.invocations.collections import CollectionConcatInvocation
from invokeai.app.invocations.logic import IfInvocation
from invokeai.app.invocations.loops import (
    ForInvocation,
    ForReturnInvocation,
    LoopState,
    StateSetInvocation,
)
from invokeai.app.invocations.math import AddInvocation
from invokeai.app.invocations.primitives import BooleanInvocation, BooleanOutput
from invokeai.app.services.shared import graph as graph_module
from invokeai.app.services.shared.execution_state_migration import (
    CURRENT_EXECUTION_STATE_VERSION,
    UnsupportedExecutionStateVersionError,
    dump_execution_state,
    load_execution_state,
)
from invokeai.app.services.shared.graph import (
    CollectInvocation,
    Edge,
    EdgeConnection,
    Graph,
    GraphExecutionState,
    IterateInvocation,
    _ExecutionScheduler,
    _GenericGraphSchedulerAdapter,
)
from invokeai.app.services.shared.invocation_context import InvocationContextData, build_invocation_context
from tests.test_nodes import (
    AnyTypeTestInvocation,
    ErrorInvocation,
    PolymorphicStringTestInvocation,
    UnionCollectionTestInvocation,
    create_edge,
    create_loop_linkage,
)

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


def _flat_if_graph(*, condition: bool = True) -> Graph:
    graph = Graph()
    graph.add_node(BooleanInvocation(id="condition", value=condition))
    graph.add_node(AddInvocation(id="true_branch", a=2, b=3))
    graph.add_node(AddInvocation(id="false_branch", a=10, b=20))
    graph.add_node(IfInvocation(id="if"))
    graph.add_node(AddInvocation(id="sink", b=1))

    def connect(source: str, source_field: str, destination: str, destination_field: str) -> None:
        graph.add_edge(
            Edge(
                source=EdgeConnection(node_id=source, field=source_field),
                destination=EdgeConnection(node_id=destination, field=destination_field),
            )
        )

    connect("condition", "value", "if", "condition")
    connect("true_branch", "value", "if", "true_input")
    connect("false_branch", "value", "if", "false_input")
    connect("if", "value", "sink", "a")
    return graph


def _flat_for_graph(
    *,
    with_after: bool = False,
    collection: list[Any] | None = None,
    input_collection: list[Any] | None = None,
    body_returns_none: bool = False,
) -> Graph:
    graph = Graph()
    collection = [1, 2] if collection is None else collection
    graph.add_node(ForInvocation(id="for", collection=collection))
    if input_collection is not None:
        graph.add_node(AnyTypeTestInvocation(id="collection", value=input_collection))
    graph.add_node(UnionCollectionTestInvocation(id="body") if body_returns_none else AddInvocation(id="body", b=10))
    graph.add_node(ForReturnInvocation(id="return"))
    if with_after:
        graph.add_node(AnyTypeTestInvocation(id="after"))
    if input_collection is not None:
        graph.add_edge(
            Edge(
                source=EdgeConnection(node_id="collection", field="value"),
                destination=EdgeConnection(node_id="for", field="collection"),
            )
        )
    graph.add_edge(
        Edge(
            source=EdgeConnection(node_id="for", field="item"),
            destination=EdgeConnection(node_id="body", field="value" if body_returns_none else "a"),
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


def _nested_for_graph(*, outer_collection: list[list[str]] | None = None) -> Graph:
    graph = Graph()
    graph.add_node(
        ForInvocation(id="outer_for", collection=[["a", "b"], ["c"]] if outer_collection is None else outer_collection)
    )
    graph.add_node(ForInvocation(id="inner_for"))
    graph.add_node(AnyTypeTestInvocation(id="inner_body"))
    graph.add_node(ForReturnInvocation(id="inner_return"))
    graph.add_node(ForReturnInvocation(id="outer_return"))
    graph.add_node(AnyTypeTestInvocation(id="after"))

    def connect(source: str, source_field: str, destination: str, destination_field: str) -> None:
        graph.add_edge(
            Edge(
                source=EdgeConnection(node_id=source, field=source_field),
                destination=EdgeConnection(node_id=destination, field=destination_field),
            )
        )

    connect("outer_for", "item", "inner_for", "collection")
    connect("inner_for", "item", "inner_body", "value")
    connect("inner_body", "value", "inner_return", "output")
    connect("inner_for", "output_collection", "outer_return", "output")
    connect("outer_for", "output_collection", "after", "value")
    graph.add_edge(create_loop_linkage("outer_for", "outer_return"))
    graph.add_edge(create_loop_linkage("inner_for", "inner_return"))
    return graph


def _nested_for_iterate_collect_graph(*, outer_collection: list[list[str]] | None = None) -> Graph:
    graph = Graph()
    graph.add_node(ForInvocation(id="outer_for", collection=outer_collection or [["a", "b"], ["c"]]))
    graph.add_node(PolymorphicStringTestInvocation(id="nested_collection"))
    graph.add_node(IterateInvocation(id="nested_iterate"))
    graph.add_node(AnyTypeTestInvocation(id="nested_body"))
    graph.add_node(CollectInvocation(id="nested_collect"))
    graph.add_node(ForReturnInvocation(id="outer_return"))
    graph.add_node(AnyTypeTestInvocation(id="after"))

    def connect(source: str, source_field: str, destination: str, destination_field: str) -> None:
        graph.add_edge(
            Edge(
                source=EdgeConnection(node_id=source, field=source_field),
                destination=EdgeConnection(node_id=destination, field=destination_field),
            )
        )

    connect("outer_for", "item", "nested_collection", "value")
    connect("nested_collection", "collection", "nested_iterate", "collection")
    connect("nested_iterate", "item", "nested_body", "value")
    connect("nested_body", "value", "nested_collect", "item")
    connect("nested_collect", "collection", "outer_return", "output")
    connect("outer_for", "output_collection", "after", "value")
    graph.add_edge(create_loop_linkage("outer_for", "outer_return"))
    return graph


def _direct_iterate_body_collect_graph(*, collection: list[Any] | None = None, with_after: bool = False) -> Graph:
    graph = Graph()
    graph.add_node(CollectionConcatInvocation(id="source", first=[] if collection is None else collection))
    graph.add_node(IterateInvocation(id="iterate"))
    graph.add_node(AnyTypeTestInvocation(id="body"))
    graph.add_node(CollectInvocation(id="collect"))
    graph.add_edge(
        Edge(
            source=EdgeConnection(node_id="source", field="collection"),
            destination=EdgeConnection(node_id="iterate", field="collection"),
        )
    )
    graph.add_edge(
        Edge(
            source=EdgeConnection(node_id="iterate", field="item"),
            destination=EdgeConnection(node_id="body", field="value"),
        )
    )
    graph.add_edge(
        Edge(
            source=EdgeConnection(node_id="body", field="value"),
            destination=EdgeConnection(node_id="collect", field="item"),
        )
    )
    if with_after:
        graph.add_node(AnyTypeTestInvocation(id="after"))
        graph.add_edge(
            Edge(
                source=EdgeConnection(node_id="collect", field="collection"),
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


def _run_graph_with_effects(
    state: GraphExecutionState,
    *,
    force_compatibility_scheduler: bool = False,
    stop_after_source: str | None = None,
    fail_source_id: str | None = None,
    stop_after: int | None = None,
) -> tuple[list[str], GraphExecutionState]:
    """Run a graph through the same invocation/effect/apply path as the session runner."""
    if force_compatibility_scheduler:
        state._execution_scheduler = _ExecutionScheduler(state)

    services = Mock()
    services.invocation_cache.get.return_value = None
    trace: list[str] = []
    while (node := state.next()) is not None:
        source_id = state.prepared_source_mapping[node.id]
        trace.append(source_id)
        execution_ref = state.get_execution_ref(node.id)
        context = build_invocation_context(
            services=services,
            data=InvocationContextData(
                queue_item=None,  # type: ignore[arg-type]
                invocation=node,
                source_invocation_id=source_id,
                execution_frame=execution_ref.frame.iteration_path,
                execution_state_id=execution_ref.state_id,
                execution_frame_id=execution_ref.frame.frame_id,
                execution_workflow_call_depth=execution_ref.frame.workflow_call_depth,
            ),
            is_canceled=lambda: False,
        )
        try:
            if source_id == fail_source_id:
                with patch.object(
                    type(node),
                    "invoke_internal_with_effects",
                    side_effect=RuntimeError("injected failure"),
                ):
                    run_result = node.invoke_internal_with_effects(context, services)
            else:
                run_result = node.invoke_internal_with_effects(context, services)
        except RuntimeError as exc:
            state.set_node_error(node.id, str(exc))
            break
        state.apply(state.get_execution_ref(node.id, effect_count=len(run_result.effects)), run_result)
        if stop_after_source == source_id:
            break
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
    def json_projection(value: Any) -> str:
        if hasattr(value, "model_dump"):
            value = value.model_dump(mode="json")
        return json.dumps(value, sort_keys=True)

    def normalize_effect_identity(value: Any) -> Any:
        if hasattr(value, "model_dump"):
            value = value.model_dump(mode="json", warnings=False)
        if isinstance(value, dict):
            return {
                key: normalize_effect_identity(item)
                for key, item in value.items()
                if key
                not in {
                    "state_id",
                    "execution_node_id",
                    "frame_id",
                    "reference_id",
                    "template_node_id",
                    "token",
                }
            }
        if isinstance(value, list):
            return [normalize_effect_identity(item) for item in value]
        return value

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
                json_projection(token.value),
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
                    [normalize_effect_identity(effect) for effect in effect_values],
                    sort_keys=True,
                ),
            )
            for reference_id, effect_values in state.execution_effects.items()
        )
    )
    return references, tokens, effects


def _continuation_projection(state: GraphExecutionState) -> tuple[Any, ...]:
    return tuple(
        sorted(
            (
                state.prepared_source_mapping.get(continuation.owner_id, continuation.owner_id),
                continuation.kind,
                continuation.status,
                tuple(continuation.frame.iteration_path),
                continuation.frame.workflow_call_depth,
                json.dumps(continuation.payload, sort_keys=True),
                json.dumps(continuation.result, sort_keys=True),
                continuation.error,
            )
            for continuation in state._generic_runtime().continuations.values()
        )
    )


def _final_for_output(state: GraphExecutionState) -> Any:
    final_for_id = max(
        (
            exec_node_id
            for exec_node_id, source_node_id in state.prepared_source_mapping.items()
            if source_node_id == "for"
        ),
        key=lambda exec_node_id: state.execution_graph.get_node(exec_node_id).index,
    )
    return state.results[final_for_id]


def _source_output(state: GraphExecutionState, source_id: str) -> Any:
    execution_id = next(
        execution_id
        for execution_id, prepared_source_id in state.prepared_source_mapping.items()
        if prepared_source_id == source_id and execution_id in state.results
    )
    return state.results[execution_id]


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


def _effect_ledger_projection(state: GraphExecutionState) -> tuple[Any, ...]:
    """Compare persisted effects while ignoring generated state/reference IDs."""

    def normalized(value: Any) -> Any:
        if hasattr(value, "model_dump"):
            value = value.model_dump(mode="json")
        if isinstance(value, dict):
            return tuple(
                sorted(
                    (key, normalized(item))
                    for key, item in value.items()
                    if key
                    not in {
                        "state_id",
                        "execution_node_id",
                        "frame_id",
                        "reference_id",
                        "template_node_id",
                        "token",
                    }
                )
            )
        if isinstance(value, list):
            return tuple(normalized(item) for item in value)
        return value

    return tuple(
        sorted(
            (
                next(
                    (
                        state.prepared_source_mapping.get(exec_node_id, exec_node_id)
                        for exec_node_id, reference in state.execution_refs.items()
                        if reference.reference_id == reference_id
                    ),
                    reference_id,
                ),
                normalized(effects),
            )
            for reference_id, effects in state.execution_effects.items()
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
    """Project the live execution graph for either scheduler adapter."""
    del force_compatibility_scheduler
    live_edges = {("outer_condition", "value", "outer_if", "condition", "default")}
    if outer_condition:
        live_edges.add(("inner_condition", "value", "inner_if", "condition", "default"))
        live_edges.add(
            (
                "inner_true" if inner_condition else "inner_false",
                "value",
                "inner_if",
                "true_input" if inner_condition else "false_input",
                "default",
            )
        )
        live_edges.add(("inner_if", "value", "outer_if", "true_input", "default"))
    else:
        live_edges.add(("outer_false", "value", "outer_if", "false_input", "default"))
    live_edges.add(("outer_if", "value", "sink", "a", "default"))
    return tuple(sorted(live_edges))


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
    """Calculate remaining indegrees from an independent source-graph oracle."""
    expected_edges = _expected_edge_projection(
        state.graph,
        force_compatibility_scheduler=force_compatibility_scheduler,
        outer_condition=outer_condition,
        inner_condition=inner_condition,
    )
    prepared_by_source = {
        source_id: sorted(
            prepared_ids,
            key=lambda exec_id: (state._get_iteration_path(exec_id), exec_id),
        )
        for source_id, prepared_ids in state.source_prepared_mapping.items()
    }
    return {
        execution_id: sum(
            source_exec_id not in state.executed
            for source_id, _source_field, destination_id, _destination_field, _edge_type in expected_edges
            if destination_id == state.prepared_source_mapping[execution_id]
            for source_exec_id in prepared_by_source.get(source_id, ())
            if state._get_iteration_path(source_exec_id) == state._get_iteration_path(execution_id)
            and not (
                isinstance(state.execution_graph.get_node(execution_id), IfInvocation)
                and isinstance(state.execution_graph.get_node(source_exec_id), IfInvocation)
                and source_exec_id not in state.executed
            )
        )
        for execution_id in state.prepared_source_mapping
    }


def _assert_execution_identity_consistent(state: GraphExecutionState) -> None:
    def value_from_object(value: Any, *names: str) -> Any:
        if isinstance(value, dict):
            for name in names:
                if name in value:
                    return value[name]
            return None
        for name in names:
            candidate = getattr(value, name, None)
            if candidate is not None:
                return candidate
        return None

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
    references_by_id = {reference.reference_id: reference for reference in state.execution_refs.values()}
    for reference_id, effects in state.execution_effects.items():
        reference = references_by_id[reference_id]
        for effect in effects:
            effect_reference = value_from_object(
                effect,
                "execution_ref",
                "execution_reference",
                "owner_ref",
                "owner",
            )
            assert effect_reference is not None
            assert value_from_object(effect_reference, "state_id", "session_id") == reference.state_id
            assert value_from_object(effect_reference, "execution_node_id", "node_id") == reference.exec_node_id
            assert value_from_object(effect_reference, "frame_id") == reference.frame.frame_id
            assert tuple(value_from_object(effect_reference, "frame_path", "iteration_path") or ()) == tuple(
                reference.frame.iteration_path
            )
            assert value_from_object(effect_reference, "workflow_call_depth", "call_depth", "depth") == (
                reference.frame.workflow_call_depth
            )


def _assert_generic_and_compatibility_schedulers(
    generic_state: GraphExecutionState, compatibility_state: GraphExecutionState
) -> None:
    assert isinstance(generic_state._execution_scheduler, _GenericGraphSchedulerAdapter)
    assert isinstance(compatibility_state._execution_scheduler, _ExecutionScheduler)


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
    _assert_generic_and_compatibility_schedulers(generic_state, compatibility_state)
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
    generic_trace, generic_state = _run_graph_with_effects(GraphExecutionState(graph=_flat_for_graph()))
    compatibility_trace, compatibility_state = _run_graph_with_effects(
        GraphExecutionState(graph=_flat_for_graph()),
        force_compatibility_scheduler=True,
    )

    assert generic_trace == compatibility_trace == ["for", "body", "return", "for", "body", "return"]
    assert _state_projection(generic_state) == _state_projection(compatibility_state)
    assert generic_state.is_complete()
    assert compatibility_state.is_complete()
    _assert_generic_and_compatibility_schedulers(generic_state, compatibility_state)
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
    expected_continuations = [
        (
            (0,),
            "completed",
            {"index": 0, "total": 2, "state": {"values": {}}},
            {"output": 11, "state": None, "continue_condition": True},
        ),
        (
            (1,),
            "completed",
            {"index": 1, "total": 2, "state": {"values": {}}},
            {"output": 12, "state": None, "continue_condition": True},
        ),
    ]
    expected_effects = [
        ("start", {"index": 0, "total": 2, "state": {"values": {}}}),
        ("complete", {"output": 11, "state": None, "continue_condition": True}),
        ("start", {"index": 1, "total": 2, "state": {"values": {}}}),
        ("complete", {"output": 12, "state": None, "continue_condition": True}),
    ]
    for state in (generic_state, compatibility_state):
        assert [
            (tuple(continuation.frame.iteration_path), continuation.status, continuation.payload, continuation.result)
            for continuation in sorted(
                state._generic_runtime().continuations.values(),
                key=lambda continuation: continuation.frame.iteration_path,
            )
        ] == expected_continuations
        actual_effects = [
            (effect.operation, effect.payload)
            for effects in state.execution_effects.values()
            for effect in effects
            if effect.kind == "continuation"
        ]
        assert sorted(actual_effects, key=lambda item: (item[0], json.dumps(item[1], sort_keys=True))) == sorted(
            expected_effects, key=lambda item: (item[0], json.dumps(item[1], sort_keys=True))
        )
        assert _final_for_output(state).output_collection == [11, 12]
    assert isinstance(compatibility_state._execution_scheduler, _ExecutionScheduler)


def test_flat_for_generic_path_does_not_use_compatibility_continuation_bridge(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    def fail_compatibility_bridge(*_: object, **__: object) -> None:
        raise AssertionError("generic For execution used the compatibility continuation bridge")

    monkeypatch.setattr(GraphExecutionState, "_try_schedule_next_for_iteration", fail_compatibility_bridge)

    trace, state = _run_graph_with_effects(GraphExecutionState(graph=_flat_for_graph()))

    assert trace == ["for", "body", "return", "for", "body", "return"]
    assert state.is_complete()
    assert _final_for_output(state).output_collection == [11, 12]


def test_nested_for_generic_and_compatibility_paths_have_matching_completion() -> None:
    def run(force_compatibility: bool) -> tuple[list[str], GraphExecutionState]:
        state = GraphExecutionState(graph=_nested_for_graph())
        if force_compatibility:
            state._execution_scheduler = _ExecutionScheduler(state)
        return _run(state)

    compatibility_trace, compatibility_state = run(force_compatibility=True)
    generic_trace, generic_state = run(force_compatibility=False)

    assert generic_trace == compatibility_trace
    assert generic_state.is_complete()
    assert compatibility_state.is_complete()
    assert isinstance(generic_state._execution_scheduler, _GenericGraphSchedulerAdapter)
    assert isinstance(compatibility_state._execution_scheduler, _ExecutionScheduler)
    assert _state_projection(generic_state) == _state_projection(compatibility_state)
    after_exec_id = next(
        exec_node_id
        for exec_node_id, source_node_id in generic_state.prepared_source_mapping.items()
        if source_node_id == "after"
    )
    assert generic_state.results[after_exec_id].value == [["a", "b"], ["c"]]
    compatibility_after_exec_id = next(
        exec_node_id
        for exec_node_id, source_node_id in compatibility_state.prepared_source_mapping.items()
        if source_node_id == "after"
    )
    assert compatibility_state.results[compatibility_after_exec_id].value == [["a", "b"], ["c"]]


def test_nested_for_generic_and_compatibility_paths_handle_empty_inner_collection() -> None:
    def run(force_compatibility: bool) -> tuple[list[str], GraphExecutionState]:
        state = GraphExecutionState(graph=_nested_for_graph(outer_collection=[[], ["c"]]))
        if force_compatibility:
            state._execution_scheduler = _ExecutionScheduler(state)
        return _run(state)

    compatibility_trace, compatibility_state = run(force_compatibility=True)
    generic_trace, generic_state = run(force_compatibility=False)

    assert generic_trace == compatibility_trace
    assert generic_state.is_complete()
    assert compatibility_state.is_complete()
    # Empty inner iterations use different synthetic execution-node projections, but must preserve trace and outputs.
    after_exec_id = next(
        exec_node_id
        for exec_node_id, source_node_id in generic_state.prepared_source_mapping.items()
        if source_node_id == "after"
    )
    assert generic_state.results[after_exec_id].value == [[], ["c"]]
    compatibility_after_exec_id = next(
        exec_node_id
        for exec_node_id, source_node_id in compatibility_state.prepared_source_mapping.items()
        if source_node_id == "after"
    )
    assert compatibility_state.results[compatibility_after_exec_id].value == [[], ["c"]]


def test_nested_for_generic_path_rehydrates_after_inner_completion() -> None:
    expected_state = GraphExecutionState(graph=_nested_for_graph())
    expected_state._execution_scheduler = _ExecutionScheduler(expected_state)
    expected_trace, expected_state = _run(expected_state)
    assert expected_trace == [
        "outer_for",
        "inner_for",
        "inner_body",
        "inner_return",
        "inner_for",
        "inner_body",
        "inner_return",
        "outer_return",
        "outer_for",
        "inner_for",
        "inner_body",
        "inner_return",
        "outer_return",
        "after",
    ]

    state = GraphExecutionState(graph=_nested_for_graph())
    state._execution_scheduler = _GenericGraphSchedulerAdapter(state)
    partial_trace, partial_state = _run(state, stop_after=4)
    assert partial_trace == ["outer_for", "inner_for", "inner_body", "inner_return"]

    restored = load_execution_state(dump_execution_state(partial_state))
    restored._execution_scheduler = _GenericGraphSchedulerAdapter(restored)
    resumed_trace, resumed_state = _run(restored)

    assert resumed_trace == [
        "inner_for",
        "inner_body",
        "inner_return",
        "outer_return",
        "outer_for",
        "inner_for",
        "inner_body",
        "inner_return",
        "outer_return",
        "after",
    ]
    assert resumed_state.is_complete()
    assert _state_projection(resumed_state) == _state_projection(expected_state)

    compatibility_partial = GraphExecutionState(graph=_nested_for_graph())
    compatibility_partial._execution_scheduler = _ExecutionScheduler(compatibility_partial)
    _, compatibility_partial = _run(compatibility_partial, stop_after=4)
    compatibility_restored = load_execution_state(dump_execution_state(compatibility_partial))
    compatibility_restored._execution_scheduler = _ExecutionScheduler(compatibility_restored)
    compatibility_resumed_trace, compatibility_resumed = _run(compatibility_restored)
    assert compatibility_resumed_trace == resumed_trace
    assert _state_projection(compatibility_resumed) == _state_projection(expected_state)


def test_nested_for_iterate_collect_generic_and_compatibility_paths_have_matching_completion() -> None:
    compatibility_state = GraphExecutionState(graph=_nested_for_iterate_collect_graph())
    compatibility_trace, compatibility_state = _run(
        compatibility_state,
        force_compatibility_scheduler=True,
    )
    generic_state = GraphExecutionState(graph=_nested_for_iterate_collect_graph())
    generic_trace, generic_state = _run(generic_state)

    assert (
        generic_trace
        == compatibility_trace
        == [
            "outer_for",
            "nested_collection",
            "nested_iterate",
            "nested_iterate",
            "nested_body",
            "nested_body",
            "nested_collect",
            "outer_return",
            "outer_for",
            "nested_collection",
            "nested_iterate",
            "nested_body",
            "nested_collect",
            "outer_return",
            "after",
        ]
    )
    assert generic_state.is_complete()
    assert compatibility_state.is_complete()
    assert isinstance(generic_state._execution_scheduler, _GenericGraphSchedulerAdapter)
    assert isinstance(compatibility_state._execution_scheduler, _ExecutionScheduler)
    assert _state_projection(generic_state) == _state_projection(compatibility_state)
    for state in (generic_state, compatibility_state):
        after_exec_id = next(
            exec_node_id
            for exec_node_id, source_node_id in state.prepared_source_mapping.items()
            if source_node_id == "after"
        )
        assert state.results[after_exec_id].value == [["a", "b"], ["c"]]


def test_nested_for_iterate_collect_generic_handles_empty_inner_collection() -> None:
    compatibility_state = GraphExecutionState(graph=_nested_for_iterate_collect_graph(outer_collection=[[], ["c"]]))
    compatibility_trace, compatibility_state = _run(
        compatibility_state,
        force_compatibility_scheduler=True,
    )
    generic_state = GraphExecutionState(graph=_nested_for_iterate_collect_graph(outer_collection=[[], ["c"]]))
    generic_trace, generic_state = _run(generic_state)

    assert generic_trace == compatibility_trace
    assert generic_state.is_complete()
    assert compatibility_state.is_complete()
    assert isinstance(generic_state._execution_scheduler, _GenericGraphSchedulerAdapter)
    assert isinstance(compatibility_state._execution_scheduler, _ExecutionScheduler)
    for state in (generic_state, compatibility_state):
        after_exec_id = next(
            exec_node_id
            for exec_node_id, source_node_id in state.prepared_source_mapping.items()
            if source_node_id == "after"
        )
        assert state.results[after_exec_id].value == [[], ["c"]]


def test_nested_for_iterate_collect_generic_rehydrates_after_inner_completion() -> None:
    expected_state = GraphExecutionState(graph=_nested_for_iterate_collect_graph())
    expected_state._execution_scheduler = _ExecutionScheduler(expected_state)
    expected_trace, expected_state = _run(expected_state)

    state = GraphExecutionState(graph=_nested_for_iterate_collect_graph())
    state._execution_scheduler = _GenericGraphSchedulerAdapter(state)
    partial_trace, partial_state = _run(state, stop_after=3)
    restored = load_execution_state(dump_execution_state(partial_state))
    resumed_trace, resumed_state = _run(restored)

    assert partial_trace + resumed_trace == expected_trace
    assert resumed_state.is_complete()
    assert isinstance(resumed_state._execution_scheduler, _GenericGraphSchedulerAdapter)
    assert _state_projection(resumed_state) == _state_projection(expected_state)


def test_direct_iterate_body_collect_fresh_execution_preserves_order_and_none() -> None:
    collection = ["first", None, "last"]
    state = GraphExecutionState(graph=_direct_iterate_body_collect_graph(collection=collection))

    with (
        patch.object(
            graph_module._ExecutionMaterializer,
            "prepare",
            side_effect=AssertionError("canonical Iterate -> body -> Collect must not use materializer.prepare"),
        ) as prepare,
        patch.object(
            graph_module._ExecutionMaterializer,
            "_get_collect_iteration_mapping_groups",
            side_effect=AssertionError("canonical Iterate -> body -> Collect must not group collector inputs"),
        ) as group_collector_inputs,
    ):
        trace, state = _run_graph(state)

    assert trace.count("iterate") == len(collection)
    assert trace.count("body") == len(collection)
    assert trace.count("collect") == 1
    assert _source_output(state, "collect").collection == collection
    assert state.is_complete()
    assert isinstance(state._execution_scheduler, _GenericGraphSchedulerAdapter)
    prepare.assert_not_called()
    group_collector_inputs.assert_not_called()


def test_direct_iterate_body_collect_fresh_execution_handles_empty_input() -> None:
    state = GraphExecutionState(graph=_direct_iterate_body_collect_graph(collection=[]))
    with (
        patch.object(
            graph_module._ExecutionMaterializer,
            "prepare",
            side_effect=AssertionError("canonical empty Iterate -> body -> Collect must not use materializer.prepare"),
        ) as prepare,
        patch.object(
            graph_module._ExecutionMaterializer,
            "_get_collect_iteration_mapping_groups",
            side_effect=AssertionError("canonical empty Iterate -> body -> Collect must not group collector inputs"),
        ) as group_collector_inputs,
    ):
        trace, state = _run_graph(state)

    assert "iterate" not in trace
    assert "body" not in trace
    assert trace[-1] == "collect"
    assert _source_output(state, "collect").collection == []
    assert state.is_complete()
    prepare.assert_not_called()
    group_collector_inputs.assert_not_called()


def test_direct_iterate_body_collect_planner_rolls_back_partial_expansion(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    state = GraphExecutionState(graph=_direct_iterate_body_collect_graph(collection=["first", "last"]))
    source_node = state.next()
    assert source_node is not None
    state.complete(source_node.id, source_node.invoke(Mock()))

    original_create = GraphExecutionState._create_direct_execution_node_copy
    failed = False

    def fail_after_body(self: GraphExecutionState, source_node_id: str, *args: Any, **kwargs: Any):
        nonlocal failed
        node = original_create(self, source_node_id, *args, **kwargs)
        if source_node_id == "body" and not failed:
            failed = True
            raise RuntimeError("injected direct planner failure")
        return node

    monkeypatch.setattr(GraphExecutionState, "_create_direct_execution_node_copy", fail_after_body)
    with pytest.raises(RuntimeError, match="injected direct planner failure"):
        state.next()

    assert set(state.source_prepared_mapping) == {"source"}
    assert len(state.execution_graph.nodes) == 1
    assert not state.execution_graph.edges

    monkeypatch.setattr(GraphExecutionState, "_create_direct_execution_node_copy", original_create)
    trace, state = _run(state)

    assert trace == ["iterate", "iterate", "body", "body", "collect"]
    assert _source_output(state, "collect").collection == ["first", "last"]
    assert state.is_complete()


def test_direct_iterate_body_collect_downstream_planner_rolls_back_partial_expansion(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    state = GraphExecutionState(graph=_direct_iterate_body_collect_graph(collection=["first", "last"], with_after=True))
    source_node = state.next()
    assert source_node is not None
    state.complete(source_node.id, source_node.invoke(Mock()))

    original_create = GraphExecutionState._create_direct_execution_node_copy

    def fail_at_downstream(self: GraphExecutionState, source_node_id: str, *args: Any, **kwargs: Any):
        if source_node_id == "after":
            raise RuntimeError("injected downstream planner failure")
        return original_create(self, source_node_id, *args, **kwargs)

    monkeypatch.setattr(GraphExecutionState, "_create_direct_execution_node_copy", fail_at_downstream)
    with pytest.raises(RuntimeError, match="injected downstream planner failure"):
        state.next()

    assert set(state.source_prepared_mapping) == {"source"}
    assert len(state.execution_graph.nodes) == 1
    assert not state.execution_graph.edges

    monkeypatch.setattr(GraphExecutionState, "_create_direct_execution_node_copy", original_create)
    trace, state = _run_graph(state)

    assert trace == ["iterate", "iterate", "body", "body", "collect", "after"]
    assert _source_output(state, "after").value == ["first", "last"]
    assert state.is_complete()


@pytest.mark.parametrize(
    "collection",
    [
        ["first", None, "last"],
        [],
    ],
    ids=["ordered-values-including-none", "empty"],
)
def test_direct_iterate_body_collect_matches_forced_compatibility_scheduler(collection: list[Any]) -> None:
    generic_trace, generic_state = _run_graph(
        GraphExecutionState(graph=_direct_iterate_body_collect_graph(collection=collection))
    )
    compatibility_trace, compatibility_state = _run_graph(
        GraphExecutionState(graph=_direct_iterate_body_collect_graph(collection=collection)),
        force_compatibility_scheduler=True,
    )

    assert generic_trace == compatibility_trace
    assert _source_output(generic_state, "collect").collection == collection
    assert _source_output(compatibility_state, "collect").collection == collection
    assert generic_state.is_complete()
    assert compatibility_state.is_complete()
    assert isinstance(generic_state._execution_scheduler, _GenericGraphSchedulerAdapter)
    assert isinstance(compatibility_state._execution_scheduler, _ExecutionScheduler)
    assert _state_projection(generic_state) == _state_projection(compatibility_state)


@pytest.mark.parametrize("force_compatibility_scheduler", [False, True])
def test_direct_iterate_body_collect_partial_dump_load_resume_matches_fresh_execution(
    force_compatibility_scheduler: bool,
) -> None:
    collection = ["first", None, "last"]
    expected_trace, expected_state = _run_graph(
        GraphExecutionState(graph=_direct_iterate_body_collect_graph(collection=collection)),
        force_compatibility_scheduler=force_compatibility_scheduler,
    )
    partial_trace, partial_state = _run_graph(
        GraphExecutionState(graph=_direct_iterate_body_collect_graph(collection=collection)),
        force_compatibility_scheduler=force_compatibility_scheduler,
        stop_after=2,
    )

    restored = load_execution_state(dump_execution_state(partial_state))
    if force_compatibility_scheduler:
        _restore_compatibility_scheduler(restored)
    resumed_trace, resumed_state = _run_graph(
        restored,
        force_compatibility_scheduler=force_compatibility_scheduler,
    )

    assert partial_trace + resumed_trace == expected_trace
    assert _source_output(resumed_state, "collect").collection == collection
    assert resumed_state.is_complete()
    assert _state_projection(resumed_state) == _state_projection(expected_state)
    if force_compatibility_scheduler:
        assert isinstance(resumed_state._execution_scheduler, _ExecutionScheduler)
    else:
        assert isinstance(resumed_state._execution_scheduler, _GenericGraphSchedulerAdapter)


def test_direct_iterate_body_collect_empty_checkpoint_rehydrates_without_materializer() -> None:
    _partial_trace, partial_state = _run_graph(
        GraphExecutionState(graph=_direct_iterate_body_collect_graph(collection=[])), stop_after=1
    )
    with (
        patch.object(
            graph_module._ExecutionMaterializer,
            "prepare",
            side_effect=AssertionError("empty canonical checkpoint must not use materializer.prepare"),
        ) as prepare,
        patch.object(
            graph_module._ExecutionMaterializer,
            "_get_collect_iteration_mapping_groups",
            side_effect=AssertionError("empty canonical checkpoint must not group collector inputs"),
        ) as group_collector_inputs,
    ):
        resumed_trace, resumed_state = _run_graph(load_execution_state(dump_execution_state(partial_state)))

    assert resumed_trace == ["collect"]
    assert _source_output(resumed_state, "collect").collection == []
    assert resumed_state.is_complete()
    prepare.assert_not_called()
    group_collector_inputs.assert_not_called()


def test_direct_iterate_body_collect_failure_rehydrates_pending_state_without_replanning() -> None:
    trace, failed_state = _run_graph(
        GraphExecutionState(graph=_direct_iterate_body_collect_graph(collection=["first", "last"])),
        fail_source_id="body",
    )
    assert trace[0] == "source"
    assert trace.count("iterate") == 2
    assert trace[-1] == "body"
    assert failed_state.has_error()

    restored = load_execution_state(dump_execution_state(failed_state))
    assert restored.has_error()
    assert restored.source_prepared_mapping.get("collect")
    assert restored.is_complete()


def test_direct_iterate_body_collect_with_downstream_consumer_uses_private_planner() -> None:
    with (
        patch.object(
            graph_module._ExecutionMaterializer,
            "prepare",
            side_effect=AssertionError("direct Iterate -> body -> Collect -> after must not use materializer.prepare"),
        ) as prepare,
        patch.object(
            graph_module._ExecutionMaterializer,
            "_get_collect_iteration_mapping_groups",
            side_effect=AssertionError("direct downstream Collect must not group collector inputs"),
        ) as group_collector_inputs,
    ):
        trace, state = _run_graph(
            GraphExecutionState(graph=_direct_iterate_body_collect_graph(collection=["value"], with_after=True))
        )

    assert trace[-1] == "after"
    assert _source_output(state, "after").value == ["value"]
    assert state.is_complete()
    prepare.assert_not_called()
    group_collector_inputs.assert_not_called()


def test_direct_iterate_body_collect_with_downstream_consumer_matches_forced_compatibility_scheduler() -> None:
    generic_trace, generic_state = _run_graph(
        GraphExecutionState(
            graph=_direct_iterate_body_collect_graph(collection=["first", None, "last"], with_after=True)
        )
    )
    compatibility_trace, compatibility_state = _run_graph(
        GraphExecutionState(
            graph=_direct_iterate_body_collect_graph(collection=["first", None, "last"], with_after=True)
        ),
        force_compatibility_scheduler=True,
    )

    assert generic_trace == compatibility_trace
    assert generic_trace[-2:] == ["collect", "after"]
    assert _source_output(generic_state, "after").value == ["first", None, "last"]
    assert _source_output(compatibility_state, "after").value == ["first", None, "last"]
    assert generic_state.is_complete()
    assert compatibility_state.is_complete()
    assert _state_projection(generic_state) == _state_projection(compatibility_state)


def test_direct_flat_for_completion_persists_continuations_and_final_tokens() -> None:
    trace, state = _run(GraphExecutionState(graph=_flat_for_graph()))

    assert trace == ["for", "body", "return", "for", "body", "return"]
    snapshot = dump_execution_state(state)
    restored = load_execution_state(snapshot)
    final_for_id = max(
        state.source_prepared_mapping["for"],
        key=lambda exec_node_id: state.execution_graph.get_node(exec_node_id).index,
    )
    final_ref = state.execution_refs[final_for_id]
    final_output = state.results[final_for_id]
    output_collection_token_id = f"{final_ref.reference_id}:output_collection"
    final_state_token_id = f"{final_ref.reference_id}:final_state"

    assert snapshot["execution_effects"]
    assert state.execution_tokens[output_collection_token_id].value == final_output.output_collection == [11, 12]
    assert state.execution_tokens[final_state_token_id].value == final_output.final_state
    assert restored.execution_tokens[output_collection_token_id].value == [11, 12]
    assert restored.execution_tokens[final_state_token_id].value == final_output.final_state.model_dump(mode="json")
    assert sorted(
        (effect.operation, effect.continuation_kind)
        for effects in state.execution_effects.values()
        for effect in effects
        if effect.kind == "continuation"
    ) == [("complete", "for"), ("complete", "for"), ("start", "for"), ("start", "for")]
    assert restored.is_complete()


def test_legacy_flat_for_snapshot_uses_compatibility_scheduler() -> None:
    _trace, partial_state = _run_graph_with_effects(
        GraphExecutionState(graph=_flat_for_graph()),
        stop_after=1,
    )
    snapshot = dump_execution_state(partial_state)
    snapshot.pop("execution_state_version")
    snapshot.pop("execution_effects")

    restored = load_execution_state(snapshot)
    migrated = load_execution_state(dump_execution_state(restored))

    assert isinstance(restored._scheduler(), _ExecutionScheduler)
    remaining_trace, restored = _run(restored)
    migrated_trace, migrated = _run(migrated)
    assert remaining_trace == ["body", "return", "for", "body", "return"]
    assert migrated_trace == remaining_trace
    assert restored.is_complete()
    assert migrated.is_complete()
    assert _final_for_output(restored).output_collection == [11, 12]
    assert _final_for_output(migrated).output_collection == [11, 12]


def test_terminal_legacy_flat_for_snapshot_can_be_resaved_and_reloaded() -> None:
    _trace, state = _run_graph_with_effects(GraphExecutionState(graph=_flat_for_graph()))
    snapshot = dump_execution_state(state)
    snapshot.pop("execution_state_version")
    snapshot.pop("execution_effects")

    restored = load_execution_state(snapshot)
    migrated = load_execution_state(dump_execution_state(restored))

    assert restored.execution_effects == {}
    assert migrated.is_complete()
    assert _final_for_output(migrated).output_collection == [11, 12]


def test_failed_direct_completion_does_not_persist_a_reference() -> None:
    graph = Graph()
    graph.add_node(AddInvocation(id="add", a=1, b=2))
    state = GraphExecutionState(graph=graph)
    node = state.next()
    assert isinstance(node, AddInvocation)
    before = dump_execution_state(state)

    with pytest.raises(TypeError, match="does not belong to execution node"):
        state.complete(node.id, BooleanOutput(value=True))

    assert dump_execution_state(state) == before


def test_flat_for_fresh_execution_releases_after_loop_consumer() -> None:
    generic_trace, generic_state = _run_graph_with_effects(
        GraphExecutionState(graph=_flat_for_graph(with_after=True)),
    )
    compatibility_trace, compatibility_state = _run_graph_with_effects(
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
    _assert_generic_and_compatibility_schedulers(generic_state, compatibility_state)


def test_flat_for_none_output_matches_compatibility_scheduler() -> None:
    graph = _flat_for_graph(collection=[None, None], body_returns_none=True)
    generic_trace, generic_state = _run_graph_with_effects(GraphExecutionState(graph=graph.model_copy(deep=True)))
    compatibility_trace, compatibility_state = _run_graph_with_effects(
        GraphExecutionState(graph=graph.model_copy(deep=True)),
        force_compatibility_scheduler=True,
    )

    assert generic_trace == compatibility_trace == ["for", "body", "return", "for", "body", "return"]
    assert _final_for_output(generic_state).output_collection == [None, None]
    assert _final_for_output(compatibility_state).output_collection == [None, None]
    assert _state_projection(generic_state) == _state_projection(compatibility_state)
    assert _execution_identity_projection(generic_state) == _execution_identity_projection(compatibility_state)
    _assert_generic_and_compatibility_schedulers(generic_state, compatibility_state)


def test_flat_for_apply_path_matches_compatibility_scheduler() -> None:
    generic_trace, generic_state = _run_graph_with_effects(GraphExecutionState(graph=_flat_for_graph(with_after=True)))
    compatibility_trace, compatibility_state = _run_graph_with_effects(
        GraphExecutionState(graph=_flat_for_graph(with_after=True)),
        force_compatibility_scheduler=True,
    )

    assert generic_trace == compatibility_trace == ["for", "body", "return", "for", "body", "return", "after"]
    assert _state_projection(generic_state) == _state_projection(compatibility_state)
    assert _effect_ledger_projection(generic_state) == _effect_ledger_projection(compatibility_state)
    _assert_generic_and_compatibility_schedulers(generic_state, compatibility_state)
    for state in (generic_state, compatibility_state):
        after_id = next(
            execution_id for execution_id, source_id in state.prepared_source_mapping.items() if source_id == "after"
        )
        assert state.results[after_id].value == [11, 12]
        assert _final_for_output(state).output_collection == [11, 12]

        continuations = sorted(
            state._generic_runtime().continuations.values(), key=lambda continuation: continuation.frame.iteration_path
        )
        assert [
            (
                state.prepared_source_mapping[continuation.owner_id],
                continuation.kind,
                continuation.status,
                tuple(continuation.frame.iteration_path),
                continuation.frame.state_id,
                continuation.frame.workflow_call_depth,
            )
            for continuation in continuations
        ] == [
            ("for", "for", "completed", (0,), state.id, 0),
            ("for", "for", "completed", (1,), state.id, 0),
        ]
        continuation_effects = sorted(
            (
                state.prepared_source_mapping[effect.execution_ref.node_id],
                effect.operation,
                effect.continuation_kind,
                tuple(effect.execution_ref.frame),
            )
            for effects in state.execution_effects.values()
            for effect in effects
            if effect.kind == "continuation"
        )
        assert continuation_effects == [
            ("for", "start", "for", (0,)),
            ("for", "start", "for", (1,)),
            ("return", "complete", "for", (0,)),
            ("return", "complete", "for", (1,)),
        ]


def test_flat_for_apply_partial_rehydration_preserves_continuation_runtime() -> None:
    graph = _flat_for_graph(with_after=True, collection=[None, None], body_returns_none=True)
    resumed_projections: list[tuple[Any, ...]] = []

    for force_compatibility_scheduler in (False, True):
        expected_trace, expected_state = _run_graph_with_effects(
            GraphExecutionState(graph=graph.model_copy(deep=True)),
            force_compatibility_scheduler=force_compatibility_scheduler,
        )
        partial_trace, partial_state = _run_graph_with_effects(
            GraphExecutionState(graph=graph.model_copy(deep=True)),
            force_compatibility_scheduler=force_compatibility_scheduler,
            stop_after_source="return",
        )
        restored = load_execution_state(dump_execution_state(partial_state))
        if force_compatibility_scheduler:
            _restore_compatibility_scheduler(restored)

        assert _effect_ledger_projection(restored) == _effect_ledger_projection(partial_state)
        # Rehydration reconstructs references for all prepared nodes, while the partial in-memory
        # state only has references for nodes reached so far. Compare durable tokens/effects here;
        # resumed execution below compares the complete identity projection.
        assert _execution_identity_projection(restored)[1:] == _execution_identity_projection(partial_state)[1:]
        _assert_execution_identity_consistent(restored)
        assert any(
            (effect.get("kind") if isinstance(effect, dict) else effect.kind) == "continuation"
            and (effect.get("operation") if isinstance(effect, dict) else effect.operation) == "complete"
            and (effect.get("payload") if isinstance(effect, dict) else effect.payload)
            == {"output": None, "state": None, "continue_condition": True}
            for effects in restored.execution_effects.values()
            for effect in effects
        )

        remaining_trace, resumed_state = _run_graph_with_effects(
            restored,
            force_compatibility_scheduler=force_compatibility_scheduler,
        )

        assert partial_trace + remaining_trace == expected_trace
        assert _state_projection(resumed_state) == _state_projection(expected_state)
        assert _continuation_projection(resumed_state) == _continuation_projection(expected_state)
        assert _effect_ledger_projection(resumed_state) == _effect_ledger_projection(expected_state)
        assert _execution_identity_projection(resumed_state) == _execution_identity_projection(expected_state)
        assert _final_for_output(resumed_state).output_collection == [None, None]
        _assert_execution_identity_consistent(resumed_state)
        if force_compatibility_scheduler:
            assert isinstance(resumed_state._execution_scheduler, _ExecutionScheduler)
        else:
            assert isinstance(resumed_state._execution_scheduler, _GenericGraphSchedulerAdapter)
        resumed_projections.append(
            (
                _state_projection(resumed_state),
                _continuation_projection(resumed_state),
                _effect_ledger_projection(resumed_state),
                _execution_identity_projection(resumed_state),
            )
        )

    assert resumed_projections[0] == resumed_projections[1]


@pytest.mark.parametrize(
    ("fail_source_id", "expected_trace"),
    [
        ("body", ["for", "body"]),
        ("return", ["for", "body", "return"]),
    ],
)
def test_flat_for_failure_matches_compatibility_scheduler(fail_source_id: str, expected_trace: list[str]) -> None:
    generic_trace, generic_state = _run_graph_with_effects(
        GraphExecutionState(graph=_flat_for_graph()),
        fail_source_id=fail_source_id,
    )
    compatibility_trace, compatibility_state = _run_graph_with_effects(
        GraphExecutionState(graph=_flat_for_graph()),
        force_compatibility_scheduler=True,
        fail_source_id=fail_source_id,
    )

    assert generic_trace == compatibility_trace == expected_trace
    for state in (generic_state, compatibility_state):
        assert state.next() is None
        assert {
            state.prepared_source_mapping.get(node_id, node_id): message for node_id, message in state.errors.items()
        } == {fail_source_id: "injected failure"}
        assert state.is_complete()
        assert sum(len(effects) for effects in state.execution_effects.values()) == 1
        assert all(item.status == "running" for item in state._generic_runtime().continuations.values())
        _assert_execution_identity_consistent(state)
        restored = load_execution_state(dump_execution_state(state))
        if isinstance(state._execution_scheduler, _ExecutionScheduler):
            _restore_compatibility_scheduler(restored)
        assert _effect_ledger_projection(restored) == _effect_ledger_projection(state)
        assert _continuation_projection(restored) == _continuation_projection(state)
        _assert_execution_identity_consistent(restored)
        assert {
            state.prepared_source_mapping.get(node_id, node_id): message for node_id, message in restored.errors.items()
        } == {fail_source_id: "injected failure"}
        assert restored.next() is None
        assert restored.is_complete()
        if isinstance(state._execution_scheduler, _ExecutionScheduler):
            assert isinstance(restored._execution_scheduler, _ExecutionScheduler)
        else:
            assert restored._execution_scheduler is None
    assert _state_projection(generic_state) == _state_projection(compatibility_state)


@pytest.mark.parametrize("stop_after_source", ["for", "body"])
def test_flat_for_partial_rehydration_matches_compatibility_scheduler(stop_after_source: str) -> None:
    graph = _flat_for_graph()
    expected_trace, expected_state = _run_graph_with_effects(GraphExecutionState(graph=graph.model_copy(deep=True)))
    resumed_projections: list[tuple[Any, ...]] = []

    for force_compatibility_scheduler in (False, True):
        partial_trace, partial_state = _run_graph_with_effects(
            GraphExecutionState(graph=graph.model_copy(deep=True)),
            stop_after_source=stop_after_source,
            force_compatibility_scheduler=force_compatibility_scheduler,
        )
        snapshot = dump_execution_state(partial_state)
        restored = load_execution_state(snapshot)
        if force_compatibility_scheduler:
            _restore_compatibility_scheduler(restored)

        remaining_trace, resumed_state = _run_graph_with_effects(
            restored,
            force_compatibility_scheduler=force_compatibility_scheduler,
        )

        assert partial_trace + remaining_trace == expected_trace
        assert _state_projection(resumed_state) == _state_projection(expected_state)
        # Rehydration reconstructs durable execution references for all prepared nodes; a fresh
        # in-memory run does not retain those references after terminal cleanup. Compare the
        # durable token/effect portions directly and compare references across the two resumed
        # scheduler paths below.
        assert _execution_identity_projection(resumed_state)[1:] == _execution_identity_projection(expected_state)[1:]
        assert _continuation_projection(resumed_state) == _continuation_projection(expected_state)
        _assert_execution_identity_consistent(resumed_state)
        if force_compatibility_scheduler:
            assert isinstance(resumed_state._execution_scheduler, _ExecutionScheduler)
        else:
            assert isinstance(resumed_state._execution_scheduler, _GenericGraphSchedulerAdapter)
        resumed_projections.append((_state_projection(resumed_state), _execution_identity_projection(resumed_state)))

    assert resumed_projections[0] == resumed_projections[1]


def test_flat_for_frame_and_continuation_identity_matches_compatibility_scheduler() -> None:
    generic_trace, generic_state = _run_graph_with_effects(GraphExecutionState(graph=_flat_for_graph()), stop_after=4)
    compatibility_trace, compatibility_state = _run_graph_with_effects(
        GraphExecutionState(graph=_flat_for_graph()),
        force_compatibility_scheduler=True,
        stop_after=4,
    )

    assert generic_trace == compatibility_trace == ["for", "body", "return", "for"]
    assert _execution_identity_projection(generic_state) == _execution_identity_projection(compatibility_state)
    assert _continuation_projection(generic_state) == _continuation_projection(compatibility_state)
    _assert_generic_and_compatibility_schedulers(generic_state, compatibility_state)
    for state in (generic_state, compatibility_state):
        continuations = sorted(
            state._generic_runtime().continuations.values(), key=lambda item: item.frame.iteration_path
        )
        assert len(continuations) == 2
        assert [tuple(item.frame.iteration_path) for item in continuations] == [(0,), (1,)]
        assert {state.prepared_source_mapping[item.owner_id] for item in continuations} == {"for"}
        assert {item.frame.state_id for item in continuations} == {state.id}
        assert {item.frame.workflow_call_depth for item in continuations} == {0}
        frame_ids = [item.frame.frame_id for item in continuations]
        assert all(frame_ids)
        assert len(set(frame_ids)) == len(frame_ids)
        assert all(
            item.frame.model_dump(mode="json")
            == state._expected_execution_ref(item.owner_id).frame.model_dump(mode="json")
            for item in continuations
        )
        assert [item.status for item in continuations] == ["completed", "running"]
        _assert_execution_identity_consistent(state)

    generic_frames = {item.frame.frame_id for item in generic_state._generic_runtime().continuations.values()}
    compatibility_frames = {
        item.frame.frame_id for item in compatibility_state._generic_runtime().continuations.values()
    }
    assert generic_frames.isdisjoint(compatibility_frames)

    other_trace, other_state = _run_graph_with_effects(GraphExecutionState(graph=_flat_for_graph()), stop_after=4)
    assert other_trace == generic_trace
    other_frames = {item.frame.frame_id for item in other_state._generic_runtime().continuations.values()}
    generic_frames = {item.frame.frame_id for item in generic_state._generic_runtime().continuations.values()}
    assert other_frames.isdisjoint(generic_frames)


@pytest.mark.parametrize(
    ("graph_kwargs", "expected_trace", "expected_collection"),
    [
        ({"collection": []}, [], []),
        ({"input_collection": [1, 2]}, ["collection", "for", "body", "return", "for", "body", "return"], [11, 12]),
    ],
)
def test_flat_for_ineligible_collections_use_compatibility_scheduler(
    graph_kwargs: dict[str, list[Any]], expected_trace: list[str], expected_collection: list[Any]
) -> None:
    state = GraphExecutionState(graph=_flat_for_graph(**graph_kwargs))

    assert state._can_use_generic_scheduler() is False
    trace, state = _run_graph_with_effects(state)

    assert trace == expected_trace
    assert isinstance(state._execution_scheduler, _ExecutionScheduler)
    assert _final_for_output(state).output_collection == expected_collection
    assert state.is_complete()
    continuations = list(state._generic_runtime().continuations.values())
    assert len(continuations) == len(expected_collection)
    assert all(state.prepared_source_mapping[item.owner_id] == "for" for item in continuations)
    assert all(item.status == "completed" for item in continuations)
    assert sum(len(effects) for effects in state.execution_effects.values()) == 2 * len(expected_collection)
    _assert_execution_identity_consistent(state)

    restored = load_execution_state(dump_execution_state(state))
    _restore_compatibility_scheduler(restored)
    assert isinstance(restored._execution_scheduler, _ExecutionScheduler)
    assert _state_projection(restored) == _state_projection(state)
    assert _effect_ledger_projection(restored) == _effect_ledger_projection(state)
    assert _continuation_projection(restored) == _continuation_projection(state)
    _assert_execution_identity_consistent(restored)


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
    generic_trace, generic_state = _run_graph_with_effects(
        GraphExecutionState(graph=_flat_for_state_graph(continue_condition)),
    )
    compatibility_trace, compatibility_state = _run_graph_with_effects(
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
    _assert_generic_and_compatibility_schedulers(generic_state, compatibility_state)


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


def test_real_invocation_failure_round_trip_preserves_both_scheduler_terminal_state() -> None:
    expected_error = "This invocation is supposed to fail"
    terminal_states: list[tuple[str, bool, bool]] = []

    for force_compatibility_scheduler in (False, True):
        graph = Graph()
        graph.add_node(ErrorInvocation(id="error"))
        state = GraphExecutionState(graph=graph)
        if force_compatibility_scheduler:
            state._execution_scheduler = _ExecutionScheduler(state)

        node = state.next()
        assert node is not None
        with pytest.raises(Exception) as invocation_error:
            node.invoke(Mock())
        assert str(invocation_error.value) == expected_error
        state.set_node_error(node.id, str(invocation_error.value))

        assert state.next() is None
        assert state.is_complete()
        assert {
            state.prepared_source_mapping.get(node_id, node_id): message for node_id, message in state.errors.items()
        } == {"error": expected_error}

        restored = load_execution_state(dump_execution_state(state))
        if force_compatibility_scheduler:
            _restore_compatibility_scheduler(restored)

        assert restored.errors == state.errors
        assert restored.next() is None
        assert restored.is_complete()
        terminal_states.append((str(next(iter(restored.errors.values()))), True, restored.is_complete()))

    assert terminal_states == [(expected_error, True, True), (expected_error, True, True)]


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

    def record_deleted_edge(self: GraphExecutionState, edge: Edge) -> None:
        deleted_edges.append(edge)

    monkeypatch.setattr(GraphExecutionState, "_tx_delete_execution_edge", record_deleted_edge)

    trace, state = _run_graph(state)

    assert trace == ["outer_condition", "inner_condition", "inner_false", "inner_if", "outer_if", "sink"]
    sink_id = next(iter(state.source_prepared_mapping["sink"]))
    assert state.results[sink_id].value == 7
    assert state.is_complete()
    assert deleted_edges == []


@pytest.mark.parametrize("force_compatibility_scheduler", [False, True])
def test_if_readiness_preserves_both_schedulers(
    force_compatibility_scheduler: bool,
) -> None:
    graph = _nested_if_graph()

    trace, state = _run_graph(
        GraphExecutionState(graph=graph),
        force_compatibility_scheduler=force_compatibility_scheduler,
    )

    assert trace == ["outer_condition", "inner_condition", "inner_false", "inner_if", "outer_if", "sink"]
    assert state.is_complete()


@pytest.mark.parametrize("force_compatibility_scheduler", [False, True])
def test_flat_if_admission_is_demand_driven_and_token_authoritative(
    force_compatibility_scheduler: bool,
) -> None:
    trace, state = _run_graph(
        GraphExecutionState(graph=_flat_if_graph()),
        force_compatibility_scheduler=force_compatibility_scheduler,
    )

    assert trace == ["condition", "true_branch", "if", "sink"]
    assert set(state.source_prepared_mapping) == {"condition", "true_branch", "if", "sink"}
    assert "false_branch" not in state.source_prepared_mapping
    assert state.executed_history == trace
    assert all(
        state._get_prepared_exec_metadata(exec_node_id).state != "skipped"
        for exec_node_id in state.prepared_source_mapping
    )
    activation_tokens = [token for token in state.execution_tokens.values() if token.token_kind == "activation"]
    assert len(activation_tokens) == 1
    assert activation_tokens[0].port == "true_input"
    sink_id = next(iter(state.source_prepared_mapping["sink"]))
    assert state.results[sink_id].value == 6
    assert state.is_complete()


@pytest.mark.parametrize("force_compatibility_scheduler", [False, True])
def test_fresh_flat_if_records_dependencies_without_author_graph_branch_analysis(
    force_compatibility_scheduler: bool,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    def fail_branch_analysis(*_: object, **__: object) -> set[str]:
        raise AssertionError("fresh flat If used controller-owned branch analysis")

    monkeypatch.setattr(graph_module._IfActivationController, "_branch_sources", fail_branch_analysis)

    trace, state = _run_graph(
        GraphExecutionState(graph=_flat_if_graph()),
        force_compatibility_scheduler=force_compatibility_scheduler,
    )

    assert trace == ["condition", "true_branch", "if", "sink"]
    true_branch_id = next(
        execution_id for execution_id, source_id in state.prepared_source_mapping.items() if source_id == "true_branch"
    )
    assert [
        (dependency.owner_id, dependency.branch, dependency.frame)
        for dependency in state._if_activation_dependencies_by_exec[true_branch_id]
    ] == [("if", "true_input", ())]
    assert state.is_complete()


def test_fresh_flat_if_with_saved_workflow_uses_controller_fallback(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    graph = _flat_if_graph()
    graph.delete_node("sink")
    graph.add_node(CallSavedWorkflowInvocation(id="call", workflow_id="saved-workflow"))
    graph.add_edge(create_edge("if", "value", "call", "saved_workflow_input::input::value"))
    state = GraphExecutionState(graph=graph)
    branch_analysis_calls: list[tuple[str, str]] = []
    original_branch_sources = graph_module._IfActivationController._branch_sources

    def record_branch_analysis(
        controller: graph_module._IfActivationController,
        if_node_id: str,
        branch_field: str,
        source_graph: Any,
    ) -> set[str]:
        branch_analysis_calls.append((if_node_id, branch_field))
        return original_branch_sources(controller, if_node_id, branch_field, source_graph)

    monkeypatch.setattr(graph_module._IfActivationController, "_branch_sources", record_branch_analysis)

    assert not state._can_use_fresh_flat_if_activation()
    assert state._get_source_activation_dependencies("true_branch") == (
        graph_module.ActivationDependency(owner_id="if", branch="true_input", frame=()),
    )
    assert branch_analysis_calls


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

    def fail_edge_deletion(*_: object, **__: object) -> None:
        raise AssertionError("fresh generic If execution deleted an execution edge")

    generic_retired_nodes: list[str] = []
    original_discard = _GenericGraphSchedulerAdapter._retire_unselected_node

    def record_generic_discard(adapter: _GenericGraphSchedulerAdapter, exec_node_id: str) -> None:
        generic_retired_nodes.append(exec_node_id)
        original_discard(adapter, exec_node_id)

    monkeypatch.setattr(_GenericGraphSchedulerAdapter, "_retire_unselected_node", record_generic_discard)
    monkeypatch.setattr(GraphExecutionState, "_tx_delete_execution_edge", fail_edge_deletion)

    trace, state = _run_graph(GraphExecutionState(graph=graph))

    assert trace == expected_trace
    assert state.executed_history == expected_trace
    assert set(state.indegree) == set(state.prepared_source_mapping)
    assert set(state.indegree.values()) == {0}
    assert state.is_complete()
    sink_id = next(iter(state.source_prepared_mapping["sink"]))
    assert state.results[sink_id].value == expected_value
    assert _execution_edge_projection(state) == _expected_edge_projection(
        graph,
        force_compatibility_scheduler=False,
        outer_condition=outer_condition,
        inner_condition=inner_condition,
    )
    assert generic_retired_nodes == []


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
