"""Generic dependency planning and deterministic execution scheduling.

This module intentionally stores only opaque node identifiers, class names, and
frame values. Graph and invocation semantics belong to adapters above it.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Iterable


NodeId = str
Frame = tuple[object, ...]


@dataclass(frozen=True, slots=True)
class PlanNode:
    """An opaque executable node and its direct prerequisites."""

    node_id: NodeId
    class_name: str
    frame: Frame
    dependencies: tuple[NodeId, ...]
    order: int


class ExecutionPlan:
    """Incrementally-built DAG of opaque executable nodes."""

    def __init__(self) -> None:
        self.nodes: dict[NodeId, PlanNode] = {}
        self._dependents: dict[NodeId, list[NodeId]] = {}
        self._next_order = 0

    def add_node(
        self,
        node_id: NodeId,
        class_name: str,
        frame: Frame = (),
        dependencies: Iterable[NodeId] = (),
    ) -> PlanNode:
        """Add one node, rejecting duplicate IDs and unknown prerequisites."""

        if node_id in self.nodes:
            raise ValueError(f"node already exists: {node_id}")
        dependency_ids = tuple(dependencies)
        if len(set(dependency_ids)) != len(dependency_ids):
            raise ValueError(f"duplicate dependencies for node: {node_id}")
        missing = [dependency for dependency in dependency_ids if dependency not in self.nodes]
        if missing:
            raise KeyError(f"unknown dependency for {node_id}: {missing[0]}")
        node = PlanNode(node_id, class_name, tuple(frame), dependency_ids, self._next_order)
        self._next_order += 1
        self.nodes[node_id] = node
        self._dependents[node_id] = []
        for dependency in dependency_ids:
            self._dependents[dependency].append(node_id)
        return node

    def dependents(self, node_id: NodeId) -> tuple[NodeId, ...]:
        """Return direct dependents, validating the source node exists."""

        if node_id not in self.nodes:
            raise KeyError(f"unknown node: {node_id}")
        return tuple(self._dependents[node_id])


class ExecutionScheduler:
    """Deterministic scheduler for an :class:`ExecutionPlan`."""

    def __init__(self, plan: ExecutionPlan, ready_order: Iterable[str] = ()) -> None:
        self.plan = plan
        self.ready_order = tuple(ready_order)
        self.executed: set[NodeId] = set()
        self.indegree: dict[NodeId, int] = {}
        self._ready: list[NodeId] = []
        self._enqueued: set[NodeId] = set()
        self.rebuild_ready()

    def _priority(self, class_name: str) -> int:
        try:
            return self.ready_order.index(class_name)
        except ValueError:
            return len(self.ready_order)

    def _sort_key(self, node_id: NodeId) -> tuple[int, Frame, int]:
        node = self.plan.nodes[node_id]
        return (self._priority(node.class_name), node.frame, node.order)

    def enqueue(self, node_id: NodeId) -> None:
        """Queue a currently-ready node; repeated enqueue is harmless."""

        node = self.plan.nodes.get(node_id)
        if node is None:
            raise KeyError(f"unknown node: {node_id}")
        if node_id in self.executed:
            raise ValueError(f"node already completed: {node_id}")
        if self.indegree.get(node_id, 0) != 0:
            raise ValueError(f"node is not ready: {node_id}")
        if node_id not in self._enqueued:
            self._ready.append(node_id)
            self._enqueued.add(node_id)
            self._ready.sort(key=self._sort_key)

    def pop_next(self) -> NodeId | None:
        """Remove and return the next ready node ID, or ``None`` when empty."""

        if not self._ready:
            return None
        node_id = self._ready.pop(0)
        self._enqueued.remove(node_id)
        return node_id

    def complete(self, node_id: NodeId) -> None:
        """Mark a node complete and release dependents that become ready."""

        if node_id not in self.plan.nodes:
            raise KeyError(f"unknown node: {node_id}")
        if node_id in self.executed:
            raise ValueError(f"node already completed: {node_id}")
        if self.indegree.get(node_id, 0) != 0:
            raise ValueError(f"node is not ready: {node_id}")
        self.executed.add(node_id)
        self._enqueued.discard(node_id)
        self._ready = [queued for queued in self._ready if queued != node_id]
        for dependent in self.plan.dependents(node_id):
            if self.indegree[dependent] <= 0:
                raise ValueError(f"dependency underflow for node: {dependent}")
            self.indegree[dependent] -= 1
            if self.indegree[dependent] == 0 and dependent not in self.executed:
                self.enqueue(dependent)

    def rebuild_ready(self) -> None:
        """Recompute indegrees and ready queue from plan and executed IDs."""

        unknown = self.executed.difference(self.plan.nodes)
        if unknown:
            raise KeyError(f"unknown executed node: {next(iter(unknown))}")
        self.indegree = {
            node_id: sum(dependency not in self.executed for dependency in node.dependencies)
            for node_id, node in self.plan.nodes.items()
        }
        self._ready = []
        self._enqueued = set()
        for node_id in self.plan.nodes:
            if node_id not in self.executed and self.indegree[node_id] == 0:
                self._ready.append(node_id)
                self._enqueued.add(node_id)
        self._ready.sort(key=self._sort_key)


__all__ = ["ExecutionPlan", "ExecutionScheduler", "PlanNode"]
