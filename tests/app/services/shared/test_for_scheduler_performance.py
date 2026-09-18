"""Scheduler behavior and overhead for trivial loop bodies.

`test_loop_scheduler_overhead_is_linear` measures CPU time, not wall clock: it compares per-item
cost at two sizes, and CPU time is not inflated when xdist workers share the runner's cores. It can
be *deflated* by them, though -- Windows charges CPU in whole 15.625ms quanta at the clock interrupt
and a contended worker misses some -- so the comparison sums its repeats rather than picking one of
them. The absolute budget below it is machine-dependent and stays `slow`, as does the sibling
`test_graph_execution_performance.py`. The completion-state tests are not benchmarks at all.
"""

import time
from unittest.mock import Mock

import pytest

from invokeai.app.invocations.collections import RangeInvocation
from invokeai.app.invocations.loops import ForInvocation, ForReturnInvocation
from invokeai.app.services.shared.graph import CollectInvocation, Graph, GraphExecutionState, IterateInvocation
from tests.test_nodes import AnyTypeTestInvocation, create_edge, create_loop_linkage


def _run_trivial_loop(loop_type: str, count: int) -> float:
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
    context = Mock()
    started = time.process_time()
    while (node := state.next()) is not None:
        state.complete(node.id, node.invoke(context))
    assert state.is_complete()
    return time.process_time() - started


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
    assert restored_state.is_complete()
    assert restored_state.model_dump_json() == before


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
