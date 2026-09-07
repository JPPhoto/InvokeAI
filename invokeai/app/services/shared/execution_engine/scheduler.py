"""Generic dependency planning and deterministic execution scheduling.

This module intentionally stores only opaque node identifiers, class names, and
frame values. Graph and invocation semantics belong to adapters above it.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Iterable, Mapping

NodeId = str
Frame = tuple[object, ...]


def _frame_key(frame: Frame) -> tuple[tuple[str, str], ...]:
    """Return a stable ordering key for mixed integer/string frame parts."""

    return tuple((type(part).__name__, repr(part)) for part in frame)


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

        if not node_id.strip():
            raise ValueError("node id must not be blank")
        if not class_name.strip():
            raise ValueError("class name must not be blank")
        if node_id in self.nodes:
            raise ValueError(f"node already exists: {node_id}")
        # Repeated dependencies represent repeated execution-graph edges and
        # must remain distinct for indegree accounting.
        dependency_ids = tuple(dependencies)
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

    def snapshot(self) -> dict[str, Any]:
        """Return a JSON-safe durable projection of this internal plan."""

        return {
            "nodes": {
                node_id: {
                    "node_id": node.node_id,
                    "class_name": node.class_name,
                    "frame": list(node.frame),
                    "dependencies": list(node.dependencies),
                    "order": node.order,
                }
                for node_id, node in self.nodes.items()
            },
            "next_order": self._next_order,
        }

    @classmethod
    def from_snapshot(cls, snapshot: Mapping[str, Any]) -> "ExecutionPlan":
        """Restore a plan using its insertion order and dependency list."""

        if not isinstance(snapshot, Mapping):
            raise ValueError("execution plan snapshot must be a mapping")
        plan = cls()
        raw_nodes = snapshot.get("nodes")
        if not isinstance(raw_nodes, Mapping):
            raise ValueError("execution plan snapshot must contain nodes")
        entries: list[tuple[int, Mapping[str, Any]]] = []
        for node_key, raw in raw_nodes.items():
            if not isinstance(raw, Mapping):
                raise ValueError("execution plan node must be a mapping")
            if raw.get("node_id") != node_key:
                raise ValueError("execution plan node key does not match node id")
            if not isinstance(raw.get("node_id"), str) or not isinstance(raw.get("class_name"), str):
                raise ValueError("execution plan node id and class name must be strings")
            order = raw.get("order")
            if not isinstance(order, int) or order < 0:
                raise ValueError("execution plan node order is invalid")
            frame = raw.get("frame", ())
            dependencies = raw.get("dependencies", ())
            if not isinstance(frame, (list, tuple)) or not isinstance(dependencies, (list, tuple)):
                raise ValueError("execution plan frame and dependencies must be sequences")
            if not all(isinstance(dependency, str) for dependency in dependencies):
                raise ValueError("execution plan dependencies must be node ids")
            entries.append((order, raw))
        for _, raw in sorted(entries, key=lambda entry: entry[0]):
            plan.add_node(
                raw["node_id"],
                raw["class_name"],
                tuple(raw.get("frame", ())),
                tuple(raw.get("dependencies", ())),
            )
        next_order = snapshot.get("next_order", plan._next_order)
        if not isinstance(next_order, int) or next_order < plan._next_order:
            raise ValueError("execution plan next order is invalid")
        plan._next_order = next_order
        return plan


class ExecutionScheduler:
    """Deterministic scheduler for an :class:`ExecutionPlan`."""

    def __init__(
        self,
        plan: ExecutionPlan,
        ready_order: Iterable[str] = (),
        executed: Iterable[NodeId] = (),
    ) -> None:
        self.plan = plan
        self.ready_order = tuple(ready_order)
        self.executed: set[NodeId] = set(executed)
        self._claimed: set[NodeId] = set()
        self.indegree: dict[NodeId, int] = {}
        self._ready: set[NodeId] = set()
        self._enqueued: set[NodeId] = set()
        self._arrival_order: dict[NodeId, int] = {}
        self._next_arrival = 0
        self._active_class: str | None = None
        self.rebuild_ready()

    def _priority(self, class_name: str) -> int:
        try:
            return self.ready_order.index(class_name)
        except ValueError:
            return len(self.ready_order)

    def enqueue(self, node_id: NodeId) -> None:
        """Queue a currently-ready node; repeated enqueue is harmless."""

        node = self.plan.nodes.get(node_id)
        if node is None:
            raise KeyError(f"unknown node: {node_id}")
        if node_id in self.executed:
            raise ValueError(f"node already completed: {node_id}")
        if node_id in self._claimed:
            return
        if node_id not in self.indegree:
            raise KeyError(f"indegree missing for node: {node_id}")
        if self.indegree[node_id] != 0:
            raise ValueError(f"node is not ready: {node_id}")
        if node_id not in self._enqueued:
            self._ready.add(node_id)
            self._enqueued.add(node_id)
            self._arrival_order[node_id] = self._next_arrival
            self._next_arrival += 1

    def _next_class(self) -> str | None:
        classes = {self.plan.nodes[node_id].class_name for node_id in self._enqueued}
        for class_name in self.ready_order:
            if class_name in classes:
                return class_name
        return min(classes) if classes else None

    def _next_id_for_class(self, class_name: str) -> NodeId:
        return min(
            (node_id for node_id in self._enqueued if self.plan.nodes[node_id].class_name == class_name),
            key=lambda node_id: (
                _frame_key(self.plan.nodes[node_id].frame),
                self._arrival_order[node_id],
            ),
        )

    def pop_next(self) -> NodeId | None:
        """Remove and return the next ready node ID, or ``None`` when empty."""

        if not self._enqueued:
            return None
        if self._active_class not in {
            self.plan.nodes[node_id].class_name for node_id in self._enqueued
        }:
            self._active_class = self._next_class()
        assert self._active_class is not None
        node_id = self._next_id_for_class(self._active_class)
        self._ready.remove(node_id)
        self._enqueued.remove(node_id)
        self._claimed.add(node_id)
        return node_id

    @property
    def ready_ids(self) -> tuple[NodeId, ...]:
        """Return queued IDs in the order they will be popped."""

        classes = {self.plan.nodes[node_id].class_name for node_id in self._enqueued}
        ordered_classes: list[str] = []
        if self._active_class in classes:
            ordered_classes.append(self._active_class)
        ordered_classes.extend(class_name for class_name in self.ready_order if class_name in classes)
        ordered_classes.extend(sorted(classes.difference(ordered_classes)))
        return tuple(
            node_id
            for class_name in ordered_classes
            for node_id in sorted(
                (node_id for node_id in self._enqueued if self.plan.nodes[node_id].class_name == class_name),
                key=lambda node_id: (
                    _frame_key(self.plan.nodes[node_id].frame),
                    self._arrival_order[node_id],
                ),
            )
        )

    def add_node(self, node: PlanNode) -> None:
        """Add a plan node without disturbing already-claimed work."""

        if node.node_id not in self.plan.nodes:
            self.plan.add_node(node.node_id, node.class_name, node.frame, node.dependencies)
        self.indegree[node.node_id] = sum(dependency not in self.executed for dependency in node.dependencies)
        if self.indegree[node.node_id] == 0 and node.node_id not in self.executed and node.node_id not in self._claimed:
            self.enqueue(node.node_id)

    def discard(self, node_id: NodeId) -> None:
        """Remove a node from queued or claimed work without completing it."""

        self._enqueued.discard(node_id)
        self._claimed.discard(node_id)
        self._ready.discard(node_id)
        self._arrival_order.pop(node_id, None)

    def set_ready_order(self, ready_order: Iterable[str]) -> None:
        """Change class priorities while retaining queued and claimed work."""

        self.ready_order = tuple(ready_order)

    def complete(self, node_id: NodeId) -> tuple[NodeId, ...]:
        """Mark node complete; return dependents newly made ready."""

        if node_id not in self.plan.nodes:
            raise KeyError(f"unknown node: {node_id}")
        if node_id in self.executed:
            raise ValueError(f"node already completed: {node_id}")
        if node_id not in self.indegree:
            raise KeyError(f"indegree missing for node: {node_id}")
        if self.indegree[node_id] != 0:
            raise ValueError(f"node is not ready: {node_id}")
        dependents = self.plan.dependents(node_id)
        for dependent in dependents:
            if dependent not in self.indegree:
                raise KeyError(f"indegree missing for node: {dependent}")
            if self.indegree[dependent] <= 0:
                raise ValueError(f"dependency underflow for node: {dependent}")
        self.executed.add(node_id)
        self._enqueued.discard(node_id)
        self._claimed.discard(node_id)
        self._ready.discard(node_id)
        self._arrival_order.pop(node_id, None)
        newly_ready: list[NodeId] = []
        for dependent in dependents:
            self.indegree[dependent] -= 1
            if self.indegree[dependent] == 0 and dependent not in self.executed:
                self.enqueue(dependent)
                newly_ready.append(dependent)
        return tuple(newly_ready)

    def rebuild_ready(self) -> None:
        """Recompute indegrees and ready queue from plan and executed IDs."""

        unknown = self.executed.difference(self.plan.nodes)
        if unknown:
            raise KeyError(f"unknown executed node: {next(iter(unknown))}")
        for node_id in self.executed:
            missing = [
                dependency for dependency in self.plan.nodes[node_id].dependencies if dependency not in self.executed
            ]
            if missing:
                raise ValueError(f"executed node {node_id} is missing prerequisite: {missing[0]}")
        self.indegree = {
            node_id: sum(dependency not in self.executed for dependency in node.dependencies)
            for node_id, node in self.plan.nodes.items()
        }
        previous_arrival = self._arrival_order
        self._ready = set()
        self._enqueued = set()
        self._arrival_order = {}
        self._next_arrival = max(previous_arrival.values(), default=-1) + 1
        for node_id in self.plan.nodes:
            if node_id not in self.executed and node_id not in self._claimed and self.indegree[node_id] == 0:
                self._ready.add(node_id)
                self._enqueued.add(node_id)
                arrival = previous_arrival.get(node_id)
                if arrival is None:
                    arrival = self._next_arrival
                    self._next_arrival += 1
                self._arrival_order[node_id] = arrival


__all__ = ["ExecutionPlan", "ExecutionScheduler", "PlanNode"]
