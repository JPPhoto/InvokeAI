"""Submission receipt tools for MCP clients."""

from typing import Annotated, Any

from mcp.server.mcpserver import Context
from pydantic import Field
from starlette.requests import Request

from invokeai.app.api.dependencies import ApiDependencies
from invokeai.app.services.session_queue.session_queue_common import DEFAULT_QUEUE_ID
from invokeai.mcp.auth import require_mcp_user


def acknowledge_submission(
    ctx: Context[Any, Request], idempotency_key: Annotated[str, Field(min_length=1, max_length=255)]
) -> dict[str, str]:
    """Acknowledge a submission only after receiving and recording its accepted result."""
    token = require_mcp_user(ctx)
    ApiDependencies.invoker.services.session_queue.acknowledge_enqueue(
        queue_id=DEFAULT_QUEUE_ID,
        idempotency_key=idempotency_key,
        user_id=token.user_id,
    )
    return {"status": "acknowledged"}
