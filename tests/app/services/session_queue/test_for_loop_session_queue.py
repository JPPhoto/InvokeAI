import uuid
from unittest.mock import Mock

import pytest
from pydantic import TypeAdapter

from invokeai.app.invocations.baseinvocation import InvocationContext
from invokeai.app.invocations.loops import (
    ForInvocation,
    ForReturnInvocation,
    StateGetInvocation,
    StateSetInvocation,
)
from invokeai.app.services.invoker import Invoker
from invokeai.app.services.session_queue.session_queue_sqlite import SqliteSessionQueue
from invokeai.app.services.shared.graph import Graph, GraphExecutionState
from tests.test_nodes import AnyTypeTestInvocation, create_edge


@pytest.fixture
def session_queue(mock_invoker: Invoker) -> SqliteSessionQueue:
    queue = SqliteSessionQueue(db=mock_invoker.services.board_records._db)
    queue.start(mock_invoker)
    return queue


def _execute_next(state: GraphExecutionState) -> str | None:
    node = state.next()
    if node is None:
        return None
    output = node.invoke(Mock(InvocationContext))
    state.complete(node.id, output)
    return state.prepared_source_mapping[node.id]


def _stateful_for_graph() -> Graph:
    graph = Graph()
    graph.add_node(ForInvocation(id="for", collection=["alpha", "beta", "charlie"]))
    graph.add_node(StateSetInvocation(id="state_set", key="last_item"))
    graph.add_node(ForReturnInvocation(id="return"))
    graph.add_node(AnyTypeTestInvocation(id="after_collection"))
    graph.add_node(StateGetInvocation(id="after_state", key="last_item"))
    graph.add_edge(create_edge("for", "state", "state_set", "state"))
    graph.add_edge(create_edge("for", "item", "state_set", "value"))
    graph.add_edge(create_edge("state_set", "state", "return", "state"))
    graph.add_edge(create_edge("for", "output_collection", "after_collection", "value"))
    graph.add_edge(create_edge("for", "final_state", "after_state", "state"))
    graph.add_edge(create_edge("for", "item", "return", "output"))
    return graph


def _insert_session(queue: SqliteSessionQueue, state: GraphExecutionState) -> int:
    session_id = str(uuid.uuid4())
    batch_id = str(uuid.uuid4())
    session_json = state.model_dump_json(warnings=False, exclude_none=True)
    with queue._db.transaction() as cursor:
        cursor.execute(
            """--sql
            INSERT INTO session_queue (
                queue_id, session, session_id, batch_id, field_values, priority,
                workflow, origin, destination, retried_from_item_id, user_id
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            ("default", session_json, session_id, batch_id, None, 0, None, None, None, None, "system"),
        )
        return cursor.lastrowid  # type: ignore[return-value]


def test_sqlite_queue_resumes_partial_stateful_for_loop(session_queue: SqliteSessionQueue) -> None:
    item_id = _insert_session(session_queue, GraphExecutionState(graph=_stateful_for_graph()))

    queue_item = session_queue.dequeue()
    assert queue_item is not None
    assert queue_item.item_id == item_id
    state = queue_item.session

    # Finish the first iteration, then persist the in-progress state through SQLite.
    assert [_execute_next(state) for _ in range(3)] == ["for", "state_set", "return"]
    prepared_mapping = state.prepared_source_mapping.copy()
    # Use the GraphExecutionState JSON contract as the oracle for private prepared metadata.
    direct_round_trip = TypeAdapter(GraphExecutionState).validate_json(
        state.model_dump_json(warnings=False, exclude_none=True), strict=False
    )
    direct_iteration_paths = {
        exec_id: direct_round_trip._prepared_registry().get_iteration_path(exec_id) for exec_id in prepared_mapping
    }
    session_queue.save_queue_item_session(queue_item.item_id, state)

    reloaded_item = session_queue.get_queue_item(queue_item.item_id)
    resumed = reloaded_item.session
    assert resumed.prepared_source_mapping == prepared_mapping
    assert {
        exec_id: resumed._prepared_registry().get_iteration_path(exec_id) for exec_id in prepared_mapping
    } == direct_iteration_paths
    assert not resumed.is_complete()
    assert "after_collection" not in resumed.prepared_source_mapping.values()

    remaining_sources: list[str] = []
    while (source_id := _execute_next(resumed)) is not None:
        remaining_sources.append(source_id)

    assert remaining_sources == [
        "for",
        "state_set",
        "return",
        "for",
        "state_set",
        "return",
        "after_collection",
        "after_state",
    ]
    assert resumed.is_complete()

    after_collection_id = next(
        exec_id for exec_id, source_id in resumed.prepared_source_mapping.items() if source_id == "after_collection"
    )
    after_state_id = next(
        exec_id for exec_id, source_id in resumed.prepared_source_mapping.items() if source_id == "after_state"
    )
    assert resumed.results[after_collection_id].value == ["alpha", "beta", "charlie"]
    assert resumed.results[after_state_id].value == "charlie"

    session_queue.set_queue_item_session(queue_item.item_id, resumed)
    final_item = session_queue.complete_queue_item(queue_item.item_id)
    assert final_item.status == "completed"
    assert final_item.session.is_complete()
    assert final_item.session.results[after_collection_id].value == ["alpha", "beta", "charlie"]
    assert final_item.session.results[after_state_id].value == "charlie"
