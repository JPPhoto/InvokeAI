"""Per-request InvokeAI authentication for MCP requests."""

from typing import Any

from fastapi import HTTPException
from fastapi.responses import JSONResponse
from mcp.server.mcpserver import Context
from starlette.concurrency import run_in_threadpool
from starlette.requests import Request
from starlette.types import ASGIApp, Receive, Scope, Send

from invokeai.app.api.auth_dependencies import get_current_user_or_default, security
from invokeai.app.services.auth.token_service import TokenData

MCP_USER_SCOPE_KEY = "invokeai_mcp_user"


class MCPAuthMiddleware:
    """Resolve InvokeAI identity for each MCP HTTP request."""

    def __init__(self, app: ASGIApp) -> None:
        self.app = app

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return
        path = scope.get("path", "")
        root_path = scope.get("root_path", "")
        if root_path and (path == root_path or path.startswith(root_path + "/")):
            path = path[len(root_path) :] or "/"
        if path != "/mcp":
            await self.app(scope, receive, send)
            return

        state: dict[str, Any] = scope.setdefault("state", {})
        state.pop(MCP_USER_SCOPE_KEY, None)
        request = Request(scope, receive)
        try:
            credentials = await security(request)
            token_data = await run_in_threadpool(get_current_user_or_default, credentials)
        except HTTPException as error:
            response = JSONResponse({"detail": error.detail}, status_code=error.status_code, headers=error.headers)
            await response(scope, receive, send)
            return

        state[MCP_USER_SCOPE_KEY] = token_data
        await self.app(scope, receive, send)


def require_mcp_user(ctx: Context[Any, Request]) -> TokenData:
    """Get the identity resolved by the HTTP middleware, failing closed without it."""
    try:
        token_data = ctx.request_context.request.scope["state"][MCP_USER_SCOPE_KEY]
    except (AttributeError, KeyError, TypeError) as error:
        raise PermissionError("Authenticated MCP request required") from error
    if not isinstance(token_data, TokenData):
        raise PermissionError("Authenticated MCP request required")
    return token_data
