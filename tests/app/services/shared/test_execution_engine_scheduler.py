from __future__ import annotations

from unittest.mock import Mock

import pytest

from invokeai.app.invocations.math import AddInvocation, MultiplyInvocation
from invokeai.app.services.shared.execution_engine.scheduler import (
    ExecutionPlan,
    ExecutionScheduler,
)
from invokeai.app.services.shared.graph import Edge, EdgeConnection, Graph, GraphExecutionState


def _plan() -> ExecutionPlan:
    plan = ExecutionPlan()
    plan.add_node("left", "AddInvocation")
    plan.add_node("right", "AddInvocation")
    plan.add_node("join", "MultiplyInvocation", dependencies=("left", "right"))
    return plan


def test_generic_scheduler_routes_fanout_and_fanin_without_invocation_types() -> None:
    plan = _plan()
    scheduler = ExecutionScheduler(plan)

    scheduler.enqueue("left")
    scheduler.enqueue("right")
    assert scheduler.pop_next() == "left"
    assert scheduler.pop_next() == "right"
    assert scheduler.pop_next() is None

    assert scheduler.complete("left") == ()
    assert scheduler.complete("right") == ("join",)
    assert scheduler.pop_next() == "join"
    assert scheduler.complete("join") == ()


def test_generic_scheduler_preserves_ready_class_and_frame_order() -> None:
    plan = ExecutionPlan()
    plan.add_node("late", "ZNode", frame=(1,))
    plan.add_node("early", "ZNode", frame=(0,))
    plan.add_node("other", "ANode")
    scheduler = ExecutionScheduler(plan, ready_order=("ZNode", "ANode"))

    for node_id in ("late", "early", "other"):
        scheduler.enqueue(node_id)

    assert [scheduler.pop_next(), scheduler.pop_next(), scheduler.pop_next()] == ["early", "late", "other"]


def test_generic_scheduler_sorts_unlisted_ready_classes_by_name() -> None:
    plan = ExecutionPlan()
    plan.add_node("z", "ZNode")
    plan.add_node("a", "ANode")
    scheduler = ExecutionScheduler(plan, ready_order=("PriorityNode",))

    assert [scheduler.pop_next(), scheduler.pop_next()] == ["a", "z"]


def test_generic_scheduler_rejects_non_closed_executed_projection() -> None:
    plan = ExecutionPlan()
    plan.add_node("parent", "Parent")
    plan.add_node("child", "Child", dependencies=("parent",))

    with pytest.raises(ValueError, match="missing prerequisite"):
        ExecutionScheduler(plan, executed=("child",))


def test_generic_scheduler_does_not_requeue_claimed_work_on_rebuild() -> None:
    scheduler = ExecutionScheduler(_plan())
    assert scheduler.pop_next() == "left"

    scheduler.rebuild_ready()

    assert scheduler.pop_next() == "right"


def test_generic_scheduler_rejects_invalid_completion_without_mutation() -> None:
    plan = _plan()
    scheduler = ExecutionScheduler(plan)
    scheduler.enqueue("left")

    with pytest.raises(KeyError, match="missing"):
        scheduler.complete("missing")
    assert scheduler.pop_next() == "left"

    scheduler.complete("left")
    with pytest.raises(ValueError, match="already completed"):
        scheduler.complete("left")
    assert scheduler.indegree == {"left": 0, "right": 0, "join": 1}


def test_generic_scheduler_rejects_completion_when_durable_indegree_is_missing() -> None:
    scheduler = ExecutionScheduler(_plan())
    scheduler.indegree.pop("join")

    with pytest.raises(KeyError, match="indegree missing"):
        scheduler.complete("left")

    assert scheduler.executed == set()


def test_generic_scheduler_rehydrates_repeated_dependencies() -> None:
    plan = ExecutionPlan()
    plan.add_node("source", "Source")
    plan.add_node("join", "Join", dependencies=("source", "source"))

    scheduler = ExecutionScheduler(plan)
    assert scheduler.indegree["join"] == 2
    scheduler.complete("source")
    assert scheduler.indegree["join"] == 0


def test_generic_scheduler_rejects_malformed_snapshot() -> None:
    with pytest.raises(ValueError, match="node order"):
        ExecutionPlan.from_snapshot({"nodes": {"node": {"node_id": "node", "class_name": "Node", "order": "first"}}})


def test_generic_scheduler_rehydrates_from_durable_projection() -> None:
    plan = _plan()
    scheduler = ExecutionScheduler(plan)
    scheduler.enqueue("left")
    scheduler.complete("left")

    restored = ExecutionScheduler(
        ExecutionPlan.from_snapshot(plan.snapshot()),
        executed=scheduler.executed,
    )
    restored.rebuild_ready()

    assert restored.pop_next() == "right"
    assert restored.indegree["join"] == 1


def test_graph_state_static_dag_matches_generic_scheduler_trace() -> None:
    graph = Graph()
    graph.add_node(AddInvocation(id="left", a=1, b=2))
    graph.add_node(AddInvocation(id="right", a=3, b=4))
    graph.add_node(MultiplyInvocation(id="join"))
    graph.add_edge(
        Edge(
            source=EdgeConnection(node_id="left", field="value"),
            destination=EdgeConnection(node_id="join", field="a"),
        )
    )
    graph.add_edge(
        Edge(
            source=EdgeConnection(node_id="right", field="value"),
            destination=EdgeConnection(node_id="join", field="b"),
        )
    )

    state = GraphExecutionState(graph=graph)
    plan = ExecutionPlan()
    plan.add_node("left", "AddInvocation")
    plan.add_node("right", "AddInvocation")
    plan.add_node("join", "MultiplyInvocation", dependencies=("left", "right"))
    generic = ExecutionScheduler(plan)
    generic.enqueue("left")
    generic.enqueue("right")

    legacy_trace: list[str] = []
    generic_trace: list[str] = []
    while (node := state.next()) is not None:
        legacy_trace.append(state.prepared_source_mapping[node.id])
        state.complete(node.id, node.invoke(Mock()))
    while (node_id := generic.pop_next()) is not None:
        generic_trace.append(node_id)
        generic.complete(node_id)

    assert legacy_trace == generic_trace
    assert state.is_complete()


def test_graph_state_static_dag_delegates_readiness_to_generic_scheduler() -> None:
    graph = Graph()
    graph.add_node(AddInvocation(id="add", a=1, b=2))
    state = GraphExecutionState(graph=graph)

    node = state.next()

    assert node is not None
    assert type(state._scheduler()).__name__ == "_GenericGraphSchedulerAdapter"
    state.complete(node.id, node.invoke(Mock()))
    assert state.is_complete()


def test_graph_state_static_dag_rehydrates_generic_scheduler_after_partial_run() -> None:
    graph = Graph()
    graph.add_node(AddInvocation(id="first", a=1, b=2))
    graph.add_node(AddInvocation(id="second", b=4))
    graph.add_edge(
        Edge(
            source=EdgeConnection(node_id="first", field="value"),
            destination=EdgeConnection(node_id="second", field="a"),
        )
    )
    state = GraphExecutionState(graph=graph)
    first = state.next()
    assert first is not None
    state.complete(first.id, first.invoke(Mock()))

    restored = GraphExecutionState.model_validate(state.model_dump(mode="python"), strict=False)

    second = restored.next()
    assert second is not None
    assert restored.prepared_source_mapping[second.id] == "second"
