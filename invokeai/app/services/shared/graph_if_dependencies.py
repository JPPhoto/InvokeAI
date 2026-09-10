# Copyright (c) 2022 Kyle Schouviller (https://github.com/kyle0654)

from typing import TYPE_CHECKING

from invokeai.app.invocations.call_saved_workflow import CallSavedWorkflowInvocation
from invokeai.app.invocations.logic import IfInvocation
from invokeai.app.invocations.loops import ForInvocation, ForReturnInvocation
from invokeai.app.services.shared.execution_engine.scheduler import ActivationDependency
from invokeai.app.services.shared.graph_validation import CollectInvocation, IterateInvocation, nx

if TYPE_CHECKING:
    from invokeai.app.services.shared.graph import GraphExecutionState


def _get_fresh_if_nodes(state: "GraphExecutionState") -> tuple[IfInvocation, ...]:
    source_graph = state._get_source_graph_flat()
    source_order = {node_id: index for index, node_id in enumerate(nx.topological_sort(source_graph))}
    return tuple(
        sorted(
            (node for node in state.graph.nodes.values() if isinstance(node, IfInvocation)),
            key=lambda node: (source_order.get(node.id, len(source_order)), node.id),
        )
    )


def _can_use_fresh_flat_if_activation(state: "GraphExecutionState") -> bool:
    """Admit fresh single-If or bounded nested-If dependency compilation."""

    if state._legacy_snapshot_loaded:
        return False

    forbidden_nodes = (
        CallSavedWorkflowInvocation,
        ForInvocation,
        ForReturnInvocation,
        IterateInvocation,
        CollectInvocation,
    )
    if any(isinstance(node, forbidden_nodes) for node in state.graph.nodes.values()):
        return False

    try:
        source_graph = state._get_source_graph_flat()
        if not nx.is_directed_acyclic_graph(source_graph):
            return False
        if_nodes = _get_fresh_if_nodes(state)
    except nx.NetworkXUnfeasible:
        return False

    if len(if_nodes) != 1:
        if len(if_nodes) not in {2, 3}:
            return False

        if any(edge.type != "default" for edge in state.graph.edges):
            return False

        if_node_ids = {node.id for node in if_nodes}
        nested_edges = [
            edge
            for edge in state.graph.edges
            if edge.source.node_id in if_node_ids and edge.destination.node_id in if_node_ids
        ]
        if not nested_edges:
            expected_input_fields = {"condition", "true_input", "false_input"}
            if any(
                source_if.id != destination_if.id and nx.has_path(source_graph, source_if.id, destination_if.id)
                for source_if in if_nodes
                for destination_if in if_nodes
            ):
                return False
            for if_node in if_nodes:
                input_edges = state.graph._get_input_edges(if_node.id)
                if (
                    len(input_edges) != len(expected_input_fields)
                    or {edge.destination.field for edge in input_edges} != expected_input_fields
                ):
                    return False
                if any(edge.source.node_id in if_node_ids for edge in input_edges):
                    return False
        elif len(nested_edges) == len(if_nodes) - 1:
            if any(
                edge.source.field != "value" or edge.destination.field not in {"true_input", "false_input"}
                for edge in nested_edges
            ):
                return False

            nested_edge_by_source = {edge.source.node_id: edge for edge in nested_edges}
            nested_destinations = {edge.destination.node_id for edge in nested_edges}
            if len(nested_edge_by_source) != len(nested_edges) or len(nested_destinations) != len(nested_edges):
                return False

            chain_start_ids = if_node_ids - nested_destinations
            chain_end_ids = if_node_ids - set(nested_edge_by_source)
            if len(chain_start_ids) != 1 or len(chain_end_ids) != 1:
                return False

            current_if_id = next(iter(chain_start_ids))
            for _ in range(len(nested_edges)):
                nested_edge = nested_edge_by_source.get(current_if_id)
                if nested_edge is None:
                    return False
                if any(edge.source.node_id == current_if_id and edge != nested_edge for edge in state.graph.edges):
                    return False
                current_if_id = nested_edge.destination.node_id
            if current_if_id not in chain_end_ids:
                return False

            expected_input_fields = {"condition", "true_input", "false_input"}
            for if_node in if_nodes:
                input_edges = state.graph._get_input_edges(if_node.id)
                if (
                    len(input_edges) != len(expected_input_fields)
                    or {edge.destination.field for edge in input_edges} != expected_input_fields
                    or any(edge.source.node_id in if_node_ids and edge not in nested_edges for edge in input_edges)
                ):
                    return False
        else:
            return False

    return True


def _get_fresh_if_branch_sources(state: "GraphExecutionState", if_node_id: str, branch_field: str) -> set[str]:
    cache_key = (if_node_id, branch_field)
    cached = state._if_branch_sources_cache.get(cache_key)
    if cached is not None:
        return set(cached)

    source_graph = state._get_source_graph_flat()
    direct_sources = {edge.source.node_id for edge in state.graph._get_input_edges(if_node_id, branch_field)}
    branch_sources = set(direct_sources)
    for source_node_id in direct_sources:
        branch_sources.update(nx.ancestors(source_graph, source_node_id))

    changed = True
    while changed:
        changed = False
        for source_node_id in tuple(branch_sources):
            if all(
                edge.destination.node_id in branch_sources
                or (edge.destination.node_id == if_node_id and edge.destination.field == branch_field)
                for edge in state.graph._get_output_edges(source_node_id)
            ):
                continue
            branch_sources.remove(source_node_id)
            changed = True
    state._if_branch_sources_cache[cache_key] = frozenset(branch_sources)
    return branch_sources


def _get_source_activation_dependencies(
    state: "GraphExecutionState", source_node_id: str, iteration_path: tuple[int, ...] = ()
) -> tuple[ActivationDependency, ...]:
    key = (source_node_id, iteration_path)
    if key in state._if_activation_dependencies_by_source:
        return state._if_activation_dependencies_by_source[key]

    if not _can_use_fresh_flat_if_activation(state):
        return state._if_activation_controller().get_source_dependencies(source_node_id, iteration_path)

    dependencies = tuple(
        ActivationDependency(owner_id=if_node.id, branch=branch_field, frame=iteration_path)
        for if_node in _get_fresh_if_nodes(state)
        for branch_field in ("true_input", "false_input")
        if source_node_id in _get_fresh_if_branch_sources(state, if_node.id, branch_field)
    )
    state._tx_set_mapping(state._if_activation_dependencies_by_source, key, dependencies)
    return dependencies
