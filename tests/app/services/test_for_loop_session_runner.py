from threading import Event
from types import SimpleNamespace
from typing import Any

import pytest

from invokeai.app.invocations.baseinvocation import BaseInvocation, BaseInvocationOutput, invocation, invocation_output
from invokeai.app.invocations.fields import InputField, OutputField
from invokeai.app.invocations.loops import ForInvocation, ForInvocationOutput, ForReturnInvocation
from invokeai.app.services.session_processor.session_processor_default import DefaultSessionRunner
from invokeai.app.services.shared.graph import Graph, GraphExecutionState
from invokeai.app.services.shared.invocation_context import InvocationContext
from tests.app.services.workflow_call_test_utils import (
    _DummyConfig,
    _DummyEvents,
    _DummyLogger,
    _DummySessionQueue,
    _DummyStats,
)
from tests.test_nodes import create_edge


@invocation_output("test_for_runner_value_output")
class ForRunnerValueOutput(BaseInvocationOutput):
    value: int = OutputField(description="The loop body value")


@invocation("test_for_runner_body", version="1.0.0")
class ForRunnerBodyInvocation(BaseInvocation):
    value: int = InputField(default=0, description="The current loop item")
    fail_on: int | None = InputField(default=None, description="The value that raises an exception")

    def invoke(self, context: InvocationContext) -> ForRunnerValueOutput:
        if self.value == self.fail_on:
            raise ValueError(f"Refusing loop value {self.value}")
        return ForRunnerValueOutput(value=self.value)


@invocation_output("test_for_runner_collection_output")
class ForRunnerCollectionOutput(BaseInvocationOutput):
    collection: list[Any] = OutputField(description="The completed loop collection")


@invocation("test_for_runner_collection", version="1.0.0")
class ForRunnerCollectionInvocation(BaseInvocation):
    collection: list[Any] = InputField(default_factory=list, description="The completed loop collection")

    def invoke(self, context: InvocationContext) -> ForRunnerCollectionOutput:
        return ForRunnerCollectionOutput(collection=self.collection)


def _build_graph(*, fail_on: int | None = None) -> Graph:
    graph = Graph()
    graph.add_node(ForInvocation(id="for", collection=[1, 2, 3]))
    graph.add_node(ForRunnerBodyInvocation(id="body", fail_on=fail_on))
    graph.add_node(ForReturnInvocation(id="return"))
    graph.add_node(ForRunnerCollectionInvocation(id="after"))
    graph.add_edge(create_edge("for", "item", "body", "value"))
    graph.add_edge(create_edge("body", "value", "return", "output"))
    graph.add_edge(create_edge("for", "output_collection", "after", "collection"))
    return graph


def _build_runner(
    monkeypatch: pytest.MonkeyPatch,
    *,
    on_after_run_node=None,
) -> tuple[DefaultSessionRunner, Event, _DummySessionQueue, _DummyEvents]:
    monkeypatch.setattr(
        "invokeai.app.services.session_processor.session_processor_default.build_invocation_context",
        lambda data, services, is_canceled: None,
    )

    cancel_event = Event()
    session_queue = _DummySessionQueue()
    events = _DummyEvents()
    runner = DefaultSessionRunner(on_after_run_node_callbacks=[] if on_after_run_node is None else [on_after_run_node])
    runner.start(
        services=SimpleNamespace(
            performance_statistics=_DummyStats(),
            events=events,
            logger=_DummyLogger(),
            configuration=_DummyConfig(),
            session_queue=session_queue,
        ),
        cancel_event=cancel_event,
    )
    return runner, cancel_event, session_queue, events


def _build_queue_item(session: GraphExecutionState) -> SimpleNamespace:
    return SimpleNamespace(
        item_id=1,
        status="in_progress",
        session=session,
        session_id=session.id,
    )


def _completed_source_ids(events: _DummyEvents, session: GraphExecutionState) -> list[str]:
    return [session.prepared_source_mapping[invocation.id] for invocation, _queue_item, _output in events.completed]


def test_session_runner_completes_for_loop_and_persists_final_outputs(monkeypatch: pytest.MonkeyPatch) -> None:
    session = GraphExecutionState(graph=_build_graph())
    runner, _cancel_event, session_queue, events = _build_runner(monkeypatch)
    queue_item = _build_queue_item(session)
    session_queue.add_queue_item(queue_item)

    runner.run(queue_item)

    assert queue_item.status == "completed"
    assert session_queue.completed_item_ids == [queue_item.item_id]
    assert session_queue.session_updates[-1] == (queue_item.item_id, session)
    assert session.is_complete()
    assert _completed_source_ids(events, session).count("for") == 3
    assert _completed_source_ids(events, session).count("body") == 3
    assert _completed_source_ids(events, session).count("return") == 3
    assert _completed_source_ids(events, session)[-1] == "after"

    [after_exec_id] = session.source_prepared_mapping["after"]
    assert session.results[after_exec_id] == ForRunnerCollectionOutput(collection=[1, 2, 3])
    assert any(
        isinstance(output := session.results.get(exec_id), ForInvocationOutput)
        and output.output_collection == [1, 2, 3]
        for exec_id in session.source_prepared_mapping["for"]
    )


def test_session_runner_cancellation_stops_for_loop_without_releasing_final_outputs(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    session = GraphExecutionState(graph=_build_graph())
    callback_state: dict[str, Any] = {}

    def cancel_after_first_return(invocation, queue_item, output) -> None:
        session_queue = callback_state["session_queue"]
        cancel_event = callback_state["cancel_event"]
        if queue_item.session.prepared_source_mapping[invocation.id] == "return":
            session_queue.cancel_queue_item(queue_item.item_id)
            cancel_event.set()

    runner, cancel_event, session_queue, events = _build_runner(
        monkeypatch, on_after_run_node=cancel_after_first_return
    )
    callback_state.update(cancel_event=cancel_event, session_queue=session_queue)
    queue_item = _build_queue_item(session)
    session_queue.add_queue_item(queue_item)

    runner.run(queue_item)

    completed_source_ids = _completed_source_ids(events, session)
    assert queue_item.status == "canceled"
    assert session_queue.canceled_item_ids == [queue_item.item_id]
    assert session_queue.completed_item_ids == []
    assert session_queue.session_updates[-1] == (queue_item.item_id, session)
    assert not session.is_complete()
    assert completed_source_ids.count("for") == 1
    assert completed_source_ids.count("body") == 1
    assert completed_source_ids.count("return") == 1
    assert "after" not in session.source_prepared_mapping
    assert "for" not in session.finalized_loop_nodes
    assert len(session.source_prepared_mapping["for"]) == 2
    assert sum(exec_id in session.results for exec_id in session.source_prepared_mapping["for"]) == 1
    assert not any(
        isinstance(output := session.results.get(exec_id), ForInvocationOutput) and output.output_collection
        for exec_id in session.source_prepared_mapping["for"]
    )


def test_session_runner_body_exception_fails_and_cleans_up_for_loop(monkeypatch: pytest.MonkeyPatch) -> None:
    session = GraphExecutionState(graph=_build_graph(fail_on=2))
    runner, _cancel_event, session_queue, events = _build_runner(monkeypatch)
    queue_item = _build_queue_item(session)
    session_queue.add_queue_item(queue_item)

    runner.run(queue_item)

    completed_source_ids = _completed_source_ids(events, session)
    assert queue_item.status == "failed"
    assert session_queue.failed_item_ids == [queue_item.item_id]
    assert session_queue.completed_item_ids == []
    assert session_queue.session_updates[-1] == (queue_item.item_id, session)
    assert session.has_error()
    assert len(session.errors) == 1
    [failed_exec_id] = session.errors
    assert session.prepared_source_mapping[failed_exec_id] == "body"
    assert session.errors[failed_exec_id] == "ValueError: Refusing loop value 2"
    assert failed_exec_id not in session.results
    assert len(events.errors) == 1
    assert events.errors[0][1].id == failed_exec_id
    assert completed_source_ids.count("for") == 2
    assert completed_source_ids.count("body") == 1
    assert completed_source_ids.count("return") == 1
    assert "after" not in session.source_prepared_mapping
    assert "for" not in session.finalized_loop_nodes
    assert len(session.source_prepared_mapping["for"]) == 2
    assert session.next() is None
    assert not any(
        isinstance(output := session.results.get(exec_id), ForInvocationOutput) and output.output_collection
        for exec_id in session.source_prepared_mapping["for"]
    )
