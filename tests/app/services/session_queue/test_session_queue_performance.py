"""Diagnostic performance tests for large persisted queue-item sessions.

Run with:

    pytest -n auto -m slow -rP tests/app/services/session_queue/test_session_queue_performance.py

These tests intentionally print timings. Assertions cover relative costs and data flow, not
machine-specific absolute timing budgets.
"""

import asyncio
import gc
import json
import statistics
import time
import uuid
from collections.abc import Callable
from typing import Any

import pytest
from fastapi import FastAPI
from httpx import ASGITransport, AsyncClient
from pydantic import TypeAdapter

from invokeai.app.api.auth_dependencies import get_current_user_or_default
from invokeai.app.api.dependencies import ApiDependencies
from invokeai.app.api.routers.session_queue import get_queue_items_by_item_ids, session_queue_router
from invokeai.app.services.auth.token_service import TokenData
from invokeai.app.services.invoker import Invoker
from invokeai.app.services.session_queue import session_queue_common
from invokeai.app.services.session_queue.session_queue_common import ItemIdsResult, SessionQueueItem
from invokeai.app.services.session_queue.session_queue_sqlite import SqliteSessionQueue
from invokeai.app.services.shared.graph import Graph, GraphExecutionState
from tests.test_nodes import PromptTestInvocation, PromptTestInvocationOutput

pytestmark = pytest.mark.slow

TARGET_LARGE_SESSION_BYTES = 8 * 1024 * 1024
EXPANDED_NODE_COUNT = 1_000
LARGE_HISTORY_COUNT = 20_000


def _measure_ms(callback: Callable[[], Any], repeats: int = 3) -> tuple[float, Any]:
    durations: list[float] = []
    result: Any = None
    for _ in range(repeats):
        gc.collect()
        started = time.perf_counter()
        result = callback()
        durations.append((time.perf_counter() - started) * 1_000)
    return statistics.median(durations), result


def _build_small_session() -> GraphExecutionState:
    graph = Graph()
    graph.add_node(PromptTestInvocation(id="source", prompt="small"))
    return GraphExecutionState(graph=graph)


def _build_large_completed_session() -> GraphExecutionState:
    graph = Graph()
    graph.add_node(PromptTestInvocation(id="source", prompt="source"))
    session = GraphExecutionState(graph=graph)

    # An iterator materializes many execution nodes and retains their public results. A roughly
    # 4 KiB value in each node and result yields a little over 8 MiB of persisted execution state,
    # matching the reported queue item while keeping the fixture deterministic.
    payload = "x" * 4200
    prepared_ids: set[str] = set()
    for index in range(EXPANDED_NODE_COUNT):
        node_id = f"source_{index}"
        session.execution_graph.add_node(PromptTestInvocation(id=node_id, prompt=payload))
        session.executed.add(node_id)
        session.executed_history.append(node_id)
        session.results[node_id] = PromptTestInvocationOutput(prompt=payload)
        session.prepared_source_mapping[node_id] = "source"
        session.prepared_iteration_paths[node_id] = (index,)
        prepared_ids.add(node_id)
    session.source_prepared_mapping["source"] = prepared_ids
    return session


def _insert_completed_item(
    queue: SqliteSessionQueue,
    session_json: str,
    session_id: str,
    *,
    destination: str = "workflows",
) -> int:
    with queue._db.transaction() as cursor:
        cursor.execute(
            """--sql
            INSERT INTO session_queue (
                queue_id, session, session_id, batch_id, field_values, status,
                priority, workflow, origin, destination, retried_from_item_id, user_id
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                "default",
                session_json,
                session_id,
                str(uuid.uuid4()),
                None,
                "completed",
                0,
                None,
                "workflows",
                destination,
                None,
                "system",
            ),
        )
        item_id = cursor.lastrowid
    assert item_id is not None
    return item_id


def _format_plan(rows: list[Any]) -> list[str]:
    return [row["detail"] for row in rows]


def _seed_completed_history(
    queue: SqliteSessionQueue, session_json: str, *, start: int, count: int, destination: str = "workflows"
) -> None:
    rows = [
        (
            "default",
            session_json,
            f"history-{index}",
            f"batch-{index}",
            "completed",
            0,
            "workflows",
            destination,
            "system",
        )
        for index in range(start, start + count)
    ]
    with queue._db.transaction() as cursor:
        cursor.executemany(
            """--sql
            INSERT INTO session_queue (
                queue_id, session, session_id, batch_id, status,
                priority, origin, destination, user_id
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            rows,
        )


async def _measure_endpoint_event_loop_block_ms(item_ids: list[int]) -> tuple[float, float, list[SessionQueueItem]]:
    max_heartbeat_gap_ms = 0.0
    should_stop = False

    async def heartbeat() -> None:
        nonlocal max_heartbeat_gap_ms
        previous = time.perf_counter()
        while not should_stop:
            await asyncio.sleep(0.001)
            current = time.perf_counter()
            max_heartbeat_gap_ms = max(max_heartbeat_gap_ms, (current - previous) * 1_000)
            previous = current

    heartbeat_task = asyncio.create_task(heartbeat())
    await asyncio.sleep(0)
    started = time.perf_counter()
    items = await get_queue_items_by_item_ids(
        current_user=TokenData(user_id="system", email="system@invoke.ai", is_admin=True),
        queue_id="default",
        item_ids=item_ids,
    )
    endpoint_ms = (time.perf_counter() - started) * 1_000
    # Give heartbeat one turn to observe time during which endpoint never yielded.
    await asyncio.sleep(0.002)
    should_stop = True
    await heartbeat_task
    return endpoint_ms, max_heartbeat_gap_ms, items


async def _measure_asgi_request(
    item_ids: list[int],
) -> tuple[float, float, float, int, int, float]:
    """Measure actual ASGI routing, response serialization, JSON decoding, and request starvation."""
    app = FastAPI()
    app.include_router(session_queue_router, prefix="/api")

    @app.get("/ping")
    async def ping() -> dict[str, bool]:
        return {"ok": True}

    async def get_test_user() -> TokenData:
        return TokenData(user_id="system", email="system@invoke.ai", is_admin=True)

    app.dependency_overrides[get_current_user_or_default] = get_test_user

    max_heartbeat_gap_ms = 0.0
    should_stop = False

    async def heartbeat() -> None:
        nonlocal max_heartbeat_gap_ms
        previous = time.perf_counter()
        while not should_stop:
            await asyncio.sleep(0.001)
            current = time.perf_counter()
            max_heartbeat_gap_ms = max(max_heartbeat_gap_ms, (current - previous) * 1_000)
            previous = current

    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as client:
        heartbeat_task = asyncio.create_task(heartbeat())
        await asyncio.sleep(0)
        queued_at = time.perf_counter()

        async def request_items() -> tuple[float, Any]:
            response = await client.post("/api/v1/queue/default/items_by_ids", json={"item_ids": item_ids})
            return (time.perf_counter() - queued_at) * 1_000, response

        async def request_ping() -> tuple[float, Any]:
            response = await client.get("/ping")
            return (time.perf_counter() - queued_at) * 1_000, response

        # The queue request is scheduled first. Its async route performs synchronous DB reads and
        # Pydantic graph hydration, so the lightweight request cannot run until that work yields.
        items_task = asyncio.create_task(request_items())
        ping_task = asyncio.create_task(request_ping())
        (request_ms, items_response), (ping_ms, ping_response) = await asyncio.gather(items_task, ping_task)
        await asyncio.sleep(0.002)
        should_stop = True
        await heartbeat_task

    assert items_response.status_code == 200
    assert ping_response.status_code == 200
    response_size_bytes = len(items_response.content)
    decode_started = time.perf_counter()
    response_data = items_response.json()
    response_decode_ms = (time.perf_counter() - decode_started) * 1_000
    return request_ms, ping_ms, max_heartbeat_gap_ms, response_size_bytes, len(response_data), response_decode_ms


def test_large_completed_queue_item_costs(mock_invoker: Invoker, monkeypatch: pytest.MonkeyPatch) -> None:
    """Separate metadata-query cost from full-session hydration and response parsing."""
    queue = SqliteSessionQueue(db=mock_invoker.services.board_records._db)
    queue.start(mock_invoker)

    small_session = _build_small_session()
    small_json = small_session.model_dump_json(warnings=False, exclude_none=True)
    large_session = _build_large_completed_session()
    assert len(large_session.prepared_iteration_paths) == EXPANDED_NODE_COUNT
    large_json = large_session.model_dump_json(warnings=False, exclude_none=True)
    large_size_bytes = len(large_json.encode())
    assert large_size_bytes >= TARGET_LARGE_SESSION_BYTES

    small_item_ids = [_insert_completed_item(queue, small_json, f"small-{index}-{uuid.uuid4()}") for index in range(2)]
    large_item_id = _insert_completed_item(queue, large_json, f"large-{uuid.uuid4()}")
    all_item_ids = [*small_item_ids, large_item_id]

    original_get_session = session_queue_common.get_session
    session_parse_count = 0

    def counting_get_session(queue_item_dict: dict[str, Any]) -> GraphExecutionState:
        nonlocal session_parse_count
        session_parse_count += 1
        return original_get_session(queue_item_dict)

    monkeypatch.setattr(session_queue_common, "get_session", counting_get_session)

    session_parse_count = 0
    item_ids_ms, item_ids = _measure_ms(lambda: queue.get_queue_item_ids("default"))
    assert session_parse_count == 0
    assert set(item_ids.item_ids) == set(all_item_ids)

    session_parse_count = 0
    status_ms, status = _measure_ms(lambda: queue.get_queue_status("default"))
    assert session_parse_count == 0
    assert status.completed == 3

    session_parse_count = 0
    destination_counts_ms, destination_counts = _measure_ms(
        lambda: queue.get_counts_by_destination("default", "workflows")
    )
    assert session_parse_count == 0
    assert destination_counts.completed == 3

    with queue._db.transaction() as cursor:
        cursor.execute("UPDATE session_queue SET status = 'in_progress' WHERE item_id = ?", (large_item_id,))

    session_parse_count = 0
    active_status_ms, active_status = _measure_ms(lambda: queue.get_queue_status("default"))
    assert session_parse_count == 0
    assert active_status.item_id == large_item_id

    session_parse_count = 0
    current_item_ms, current_item = _measure_ms(lambda: queue.get_current("default"))
    assert session_parse_count == 3
    assert current_item is not None and current_item.item_id == large_item_id

    with queue._db.transaction() as cursor:
        cursor.execute("UPDATE session_queue SET status = 'completed' WHERE item_id = ?", (large_item_id,))

    session_parse_count = 0
    large_item_ms, large_item = _measure_ms(lambda: queue.get_queue_item(large_item_id))
    assert session_parse_count == 3
    assert large_item.item_id == large_item_id

    session_parse_count = 0

    def hydrate_visible_items() -> list[SessionQueueItem]:
        return [queue.get_queue_item(item_id) for item_id in all_item_ids]

    hydration_ms, hydrated_items = _measure_ms(hydrate_visible_items)
    assert session_parse_count == len(all_item_ids) * 3

    session_parse_count = 0
    list_all_ms, listed_items = _measure_ms(lambda: queue.list_all_queue_items("default"))
    assert session_parse_count == len(all_item_ids) * 3
    assert len(listed_items) == 3

    monkeypatch.setattr(ApiDependencies, "invoker", mock_invoker, raising=False)
    monkeypatch.setattr(mock_invoker.services, "session_queue", queue)
    session_parse_count = 0
    endpoint_ms, heartbeat_gap_ms, endpoint_items = asyncio.run(_measure_endpoint_event_loop_block_ms(all_item_ids))
    assert session_parse_count == len(all_item_ids)
    assert len(endpoint_items) == 3
    assert heartbeat_gap_ms >= endpoint_ms * 0.8

    session_parse_count = 0
    asgi_ms, ping_ms, asgi_heartbeat_gap_ms, asgi_response_size_bytes, asgi_item_count, asgi_decode_ms = asyncio.run(
        _measure_asgi_request(all_item_ids)
    )
    assert session_parse_count == len(all_item_ids)
    assert asgi_item_count == 3
    assert asgi_response_size_bytes >= large_size_bytes
    assert asgi_heartbeat_gap_ms >= asgi_ms * 0.8
    assert ping_ms >= asgi_ms * 0.8

    response_adapter = TypeAdapter(list[SessionQueueItem])
    response_encode_ms, response_json = _measure_ms(
        lambda: response_adapter.dump_json(hydrated_items, exclude_none=True),
        repeats=3,
    )
    response_size_bytes = len(response_json)
    assert response_size_bytes >= large_size_bytes

    response_decode_ms, decoded_response = _measure_ms(lambda: json.loads(response_json), repeats=3)
    assert len(decoded_response) == 3

    additional_large_item_ids = [
        _insert_completed_item(queue, large_json, f"large-{index}-{uuid.uuid4()}") for index in range(2)
    ]
    three_large_item_ids = [large_item_id, *additional_large_item_ids]
    session_parse_count = 0
    (
        three_large_asgi_ms,
        three_large_ping_ms,
        three_large_heartbeat_gap_ms,
        three_large_response_size_bytes,
        three_large_item_count,
        three_large_decode_ms,
    ) = asyncio.run(_measure_asgi_request(three_large_item_ids))
    assert session_parse_count == 3
    assert three_large_item_count == 3
    assert three_large_response_size_bytes >= large_size_bytes * 3
    assert three_large_asgi_ms > asgi_ms * 2
    assert three_large_ping_ms >= three_large_asgi_ms * 0.8
    assert three_large_heartbeat_gap_ms >= three_large_asgi_ms * 0.8

    ids_adapter = TypeAdapter(ItemIdsResult)
    ids_response = ids_adapter.dump_json(item_ids)
    ids_decode_ms, decoded_ids = _measure_ms(lambda: json.loads(ids_response), repeats=3)
    assert len(decoded_ids["item_ids"]) == 3

    metadata_max_ms = max(item_ids_ms, status_ms, destination_counts_ms)
    assert large_item_ms > metadata_max_ms * 5
    assert hydration_ms > metadata_max_ms * 5
    assert list_all_ms > metadata_max_ms * 5
    assert current_item_ms > active_status_ms * 5
    assert response_decode_ms > ids_decode_ms * 5

    with queue._db.transaction() as cursor:
        item_ids_plan = _format_plan(
            cursor.execute(
                """--sql
                EXPLAIN QUERY PLAN
                SELECT item_id
                FROM session_queue
                WHERE queue_id = ?
                ORDER BY created_at DESC
                """,
                ("default",),
            ).fetchall()
        )
        destination_counts_plan = _format_plan(
            cursor.execute(
                """--sql
                EXPLAIN QUERY PLAN
                SELECT status, count(*)
                FROM session_queue
                WHERE queue_id = ? AND destination = ?
                GROUP BY status
                """,
                ("default", "workflows"),
            ).fetchall()
        )

    print(
        "\nQueue performance diagnostics:"
        f"\n  persisted large session: {large_size_bytes / 1024 / 1024:.2f} MiB"
        f"\n  GET item_ids service: {item_ids_ms:.3f} ms, no session parse"
        f"\n  GET status service, idle queue: {status_ms:.3f} ms, no session parse"
        f"\n  GET counts_by_destination service: {destination_counts_ms:.3f} ms, no session parse"
        f"\n  GET status service, large current item: {active_status_ms:.3f} ms, no session parse"
        f"\n  GET current service, large current item: {current_item_ms:.3f} ms, one session parse"
        f"\n  GET one large queue item: {large_item_ms:.3f} ms, one session parse"
        f"\n  hydrate three visible items: {hydration_ms:.3f} ms, three session parses"
        f"\n  list_all three items: {list_all_ms:.3f} ms, three session parses"
        f"\n  items_by_ids endpoint: {endpoint_ms:.3f} ms"
        f"\n  items_by_ids event-loop heartbeat gap: {heartbeat_gap_ms:.3f} ms"
        f"\n  POST items_by_ids ASGI round trip: {asgi_ms:.3f} ms"
        f"\n  concurrent GET ping completion: {ping_ms:.3f} ms"
        f"\n  ASGI event-loop heartbeat gap: {asgi_heartbeat_gap_ms:.3f} ms"
        f"\n  ASGI response: {asgi_response_size_bytes / 1024 / 1024:.2f} MiB"
        f"\n  ASGI response decode: {asgi_decode_ms:.3f} ms"
        f"\n  POST three large items ASGI round trip: {three_large_asgi_ms:.3f} ms"
        f"\n  concurrent GET ping with three large items: {three_large_ping_ms:.3f} ms"
        f"\n  three-large-item event-loop gap: {three_large_heartbeat_gap_ms:.3f} ms"
        f"\n  three-large-item response: {three_large_response_size_bytes / 1024 / 1024:.2f} MiB"
        f"\n  three-large-item response decode: {three_large_decode_ms:.3f} ms"
        f"\n  encode hydrated response: {response_encode_ms:.3f} ms"
        f"\n  hydrated response: {response_size_bytes / 1024 / 1024:.2f} MiB"
        f"\n  decode hydrated response: {response_decode_ms:.3f} ms"
        f"\n  decode ID response: {ids_decode_ms:.3f} ms"
        f"\n  item_ids query plan: {item_ids_plan}"
        f"\n  destination-count query plan: {destination_counts_plan}"
    )


def test_large_completed_queue_history_costs(mock_invoker: Invoker) -> None:
    """Measure unpaginated metadata-query scaling independently from session parsing."""
    queue = SqliteSessionQueue(db=mock_invoker.services.board_records._db)
    queue.start(mock_invoker)
    small_session_json = _build_small_session().model_dump_json(warnings=False, exclude_none=True)

    _seed_completed_history(queue, small_session_json, start=0, count=100)
    small_ids_ms, small_ids = _measure_ms(lambda: queue.get_queue_item_ids("default"), repeats=5)
    small_status_ms, _ = _measure_ms(lambda: queue.get_queue_status("default"), repeats=5)
    small_destination_ms, _ = _measure_ms(
        lambda: queue.get_counts_by_destination("default", "workflows"),
        repeats=5,
    )
    assert small_ids.total_count == 100

    _seed_completed_history(queue, small_session_json, start=100, count=LARGE_HISTORY_COUNT - 100)
    large_ids_ms, large_ids = _measure_ms(lambda: queue.get_queue_item_ids("default"), repeats=5)
    large_status_ms, large_status = _measure_ms(lambda: queue.get_queue_status("default"), repeats=5)
    large_destination_ms, large_destination = _measure_ms(
        lambda: queue.get_counts_by_destination("default", "workflows"),
        repeats=5,
    )
    assert large_ids.total_count == LARGE_HISTORY_COUNT
    assert large_status.completed == LARGE_HISTORY_COUNT
    assert large_destination.completed == LARGE_HISTORY_COUNT

    ids_adapter = TypeAdapter(ItemIdsResult)
    ids_encode_ms, ids_json = _measure_ms(lambda: ids_adapter.dump_json(large_ids), repeats=5)
    ids_decode_ms, decoded_ids = _measure_ms(lambda: json.loads(ids_json), repeats=5)
    assert len(decoded_ids["item_ids"]) == LARGE_HISTORY_COUNT

    assert large_ids_ms > small_ids_ms * 5
    assert large_status_ms > small_status_ms * 5
    assert large_destination_ms > small_destination_ms * 5

    print(
        "\nQueue history performance diagnostics:"
        f"\n  retained completed items: {LARGE_HISTORY_COUNT}"
        f"\n  item_ids, 100 rows: {small_ids_ms:.3f} ms"
        f"\n  item_ids, {LARGE_HISTORY_COUNT} rows: {large_ids_ms:.3f} ms"
        f"\n  status, 100 rows: {small_status_ms:.3f} ms"
        f"\n  status, {LARGE_HISTORY_COUNT} rows: {large_status_ms:.3f} ms"
        f"\n  counts_by_destination, 100 rows: {small_destination_ms:.3f} ms"
        f"\n  counts_by_destination, {LARGE_HISTORY_COUNT} rows: {large_destination_ms:.3f} ms"
        f"\n  encode all-ID response: {ids_encode_ms:.3f} ms"
        f"\n  all-ID response: {len(ids_json) / 1024:.2f} KiB"
        f"\n  decode all-ID response: {ids_decode_ms:.3f} ms"
    )
