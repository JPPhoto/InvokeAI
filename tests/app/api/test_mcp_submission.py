import asyncio
from types import SimpleNamespace
from typing import Any

import pytest
from mcp.server.mcpserver.exceptions import ToolError, UnexpectedToolError
from pydantic import ValidationError
from sqlalchemy import insert, select

from invokeai.app.api.dependencies import ApiDependencies
from invokeai.app.services.auth.token_service import TokenData
from invokeai.app.services.session_queue.session_queue_common import DEFAULT_QUEUE_ID, Batch
from invokeai.app.services.session_queue.session_queue_default import SessionQueue
from invokeai.app.services.shared.database.database import Database
from invokeai.app.services.shared.database.schema.session_queue import session_queue_enqueue_receipts
from invokeai.app.services.shared.database.schema.users import users
from invokeai.app.services.shared.graph import Graph
from invokeai.mcp.auth import MCP_USER_SCOPE_KEY


def _ctx(user_id: str) -> Any:
    token = TokenData(user_id=user_id, email=f"{user_id}@mcp.test", is_admin=False)
    return SimpleNamespace(
        request_context=SimpleNamespace(request=SimpleNamespace(scope={"state": {MCP_USER_SCOPE_KEY: token}}))
    )


def _server_with_queue_spy(monkeypatch: pytest.MonkeyPatch) -> tuple[Any, list[dict[str, Any]]]:
    from invokeai.mcp.server import create_mcp_server

    calls: list[dict[str, Any]] = []
    queue = SimpleNamespace(acknowledge_enqueue=lambda **kwargs: calls.append(kwargs))
    invoker = SimpleNamespace(services=SimpleNamespace(session_queue=queue))
    monkeypatch.setattr(ApiDependencies, "invoker", invoker, raising=False)
    return create_mcp_server(), calls


def test_acknowledge_submission_schema_and_registered_tool_reject_invalid_keys(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    server, queue_calls = _server_with_queue_spy(monkeypatch)
    tool = next(tool for tool in asyncio.run(server.list_tools()) if tool.name == "acknowledge_submission")
    key_schema = tool.input_schema["properties"]["idempotency_key"]

    assert key_schema["minLength"] == 1
    assert key_schema["maxLength"] == 255

    for idempotency_key in ("", "x" * 256):
        with pytest.raises(ToolError) as exc_info:
            asyncio.run(
                server.call_tool(
                    "acknowledge_submission",
                    {"idempotency_key": idempotency_key},
                    context=_ctx("submission-owner"),
                )
            )
        assert not isinstance(exc_info.value, UnexpectedToolError)
        assert isinstance(exc_info.value.__cause__, ValidationError)
    assert queue_calls == []


def test_acknowledge_submission_fails_closed_without_identity(monkeypatch: pytest.MonkeyPatch) -> None:
    server, queue_calls = _server_with_queue_spy(monkeypatch)
    ctx = SimpleNamespace(request_context=SimpleNamespace(request=None))

    with pytest.raises(UnexpectedToolError) as exc_info:
        asyncio.run(server.call_tool("acknowledge_submission", {"idempotency_key": "submission-key"}, context=ctx))

    assert isinstance(exc_info.value.__cause__, PermissionError)
    assert queue_calls == []


def test_acknowledge_submission_is_owner_scoped_and_idempotent(
    database: Database, mock_invoker: Any, monkeypatch: Any
) -> None:
    with database.begin(write=True) as conn:
        conn.execute(
            insert(users),
            [
                {"user_id": "submission-owner", "email": "owner@mcp.test", "password_hash": "test"},
                {"user_id": "submission-other", "email": "other@mcp.test", "password_hash": "test"},
            ],
        )
    queue = SessionQueue(database)
    queue.start(mock_invoker)
    mock_invoker.services.session_queue = queue
    monkeypatch.setattr(ApiDependencies, "invoker", mock_invoker, raising=False)

    asyncio.run(
        queue.enqueue_batch(
            DEFAULT_QUEUE_ID,
            Batch(graph=Graph(), idempotency_key="submission-key"),
            prepend=False,
            user_id="submission-owner",
        )
    )
    asyncio.run(
        queue.enqueue_batch(
            "other-queue",
            Batch(graph=Graph(), idempotency_key="submission-key"),
            prepend=False,
            user_id="submission-owner",
        )
    )

    from invokeai.mcp.submission import acknowledge_submission

    assert acknowledge_submission(_ctx("submission-other"), "submission-key") == {"status": "acknowledged"}
    with database.begin(write=False) as conn:
        acknowledged_at = conn.execute(
            select(session_queue_enqueue_receipts.c.acknowledged_at).where(
                session_queue_enqueue_receipts.c.user_id == "submission-owner",
                session_queue_enqueue_receipts.c.queue_id == DEFAULT_QUEUE_ID,
                session_queue_enqueue_receipts.c.idempotency_key == "submission-key",
            )
        ).scalar_one()
    assert acknowledged_at is None

    assert acknowledge_submission(_ctx("submission-owner"), "submission-key") == {"status": "acknowledged"}
    assert acknowledge_submission(_ctx("submission-owner"), "submission-key") == {"status": "acknowledged"}
    with database.begin(write=False) as conn:
        receipts = conn.execute(
            select(session_queue_enqueue_receipts.c.queue_id, session_queue_enqueue_receipts.c.acknowledged_at).where(
                session_queue_enqueue_receipts.c.user_id == "submission-owner",
                session_queue_enqueue_receipts.c.idempotency_key == "submission-key",
            )
        ).all()
    acknowledged_by_queue = dict(receipts)
    assert acknowledged_by_queue[DEFAULT_QUEUE_ID] is not None
    assert acknowledged_by_queue["other-queue"] is None
