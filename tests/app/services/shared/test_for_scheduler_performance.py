"""Scheduler behavior and overhead for trivial loop bodies.

The required scheduler-scaling regression test counts entries traversed in the growing scheduler
ledgers. Optional absolute-time benchmarks remain marked `slow`. The completion-state tests are not
benchmarks.
"""

import time
from collections.abc import Callable
from unittest.mock import Mock

import pytest

from invokeai.app.invocations.collections import RangeInvocation
from invokeai.app.invocations.loops import ForInvocation, ForReturnInvocation
from invokeai.app.services.shared.graph import CollectInvocation, Graph, GraphExecutionState, IterateInvocation
from tests.test_nodes import AnyTypeTestInvocation, create_edge, create_loop_linkage


class _MappingTraversalCounter:
    def __init__(self) -> None:
        self.entries_visited = 0
        self.visits_by_mapping: dict[str, int] = {}

    def record(self, mapping_name: str) -> None:
        self.entries_visited += 1
        self.visits_by_mapping[mapping_name] = self.visits_by_mapping.get(mapping_name, 0) + 1


class _CountingMapping(dict[str, object]):
    """Count mapping-entry traversal without constraining the scheduler algorithm."""

    def __init__(self, values: dict[str, object], counter: _MappingTraversalCounter, mapping_name: str) -> None:
        super().__init__()
        self.update(values)
        self._counter = counter
        self._mapping_name = mapping_name

    def items(self):  # type: ignore[override]
        for item in super().items():
            self._counter.record(self._mapping_name)
            yield item

    def values(self):  # type: ignore[override]
        for value in super().values():
            self._counter.record(self._mapping_name)
            yield value

    def keys(self):  # type: ignore[override]
        for key in super().keys():
            self._counter.record(self._mapping_name)
            yield key

    def __iter__(self):  # type: ignore[override]
        for key in super().__iter__():
            self._counter.record(self._mapping_name)
            yield key


def _run_trivial_loop(
    loop_type: str,
    count: int,
    *,
    clock: Callable[[], float] = time.process_time,
    mapping_counter: _MappingTraversalCounter | None = None,
) -> float:
    graph = Graph()
    graph.add_node(RangeInvocation(id="range", start=0, stop=count))
    graph.add_node(ForInvocation(id="loop") if loop_type == "for" else IterateInvocation(id="loop"))
    graph.add_node(AnyTypeTestInvocation(id="body"))
    graph.add_edge(create_edge("range", "collection", "loop", "collection"))
    graph.add_edge(create_edge("loop", "item", "body", "value"))
    if loop_type == "for":
        graph.add_node(ForReturnInvocation(id="return"))
        graph.add_edge(create_edge("body", "value", "return", "output"))
        graph.add_edge(create_loop_linkage("loop", "return"))
    else:
        graph.add_node(CollectInvocation(id="collect"))
        graph.add_edge(create_edge("body", "value", "collect", "item"))
    state = GraphExecutionState(graph=graph)
    if mapping_counter is not None:
        state._scheduler()
        state.execution_effects = _CountingMapping(state.execution_effects, mapping_counter, "execution_effects")
        state.results = _CountingMapping(state.results, mapping_counter, "results")
    context = Mock()
    started = clock()
    while (node := state.next()) is not None:
        state.complete(node.id, node.invoke(context))
    assert state.is_complete()
    return clock() - started


@pytest.mark.parametrize("loop_type", ["iterate", "for"])
def test_loop_scheduler_does_not_rescan_growing_state(loop_type: str) -> None:
    visits: dict[int, int] = {}
    visits_by_mapping: dict[int, dict[str, int]] = {}
    for count in (300, 1200):
        counter = _MappingTraversalCounter()
        _run_trivial_loop(loop_type, count, mapping_counter=counter)
        visits[count] = counter.entries_visited
        visits_by_mapping[count] = counter.visits_by_mapping

    # A small constant number of full mapping passes is acceptable. A pass per iteration is not:
    # it visits growing scheduler state quadratically. For covers durable effect history; Iterate covers
    # result synchronization in the generic scheduler.
    assert all(visits[count] <= count * 32 for count in visits), (
        f"mapping visits for {loop_type}: {visits}; by mapping: {visits_by_mapping}"
    )


@pytest.mark.slow
def test_for_loop_scheduler_overhead_is_linear_with_wall_clock() -> None:
    """Use wall clock for the For guard so Windows' coarse process clock cannot quantize the baseline."""
    timings: dict[int, list[float]] = {count: [] for count in (300, 1200)}
    for _ in range(5):
        for count in (1200, 300):
            timings[count].append(_run_trivial_loop("for", count) / count)
    per_node = {count: min(samples) for count, samples in timings.items()}
    assert per_node[1200] < per_node[300] * 1.5, f"for: {per_node}"


@pytest.mark.slow
@pytest.mark.parametrize("loop_type", ["for", "iterate"])
def test_trivial_loop_scheduler_overhead(loop_type: str) -> None:
    elapsed = _run_trivial_loop(loop_type, 600)
    # Generous headroom for shared CI hosts; the reported quadratic For regression took six seconds.
    assert elapsed < 4, f"{loop_type}: {elapsed:.3f}s for 600 items"


def test_completion_predicate_preserves_durable_state() -> None:
    graph = Graph()
    graph.add_node(AnyTypeTestInvocation(id="value", value=1))
    state = GraphExecutionState(graph=graph)
    node = state.next()
    assert node is not None
    state.complete(node.id, node.invoke(Mock()))
    # A restored session may have completed executions without the derived source history yet.
    state.executed.discard("value")
    state.executed_history.clear()
    before = state.model_dump_json()
    assert state.is_complete()
    assert state.model_dump_json() == before
    restored_state = GraphExecutionState.model_validate_json(before)
    # Legacy complete() snapshots intentionally gain their derived execution references on restore.
    restored_before = restored_state.model_dump_json()
    assert restored_state.execution_refs
    assert restored_state.is_complete()
    assert restored_state.model_dump_json() == restored_before


def test_completion_cache_preserves_completed_sources_after_restore() -> None:
    graph = Graph()
    graph.add_node(AnyTypeTestInvocation(id="first", value=1))
    graph.add_node(AnyTypeTestInvocation(id="second", value=2))
    state = GraphExecutionState(graph=graph)

    first = state.next()
    assert first is not None
    state.complete(first.id, first.invoke(Mock()))

    restored_state = GraphExecutionState.model_validate_json(state.model_dump_json())
    second = restored_state.next()
    assert second is not None
    restored_state.complete(second.id, second.invoke(Mock()))

    assert restored_state.is_complete()
