"""Bounded generic planning for the supported nested For/Iterate/Collect shape."""

from typing import TYPE_CHECKING

from invokeai.app.invocations.call_saved_workflow import CallSavedWorkflowInvocation
from invokeai.app.invocations.logic import IfInvocation
from invokeai.app.invocations.loops import ForInvocation, ForReturnInvocation
from invokeai.app.services.shared.graph_iterate_planner import (
    _attach_direct_execution_edges,
    _create_direct_execution_node_copy,
    _initialize_direct_execution_node,
)
from invokeai.app.services.shared.graph_models import Edge, EdgeConnection
from invokeai.app.services.shared.graph_validation import (
    COLLECTION_FIELD,
    ITEM_FIELD,
)

if TYPE_CHECKING:
    from invokeai.app.services.shared.graph import GraphExecutionState


def _get_exact_nested_iterate_body(state: "GraphExecutionState"):
    """Return the supported nested stream contract, excluding broader topologies."""
    for_node = next((node for node in state.graph.nodes.values() if isinstance(node, ForInvocation)), None)
    if for_node is None:
        return None
    outer_collection_edges = state.graph._get_input_edges(for_node.id, COLLECTION_FIELD)
    if len(outer_collection_edges) > 1:
        return None
    input_driven_outer = bool(outer_collection_edges)
    expected_node_count = 8 if input_driven_outer else 7
    expected_edge_count = 8 if input_driven_outer else 7
    if len(state.graph.nodes) != expected_node_count or len(state.graph.edges) != expected_edge_count:
        return None
    if input_driven_outer:
        outer_collection_edge = outer_collection_edges[0]
        producer = state.graph.get_node(outer_collection_edge.source.node_id)
        if (
            outer_collection_edge.destination.node_id != for_node.id
            or outer_collection_edge.source.field != COLLECTION_FIELD
            or isinstance(
                producer,
                (
                    CallSavedWorkflowInvocation,
                    IfInvocation,
                    ForInvocation,
                    ForReturnInvocation,
                ),
            )
            or state.graph._get_input_edges(producer.id)
            or state.graph._get_output_edges(producer.id) != [outer_collection_edge]
        ):
            return None
    nested_body = state.graph._get_supported_for_nested_iterate_body(for_node.id, state._get_source_graph_flat())
    if nested_body is None or len(nested_body.body_path_nodes) != 5:
        return None
    return for_node.id, nested_body


def can_use_nested_iterate_planner(state: "GraphExecutionState") -> bool:
    """Check the exact fresh nested stream topology before generic admission."""
    return not state._legacy_snapshot_loaded and _get_exact_nested_iterate_body(state) is not None


def _outer_iteration_path(state: "GraphExecutionState", prepared_for_id: str) -> tuple[int, ...]:
    path = state._get_iteration_path(prepared_for_id)
    prepared_for = state.execution_graph.get_node(prepared_for_id)
    if isinstance(prepared_for, ForInvocation) and prepared_for.index >= 0:
        return (*state._get_for_parent_iteration_path(prepared_for_id), prepared_for.index)
    return path


def _prepared_at_path(state: "GraphExecutionState", source_node_id: str, path: tuple[int, ...]) -> str | None:
    matches = [
        prepared_id
        for prepared_id in state._prepared_registry().get_prepared_ids(source_node_id)
        if state._get_iteration_path(prepared_id) == path
    ]
    if len(matches) > 1:
        raise RuntimeError(f"Multiple prepared nested nodes exist for {source_node_id} at {path}")
    return matches[0] if matches else None


def _prepare_nested_iterate_body_for_outer(
    state: "GraphExecutionState", source_for_id: str, prepared_for_id: str
) -> None:
    exact = _get_exact_nested_iterate_body(state)
    if exact is None or exact[0] != source_for_id:
        return
    _, nested_body = exact
    outer_path = _outer_iteration_path(state, prepared_for_id)
    source_iterate_id = nested_body.iterate_node_id
    source_collect_id = nested_body.collect_node_id
    source_return_id = nested_body.return_node_id
    iterate_input_edge = state.graph._get_input_edges(source_iterate_id, COLLECTION_FIELD)[0]
    preparation_node_id = iterate_input_edge.source.node_id
    preparation_input_edge = state.graph._get_input_edges(preparation_node_id)[0]
    body_node_id = state.graph._get_input_edges(source_collect_id, ITEM_FIELD)[0].source.node_id
    body_input_edge = state.graph._get_input_edges(body_node_id)[0]

    preparation_exec_id = _prepared_at_path(state, preparation_node_id, outer_path)
    if preparation_exec_id is None:
        preparation_node = _create_direct_execution_node_copy(state, preparation_node_id, iteration_path=outer_path)
        attached_preparation_edges = _attach_direct_execution_edges(
            state,
            preparation_node.id,
            [
                Edge(
                    source=EdgeConnection(node_id=prepared_for_id, field=preparation_input_edge.source.field),
                    destination=EdgeConnection(node_id="", field=preparation_input_edge.destination.field),
                )
            ],
        )
        _initialize_direct_execution_node(state, preparation_node.id, attached_preparation_edges)
        return

    if preparation_exec_id not in state.results:
        return
    if _prepared_at_path(state, source_collect_id, outer_path) is not None:
        return

    collection = getattr(state.results[preparation_exec_id], iterate_input_edge.source.field)
    if not isinstance(collection, list):
        raise ValueError("Nested Iterate collection source must produce a list")

    body_exec_ids: list[str] = []
    for index in range(len(collection)):
        iteration_path = (*outer_path, index)
        iterate_node = _create_direct_execution_node_copy(
            state, source_iterate_id, iteration_index=index, iteration_path=iteration_path
        )
        attached_iterate_edges = _attach_direct_execution_edges(
            state,
            iterate_node.id,
            [
                Edge(
                    source=EdgeConnection(node_id=preparation_exec_id, field=iterate_input_edge.source.field),
                    destination=EdgeConnection(node_id="", field=iterate_input_edge.destination.field),
                )
            ],
        )
        _initialize_direct_execution_node(state, iterate_node.id, attached_iterate_edges)

        body_node = _create_direct_execution_node_copy(state, body_node_id, iteration_path=iteration_path)
        attached_body_edges = _attach_direct_execution_edges(
            state,
            body_node.id,
            [
                Edge(
                    source=EdgeConnection(node_id=iterate_node.id, field=body_input_edge.source.field),
                    destination=EdgeConnection(node_id="", field=body_input_edge.destination.field),
                )
            ],
        )
        _initialize_direct_execution_node(state, body_node.id, attached_body_edges)
        body_exec_ids.append(body_node.id)

    if not body_exec_ids:
        state._record_empty_iterate_stream(source_iterate_id, outer_path)

    state._discard_source_executed(source_iterate_id)
    collect_node = _create_direct_execution_node_copy(state, source_collect_id, iteration_path=outer_path)
    collect_item_edge = state.graph._get_input_edges(source_collect_id, ITEM_FIELD)[0]
    attached_collect_edges = _attach_direct_execution_edges(
        state,
        collect_node.id,
        [
            Edge(
                source=EdgeConnection(node_id=body_exec_id, field=collect_item_edge.source.field),
                destination=EdgeConnection(node_id="", field=collect_item_edge.destination.field),
            )
            for body_exec_id in body_exec_ids
        ],
    )
    _initialize_direct_execution_node(state, collect_node.id, attached_collect_edges)

    state._discard_source_executed(source_return_id)
    return_node = _create_direct_execution_node_copy(state, source_return_id, iteration_path=outer_path)
    return_input_edges = state.graph._get_input_edges(source_return_id, "output")
    attached_return_edges = _attach_direct_execution_edges(
        state,
        return_node.id,
        [
            Edge(
                source=EdgeConnection(node_id=collect_node.id, field=COLLECTION_FIELD),
                destination=EdgeConnection(node_id="", field=edge.destination.field),
            )
            for edge in return_input_edges
        ],
    )
    _initialize_direct_execution_node(state, return_node.id, attached_return_edges)


def prepare_nested_iterate_bodies(state: "GraphExecutionState") -> None:
    """Prepare the exact nested stream body for every outer For execution path."""
    if not can_use_nested_iterate_planner(state):
        return
    exact = _get_exact_nested_iterate_body(state)
    assert exact is not None
    source_for_id, _ = exact
    for prepared_for_id in tuple(state._prepared_registry().get_prepared_ids(source_for_id)):
        prepared_for = state.execution_graph.get_node(prepared_for_id)
        if isinstance(prepared_for, ForInvocation) and prepared_for.index >= 0:
            _prepare_nested_iterate_body_for_outer(state, source_for_id, prepared_for_id)
