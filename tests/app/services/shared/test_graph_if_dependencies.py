from __future__ import annotations

import subprocess
import sys
import textwrap
from typing import Any

import pytest

from invokeai.app.invocations.call_saved_workflow import CallSavedWorkflowInvocation
from invokeai.app.invocations.logic import IfInvocation
from invokeai.app.invocations.math import AddInvocation
from invokeai.app.invocations.primitives import BooleanInvocation
from invokeai.app.services.shared import graph as graph_module
from invokeai.app.services.shared import graph_if_dependencies
from invokeai.app.services.shared.execution_engine import ActivationDependency
from invokeai.app.services.shared.graph import Edge, EdgeConnection, Graph, GraphExecutionState


def _edge(source: str, source_field: str, destination: str, destination_field: str) -> Edge:
    return Edge(
        source=EdgeConnection(node_id=source, field=source_field),
        destination=EdgeConnection(node_id=destination, field=destination_field),
    )


def _flat_if_graph() -> Graph:
    graph = Graph()
    graph.add_node(BooleanInvocation(id="condition", value=True))
    graph.add_node(AddInvocation(id="true_branch", a=2, b=3))
    graph.add_node(AddInvocation(id="false_branch", a=10, b=20))
    graph.add_node(IfInvocation(id="if"))
    graph.add_node(AddInvocation(id="sink", b=1))
    graph.add_edge(_edge("condition", "value", "if", "condition"))
    graph.add_edge(_edge("true_branch", "value", "if", "true_input"))
    graph.add_edge(_edge("false_branch", "value", "if", "false_input"))
    graph.add_edge(_edge("if", "value", "sink", "a"))
    return graph


def _nested_if_graph() -> Graph:
    graph = Graph()
    graph.add_node(BooleanInvocation(id="outer_condition", value=True))
    graph.add_node(BooleanInvocation(id="inner_condition", value=False))
    graph.add_node(AddInvocation(id="inner_true", a=2, b=2))
    graph.add_node(AddInvocation(id="inner_false", a=3, b=3))
    graph.add_node(AddInvocation(id="outer_false", a=10, b=0))
    graph.add_node(IfInvocation(id="inner_if"))
    graph.add_node(IfInvocation(id="outer_if"))
    graph.add_node(AddInvocation(id="sink", b=1))
    graph.add_edge(_edge("outer_condition", "value", "outer_if", "condition"))
    graph.add_edge(_edge("inner_condition", "value", "inner_if", "condition"))
    graph.add_edge(_edge("inner_true", "value", "inner_if", "true_input"))
    graph.add_edge(_edge("inner_false", "value", "inner_if", "false_input"))
    graph.add_edge(_edge("inner_if", "value", "outer_if", "true_input"))
    graph.add_edge(_edge("outer_false", "value", "outer_if", "false_input"))
    graph.add_edge(_edge("outer_if", "value", "sink", "a"))
    return graph


def test_leaf_import_does_not_import_graph() -> None:
    script = """
    import builtins
    import sys

    real_import = builtins.__import__

    def blocked_import(name, globals=None, locals=None, fromlist=(), level=0):
        if name == "invokeai.app.services.shared.graph" or name.startswith("invokeai.app.services.shared.graph."):
            raise ModuleNotFoundError("graph import blocked")
        return real_import(name, globals, locals, fromlist, level)

    builtins.__import__ = blocked_import
    import invokeai.app.services.shared.graph_if_dependencies

    assert "invokeai.app.services.shared.graph" not in sys.modules
    """
    result = subprocess.run(
        [sys.executable, "-c", textwrap.dedent(script)],
        capture_output=True,
        text=True,
        timeout=300,
        check=False,
    )
    assert result.returncode == 0, result.stderr


def test_graph_methods_delegate_to_leaf_functions(monkeypatch: pytest.MonkeyPatch) -> None:
    state = object()
    marker = object()
    monkeypatch.setattr(graph_if_dependencies, "_get_fresh_if_nodes", lambda actual_state: (actual_state, marker))
    monkeypatch.setattr(graph_if_dependencies, "_can_use_fresh_flat_if_activation", lambda actual_state: marker)
    monkeypatch.setattr(
        graph_if_dependencies,
        "_get_fresh_if_branch_sources",
        lambda actual_state, if_node_id, branch_field: {actual_state, if_node_id, branch_field},
    )
    monkeypatch.setattr(
        graph_if_dependencies,
        "_get_source_activation_dependencies",
        lambda actual_state, source_node_id, iteration_path=(): (actual_state, source_node_id, iteration_path),
    )

    assert GraphExecutionState._get_fresh_if_nodes(state) == (state, marker)
    assert GraphExecutionState._can_use_fresh_flat_if_activation(state) is marker
    assert GraphExecutionState._get_fresh_if_branch_sources(state, "if", "true_input") == {
        state,
        "if",
        "true_input",
    }
    assert GraphExecutionState._get_source_activation_dependencies(state, "source", (2,)) == (
        state,
        "source",
        (2,),
    )


def test_flat_and_nested_dependencies_preserve_values_and_order() -> None:
    flat_state = GraphExecutionState(graph=_flat_if_graph())
    assert flat_state._get_source_activation_dependencies("true_branch") == (
        ActivationDependency(owner_id="if", branch="true_input", frame=()),
    )
    assert flat_state._get_source_activation_dependencies("false_branch", (3,)) == (
        ActivationDependency(owner_id="if", branch="false_input", frame=(3,)),
    )

    nested_state = GraphExecutionState(graph=_nested_if_graph())
    assert nested_state._get_source_activation_dependencies("inner_true") == (
        ActivationDependency(owner_id="inner_if", branch="true_input", frame=()),
        ActivationDependency(owner_id="outer_if", branch="true_input", frame=()),
    )
    assert nested_state._get_source_activation_dependencies("inner_false", (4,)) == (
        ActivationDependency(owner_id="inner_if", branch="false_input", frame=(4,)),
        ActivationDependency(owner_id="outer_if", branch="true_input", frame=(4,)),
    )


def test_ineligible_shape_uses_controller_fallback(monkeypatch: pytest.MonkeyPatch) -> None:
    graph = _flat_if_graph()
    graph.add_node(CallSavedWorkflowInvocation(id="call", workflow_id="saved-workflow"))
    state = GraphExecutionState(graph=graph)
    expected = (ActivationDependency(owner_id="fallback", branch="true_input", frame=(7,)),)
    calls: list[tuple[str, tuple[int, ...]]] = []

    def get_source_dependencies(
        _controller: Any, source_node_id: str, iteration_path: tuple[int, ...]
    ) -> tuple[ActivationDependency, ...]:
        calls.append((source_node_id, iteration_path))
        return expected

    monkeypatch.setattr(graph_module._IfActivationController, "get_source_dependencies", get_source_dependencies)
    assert not state._can_use_fresh_flat_if_activation()
    assert state._get_source_activation_dependencies("true_branch", (7,)) == expected
    assert calls == [("true_branch", (7,))]


def test_branch_cache_uses_graph_facade_nx_seam(monkeypatch: pytest.MonkeyPatch) -> None:
    state = GraphExecutionState(graph=_flat_if_graph())
    source_graph = state._get_source_graph_flat()
    calls: list[tuple[str, str]] = []

    class _NetworkX:
        @staticmethod
        def topological_sort(graph: Any) -> list[str]:
            calls.append(("topological_sort", ""))
            return list(graph.nodes)

        @staticmethod
        def ancestors(_graph: Any, node_id: str) -> set[str]:
            calls.append(("ancestors", node_id))
            return set()

        @staticmethod
        def is_directed_acyclic_graph(_graph: Any) -> bool:
            calls.append(("is_directed_acyclic_graph", ""))
            return True

    monkeypatch.setattr(graph_module, "nx", _NetworkX())
    assert graph_if_dependencies._get_fresh_if_nodes(state)[0].id == "if"
    assert graph_if_dependencies._get_fresh_if_branch_sources(state, "if", "true_input") == {"true_branch"}
    assert graph_if_dependencies._get_fresh_if_branch_sources(state, "if", "true_input") == {"true_branch"}
    assert source_graph is state._source_graph_flat
    assert calls == [("topological_sort", ""), ("ancestors", "true_branch")]


def test_branch_dependency_cache_is_frame_local_and_graph_edits_invalidate() -> None:
    state = GraphExecutionState(graph=_flat_if_graph())
    first = state._get_source_activation_dependencies("true_branch", (1,))
    second = state._get_source_activation_dependencies("true_branch", (2,))
    assert first[0].frame == (1,)
    assert second[0].frame == (2,)
    assert set(state._if_activation_dependencies_by_source) == {
        ("true_branch", (1,)),
        ("true_branch", (2,)),
    }

    state.add_node(AddInvocation(id="true_consumer", b=1))
    state.add_edge(_edge("true_branch", "value", "true_consumer", "a"))
    assert state._get_source_activation_dependencies("true_branch") == ()
