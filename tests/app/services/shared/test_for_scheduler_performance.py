"""Scheduler behavior and overhead for trivial loop bodies.

The required scheduler-scaling regression test counts entries traversed in the growing scheduler
ledgers. The linear-overhead check measures CPU time across repeated runs, rather than relying on a
single wall-clock sample. Optional absolute-time benchmarks remain marked `slow`. The
completion-state tests are not benchmarks.
`test_loop_scheduler_overhead_is_linear` measures CPU time, not wall clock: it compares per-item
cost at two sizes, and CPU time is not inflated when xdist workers share the runner's cores. It can
be *deflated* by them, though -- Windows charges CPU in whole 15.625ms quanta at the clock interrupt
and a contended worker misses some -- so the comparison sums its repeats rather than picking one of
them. The absolute budget below it is machine-dependent and stays `slow`, as does the sibling
`test_graph_execution_performance.py`. The completion-state tests are not benchmarks at all.
"""

import time
from collections.abc import Callable
from unittest.mock import Mock

import pytest

from invokeai.app.invocations.collections import RangeInvocation
from invokeai.app.invocations.logic import IfInvocation
from invokeai.app.invocations.loops import ForInvocation, ForReturnInvocation
from invokeai.app.invocations.primitives import BooleanInvocation
from invokeai.app.services.shared.graph import (
    CollectInvocation,
    Graph,
    GraphExecutionState,
    IterateInvocation,
    _GenericGraphSchedulerAdapter,
)
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

    def __contains__(self, key: object) -> bool:
        self._counter.record(self._mapping_name)
        return super().__contains__(key)

    def __getitem__(self, key: str) -> object:
        self._counter.record(self._mapping_name)
        return super().__getitem__(key)

    def get(self, key: str, default: object = None) -> object:  # type: ignore[override]
        self._counter.record(self._mapping_name)
        return super().get(key, default)


def _run_trivial_loop(
    loop_type: str,
    count: int,
    *,
    clock: Callable[[], float] = time.process_time,
    mapping_counter: _MappingTraversalCounter | None = None,
    include_if: bool = False,
    external_condition: bool = False,
) -> float:
    graph = Graph()
    graph.add_node(RangeInvocation(id="range", start=0, stop=count))
    graph.add_node(ForInvocation(id="loop") if loop_type == "for" else IterateInvocation(id="loop"))
    graph.add_edge(create_edge("range", "collection", "loop", "collection"))
    if include_if:
        graph.add_node(AnyTypeTestInvocation(id="true_body"))
        graph.add_node(AnyTypeTestInvocation(id="false_body"))
        graph.add_node(IfInvocation(id="if") if external_condition else IfInvocation(id="if", condition=True))
        if external_condition:
            graph.add_node(BooleanInvocation(id="condition", value=True))
            graph.add_edge(create_edge("condition", "value", "if", "condition"))
        graph.add_edge(create_edge("loop", "item", "true_body", "value"))
        graph.add_edge(create_edge("loop", "item", "false_body", "value"))
        graph.add_edge(create_edge("true_body", "value", "if", "true_input"))
        graph.add_edge(create_edge("false_body", "value", "if", "false_input"))
        output_source = "if"
    else:
        graph.add_node(AnyTypeTestInvocation(id="body"))
        graph.add_edge(create_edge("loop", "item", "body", "value"))
        output_source = "body"
    if loop_type == "for":
        graph.add_node(ForReturnInvocation(id="return"))
        graph.add_edge(create_edge(output_source, "value", "return", "output"))
        graph.add_edge(create_loop_linkage("loop", "return"))
    else:
        graph.add_node(CollectInvocation(id="collect"))
        graph.add_edge(create_edge(output_source, "value", "collect", "item"))
    state = GraphExecutionState(graph=graph)
    if mapping_counter is not None:
        scheduler = state._scheduler()
        state.execution_refs = _CountingMapping(state.execution_refs, mapping_counter, "execution_refs")  # type: ignore[assignment]
        state.execution_tokens = _CountingMapping(state.execution_tokens, mapping_counter, "execution_tokens")  # type: ignore[assignment]
        state.execution_effects = _CountingMapping(state.execution_effects, mapping_counter, "execution_effects")  # type: ignore[assignment]
        state.results = _CountingMapping(state.results, mapping_counter, "results")  # type: ignore[assignment]
        if isinstance(scheduler, _GenericGraphSchedulerAdapter):
            scheduler._scheduler.plan.nodes = _CountingMapping(
                scheduler._scheduler.plan.nodes, mapping_counter, "scheduler_plan"
            )
    context = Mock()
    started = clock()
    while (node := state.next()) is not None:
        state.complete(node.id, node.invoke(context))
    assert state.is_complete()
    return clock() - started


@pytest.mark.parametrize(
    ("loop_type", "include_if", "external_condition"),
    [
        ("iterate", False, False),
        ("for", False, False),
        ("iterate", True, False),
        ("iterate", True, True),
        ("for", True, False),
        ("for", True, True),
    ],
)
def test_loop_scheduler_does_not_rescan_growing_state(
    loop_type: str, include_if: bool, external_condition: bool
) -> None:
    visits: dict[int, int] = {}
    visits_by_mapping: dict[int, dict[str, int]] = {}
    for count in (300, 1200):
        counter = _MappingTraversalCounter()
        _run_trivial_loop(
            loop_type,
            count,
            mapping_counter=counter,
            include_if=include_if,
            external_condition=external_condition,
        )
        visits[count] = counter.entries_visited
        visits_by_mapping[count] = counter.visits_by_mapping

    # A small constant number of full mapping passes is acceptable. A pass per iteration is not:
    # it visits growing scheduler state quadratically. For covers durable effect history; Iterate covers
    # result synchronization in the generic scheduler.
    assert all(visits[count] <= count * 128 for count in visits), (
        f"mapping visits for {loop_type}, include_if={include_if}, external_condition={external_condition}: "
        f"{visits}; by mapping: {visits_by_mapping}"
    )


_REPEATS = 3


@pytest.mark.parametrize("loop_type", ["iterate", "for"])
def test_loop_scheduler_overhead_is_linear(loop_type: str) -> None:
    totals = dict.fromkeys((300, 1200), 0.0)
    for _ in range(_REPEATS):
        for count in (1200, 300):
            # CPU time, so a worker losing the core to a sibling does not read as scheduler cost.
            totals[count] += _run_trivial_loop(loop_type, count)

    # One estimate per size over all the repeats, rather than best-of-N over them. `min` assumes the
    # noise only ever inflates a sample, and on a contended Windows runner it does not: CPU time is
    # charged in whole 15.625ms quanta at the clock interrupt, and a worker sharing four vCPUs under
    # `-n logical` misses some of them, so a reading can come back *short*. It came back at exactly
    # 0.0 for a 300-item run that the 1200 reading beside it puts at ~250ms -- sixteen quanta, which
    # no rounding can turn into zero -- and `min` took that for the fastest run, leaving the
    # threshold at `0.0 * 2.5`.
    # From there the assertion could not be satisfied by any scheduler. Summing absorbs a short
    # reading instead of selecting it, and averages an inflated one instead of being blind to it.
    for count, total in totals.items():
        assert total, f"{loop_type}: the CPU clock did not advance across any {count}-item run ({totals})"
    per_node = {count: total / (_REPEATS * count) for count, total in totals.items()}

    # Linear scheduling keeps per-item cost flat. The quadratic regression scaled per-item cost with
    # the item count - about 4x between 300 and 1200 - so 2.5x leaves noise headroom on both sides.
    assert per_node[1200] < per_node[300] * 2.5, f"{loop_type}: {per_node}"


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
