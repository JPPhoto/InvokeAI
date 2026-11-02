import asyncio
import subprocess
import sys
import threading
from contextlib import asynccontextmanager
from datetime import timedelta
from types import SimpleNamespace
from typing import Any

import httpx
import pytest
from fastapi import FastAPI
from fastapi.responses import JSONResponse

from invokeai.app.api.dependencies import ApiDependencies
from invokeai.app.services.auth.token_service import TokenData, create_access_token, set_jwt_secret
from invokeai.app.services.config.config_default import InvokeAIAppConfig
from invokeai.app.services.users.users_common import UserCreateRequest, UserUpdateRequest
from invokeai.frontend.cli.arg_parser import InvokeAIArgs


def test_mcp_server_flag_is_opt_in(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(InvokeAIArgs, "args", None)
    monkeypatch.setattr(InvokeAIArgs, "did_parse", False)
    monkeypatch.setattr(sys, "argv", ["invokeai"])
    assert InvokeAIArgs.parse_args().enable_mcp_server is False

    monkeypatch.setattr(sys, "argv", ["invokeai", "--enable-mcp-server"])
    assert InvokeAIArgs.parse_args().enable_mcp_server is True


@pytest.fixture
def mcp_users(monkeypatch: pytest.MonkeyPatch, mock_invoker: Any) -> Any:
    set_jwt_secret("mcp-test-secret-for-invokeai-mcp-test-only")
    monkeypatch.setattr(ApiDependencies, "invoker", mock_invoker, raising=False)
    mock_invoker.services.configuration.multiuser = True
    users = mock_invoker.services.users
    admin = users.create(
        UserCreateRequest(email="admin@mcp.test", display_name="Admin", password="Secret123", is_admin=True)
    )
    first = users.create(UserCreateRequest(email="first@mcp.test", display_name="First", password="Secret123"))
    second = users.create(UserCreateRequest(email="second@mcp.test", display_name="Second", password="Secret123"))

    def token(user_id: str, email: str, is_admin: bool = False, expires_delta: timedelta | None = None) -> str:
        return create_access_token(
            TokenData(user_id=user_id, email=email, is_admin=is_admin), expires_delta=expires_delta
        )

    return SimpleNamespace(
        users=users,
        admin=admin,
        first=first,
        second=second,
        token=token,
    )


def _mcp_auth_app():
    from invokeai.mcp.auth import MCP_USER_SCOPE_KEY, MCPAuthMiddleware

    async def endpoint(scope: dict[str, Any], receive: Any, send: Any) -> None:
        user = scope["state"][MCP_USER_SCOPE_KEY]
        response = JSONResponse({"user_id": user.user_id, "is_admin": user.is_admin})
        await response(scope, receive, send)

    return MCPAuthMiddleware(endpoint)


def _get(app: Any, headers: dict[str, str] | None = None) -> httpx.Response:
    async def send() -> httpx.Response:
        transport = httpx.ASGITransport(app=app)
        async with httpx.AsyncClient(transport=transport, base_url="http://test") as client:
            return await client.get("/mcp", headers=headers)

    return asyncio.run(send())


def test_require_mcp_user_fails_closed_without_request_scope_identity(mcp_users: Any) -> None:
    from invokeai.app.services.auth.token_service import verify_token
    from invokeai.mcp.auth import MCP_USER_SCOPE_KEY, require_mcp_user

    token_data = verify_token(mcp_users.token(mcp_users.first.user_id, mcp_users.first.email))
    ctx = SimpleNamespace(
        request_context=SimpleNamespace(request=SimpleNamespace(scope={"state": {MCP_USER_SCOPE_KEY: token_data}}))
    )
    assert require_mcp_user(ctx) == token_data

    with pytest.raises(PermissionError, match="Authenticated MCP request required"):
        require_mcp_user(SimpleNamespace(request_context=SimpleNamespace(request=None)))


def test_mcp_auth_rejects_missing_malformed_and_expired_credentials(mcp_users: Any) -> None:
    user = mcp_users.first
    expired_token = mcp_users.token(user.user_id, user.email, expires_delta=timedelta(seconds=-1))
    app = _mcp_auth_app()
    for headers in (
        {},
        {"Authorization": "Basic abc"},
        {"Authorization": "Bearer malformed"},
        {"Authorization": f"Bearer {expired_token}"},
        {"Cookie": f"invokeai_media_token={mcp_users.token(user.user_id, user.email)}"},
    ):
        response = _get(app, headers)
        assert response.status_code == 401


def test_mcp_auth_uses_current_user_record_and_rejects_revoked_or_inactive_tokens(mcp_users: Any) -> None:
    user = mcp_users.first
    token = mcp_users.token(user.user_id, user.email, is_admin=True)
    headers = {"Authorization": f"Bearer {token}"}
    app = _mcp_auth_app()
    assert _get(app, headers).json() == {"user_id": user.user_id, "is_admin": False}

    mcp_users.users.update(user.user_id, UserUpdateRequest(password="Changed123"), strict_password_checking=False)
    assert _get(app, headers).status_code == 401

    active_user = mcp_users.second
    inactive_token = mcp_users.token(active_user.user_id, active_user.email)
    mcp_users.users.update(active_user.user_id, UserUpdateRequest(is_active=False))
    assert _get(app, {"Authorization": f"Bearer {inactive_token}"}).status_code == 401


def test_mcp_auth_scopes_overlapping_requests_to_each_user(mcp_users: Any) -> None:
    from invokeai.mcp.auth import MCP_USER_SCOPE_KEY, MCPAuthMiddleware

    both_requests = asyncio.Event()
    request_count = 0

    async def endpoint(scope: dict[str, Any], receive: Any, send: Any) -> None:
        nonlocal request_count
        user = scope["state"][MCP_USER_SCOPE_KEY]
        request_count += 1
        if request_count == 2:
            both_requests.set()
        await both_requests.wait()
        response = JSONResponse({"user_id": user.user_id})
        await response(scope, receive, send)

    first = mcp_users.first
    second = mcp_users.second

    async def send_requests() -> list[str]:
        transport = httpx.ASGITransport(app=MCPAuthMiddleware(endpoint))
        async with httpx.AsyncClient(transport=transport, base_url="http://test") as client:
            responses = await asyncio.gather(
                client.get("/mcp", headers={"Authorization": f"Bearer {mcp_users.token(first.user_id, first.email)}"}),
                client.get(
                    "/mcp", headers={"Authorization": f"Bearer {mcp_users.token(second.user_id, second.email)}"}
                ),
            )
        return [response.json()["user_id"] for response in responses]

    assert asyncio.run(send_requests()) == [first.user_id, second.user_id]


def test_mcp_single_user_auth_uses_system_account_without_a_token(
    monkeypatch: pytest.MonkeyPatch, mock_invoker: Any
) -> None:
    from invokeai.mcp.auth import MCP_USER_SCOPE_KEY, MCPAuthMiddleware

    monkeypatch.setattr(ApiDependencies, "invoker", mock_invoker, raising=False)
    mock_invoker.services.configuration.multiuser = False

    async def endpoint(scope: dict[str, Any], receive: Any, send: Any) -> None:
        user = scope["state"][MCP_USER_SCOPE_KEY]
        response = JSONResponse({"user_id": user.user_id, "is_admin": user.is_admin})
        await response(scope, receive, send)

    assert _get(MCPAuthMiddleware(endpoint)).json() == {"user_id": "system", "is_admin": True}


def test_mcp_auth_does_not_swallow_database_errors(monkeypatch: pytest.MonkeyPatch) -> None:
    from invokeai.mcp import auth

    def database_failure(_credentials: Any) -> None:
        raise RuntimeError("database unavailable")

    monkeypatch.setattr(auth, "get_current_user_or_default", database_failure)
    with pytest.raises(RuntimeError, match="database unavailable"):
        _get(auth.MCPAuthMiddleware(lambda *_args: None), {"Authorization": "Bearer token"})


def test_mcp_transport_security_uses_local_and_exact_allowed_origins() -> None:
    from invokeai.mcp.transport import transport_security_settings

    settings = transport_security_settings(
        InvokeAIAppConfig(
            host="0.0.0.0",
            port=9090,
            allow_origins=["https://studio.example:8443", "*", "https://*.example"],
        )
    )

    assert settings.enable_dns_rebinding_protection is True
    assert "127.0.0.1:9090" in settings.allowed_hosts
    assert "localhost:9090" in settings.allowed_hosts
    assert "studio.example:8443" in settings.allowed_hosts
    assert "https://studio.example:8443" in settings.allowed_origins
    assert "http://localhost:9090" in settings.allowed_origins
    assert "http://localhost" not in settings.allowed_origins
    assert "0.0.0.0:9090" not in settings.allowed_hosts
    assert "*" not in settings.allowed_hosts
    assert "*" not in settings.allowed_origins


def test_mcp_transport_security_accepts_canonical_default_port_origins() -> None:
    from invokeai.mcp.transport import transport_security_settings

    settings = transport_security_settings(
        InvokeAIAppConfig(
            host="127.0.0.1",
            port=9090,
            allow_origins=[
                "http://plain.example:80",
                "https://secure.example:443",
                "http://custom-http.example:8080",
                "https://custom-https.example:8443",
            ],
        )
    )

    assert "http://plain.example" in settings.allowed_origins
    assert "https://secure.example" in settings.allowed_origins
    assert "http://custom-http.example:8080" in settings.allowed_origins
    assert "https://custom-https.example:8443" in settings.allowed_origins
    assert "http://custom-http.example" not in settings.allowed_origins
    assert "https://custom-https.example" not in settings.allowed_origins


@pytest.mark.parametrize(
    ("port", "ssl_certfile", "scheme"),
    [(80, None, "http"), (443, "test-cert.pem", "https")],
)
def test_mcp_transport_security_allows_local_origin_without_default_port(
    port: int, ssl_certfile: str | None, scheme: str
) -> None:
    from invokeai.mcp.transport import transport_security_settings

    settings = transport_security_settings(InvokeAIAppConfig(host="0.0.0.0", port=port, ssl_certfile=ssl_certfile))

    assert f"{scheme}://localhost" in settings.allowed_origins
    assert f"{scheme}://127.0.0.1" in settings.allowed_origins
    assert f"{scheme}://[::1]" in settings.allowed_origins
    assert f"{scheme}://localhost:{port}" in settings.allowed_origins


def test_mcp_default_off_import_does_not_load_or_mount_mcp() -> None:
    script = """
import builtins
import sys

original_import = builtins.__import__
def guarded_import(name, globals=None, locals=None, fromlist=(), level=0):
    if name == "mcp" or name.startswith("mcp.") or name == "invokeai.mcp" or name.startswith("invokeai.mcp."):
        raise AssertionError(f"MCP imported while disabled: {name}")
    return original_import(name, globals, locals, fromlist, level)

builtins.__import__ = guarded_import
sys.argv = ["invokeai"]
from invokeai.frontend.cli.arg_parser import InvokeAIArgs
assert InvokeAIArgs.parse_args().enable_mcp_server is False
from invokeai.app import api_app
assert getattr(api_app.app.state, "mcp_server", None) is None
assert not any(getattr(route, "name", None) == "mcp" for route in api_app.app.routes)
assert not any(
    name == "mcp" or name.startswith("mcp.") or name == "invokeai.mcp" or name.startswith("invokeai.mcp.")
    for name in sys.modules
)
"""
    result = subprocess.run([sys.executable, "-c", script], capture_output=True, text=True, check=False)
    assert result.returncode == 0, result.stderr


def test_mcp_mount_preserves_api_and_supports_base_url_with_host_origin_checks(
    monkeypatch: pytest.MonkeyPatch, mcp_users: Any
) -> None:
    from invokeai.app import api_app
    from invokeai.app.api_app import SubPathASGIMiddleware
    from invokeai.mcp import auth

    auth_thread_ids: list[int] = []
    real_get_current_user = auth.get_current_user_or_default

    def record_auth_thread(credentials: Any) -> Any:
        auth_thread_ids.append(threading.get_ident())
        return real_get_current_user(credentials)

    monkeypatch.setattr(auth, "get_current_user_or_default", record_auth_thread)

    monkeypatch.setattr(
        api_app,
        "app_config",
        InvokeAIAppConfig(host="127.0.0.1", port=9090, allow_origins=["https://studio.example:8443"]),
    )
    app = FastAPI()

    async def health() -> dict[str, bool]:
        return {"ok": True}

    app.add_api_route("/api/v1/health", health, methods=["GET"])
    server = api_app._mount_mcp_server(app, enabled=True)
    tool_calls: list[str] = []
    from mcp.server.mcpserver import Context
    from mcp_types import CLIENT_CAPABILITIES_META_KEY, CLIENT_INFO_META_KEY, PROTOCOL_VERSION_META_KEY

    from invokeai.mcp.auth import require_mcp_user

    async def count_tool(ctx: Context) -> str:
        user = require_mcp_user(ctx)
        tool_calls.append(user.user_id)
        return user.user_id

    server.add_tool(count_tool, name="count")
    routed_app = SubPathASGIMiddleware(app, "/invoke")
    token = mcp_users.token(mcp_users.first.user_id, mcp_users.first.email)

    async def requests() -> tuple[list[httpx.Response], int]:
        event_loop_thread_id = threading.get_ident()
        transport = httpx.ASGITransport(app=routed_app)
        async with (
            server.session_manager.run(),
            httpx.AsyncClient(transport=transport, base_url="http://localhost") as client,
        ):
            health = await client.get("/invoke/api/v1/health")
            tool_call = {
                "jsonrpc": "2.0",
                "id": 1,
                "method": "tools/call",
                "params": {
                    "name": "count",
                    "arguments": {},
                    "_meta": {
                        PROTOCOL_VERSION_META_KEY: "2026-07-28",
                        CLIENT_CAPABILITIES_META_KEY: {},
                        CLIENT_INFO_META_KEY: {"name": "test", "version": "1"},
                    },
                },
            }
            routing_headers = {
                "Authorization": f"Bearer {token}",
                "Accept": "application/json, text/event-stream",
                "MCP-Protocol-Version": "2026-07-28",
                "MCP-Method": "tools/call",
                "MCP-Name": "count",
            }
            bad_host = await client.post(
                "/invoke/api/mcp",
                json=tool_call,
                headers={**routing_headers, "Host": "untrusted.example", "Origin": "http://127.0.0.1:9090"},
            )
            bad_origin = await client.post(
                "/invoke/api/mcp",
                json=tool_call,
                headers={**routing_headers, "Host": "127.0.0.1:9090", "Origin": "https://untrusted.example"},
            )
            assert tool_calls == []
            valid = await client.post(
                "/invoke/api/mcp",
                json=tool_call,
                headers={
                    **routing_headers,
                    "Host": "studio.example:8443",
                    "Origin": "https://studio.example:8443",
                },
            )
            unknown = await client.get("/invoke/api/mcp/unknown")
            return [health, bad_host, bad_origin, valid, unknown], event_loop_thread_id

    (health, bad_host, bad_origin, valid, unknown), event_loop_thread_id = asyncio.run(
        asyncio.wait_for(requests(), timeout=10)
    )
    assert health.status_code == 200 and health.json() == {"ok": True}
    assert bad_host.status_code == 421
    assert bad_origin.status_code == 403
    assert valid.status_code == 200, valid.text
    assert unknown.status_code == 404
    assert tool_calls == [mcp_users.first.user_id]
    assert auth_thread_ids
    assert all(thread_id != event_loop_thread_id for thread_id in auth_thread_ids)


def test_mcp_image_url_uses_scope_root_for_nested_and_root_deployments(
    monkeypatch: pytest.MonkeyPatch, mcp_users: Any
) -> None:
    from mcp.server.mcpserver import Context
    from mcp_types import CLIENT_CAPABILITIES_META_KEY, CLIENT_INFO_META_KEY, PROTOCOL_VERSION_META_KEY

    from invokeai.app import api_app
    from invokeai.app.api_app import SubPathASGIMiddleware
    from invokeai.mcp.jobs import _request_path

    monkeypatch.setattr(
        api_app,
        "app_config",
        InvokeAIAppConfig(host="127.0.0.1", port=9090, allow_origins=["http://localhost:9090"]),
    )
    app = FastAPI()
    server = api_app._mount_mcp_server(app, enabled=True)
    assert server is not None

    async def image_url(ctx: Context) -> str:
        scope = ctx.request_context.request.scope
        return _request_path("api/v1/images/i/mounted-output/full", scope)

    server.add_tool(image_url, name="image_url")
    routed_app = SubPathASGIMiddleware(app, "/invoke")
    token = mcp_users.token(mcp_users.first.user_id, mcp_users.first.email)
    tool_call = {
        "jsonrpc": "2.0",
        "id": 1,
        "method": "tools/call",
        "params": {
            "name": "image_url",
            "arguments": {},
            "_meta": {
                PROTOCOL_VERSION_META_KEY: "2026-07-28",
                CLIENT_CAPABILITIES_META_KEY: {},
                CLIENT_INFO_META_KEY: {"name": "test", "version": "1"},
            },
        },
    }
    headers = {
        "Authorization": f"Bearer {token}",
        "Accept": "application/json, text/event-stream",
        "MCP-Protocol-Version": "2026-07-28",
        "MCP-Method": "tools/call",
        "MCP-Name": "image_url",
        "Host": "localhost:9090",
        "Origin": "http://localhost:9090",
    }

    async def requests() -> tuple[httpx.Response, httpx.Response]:
        async with server.session_manager.run():
            routed_transport = httpx.ASGITransport(app=routed_app)
            async with httpx.AsyncClient(transport=routed_transport, base_url="http://localhost") as client:
                proxied = await client.post("/invoke/api/mcp", json=tool_call, headers=headers)
            root_transport = httpx.ASGITransport(app=app)
            async with httpx.AsyncClient(transport=root_transport, base_url="http://localhost") as client:
                root = await client.post("/api/mcp", json=tool_call, headers=headers)
        return proxied, root

    proxied, root = asyncio.run(asyncio.wait_for(requests(), timeout=10))
    assert proxied.status_code == 200, proxied.text
    assert root.status_code == 200, root.text
    assert proxied.json()["result"]["content"][0]["text"] == "/invoke/api/v1/images/i/mounted-output/full"
    assert root.json()["result"]["content"][0]["text"] == "/api/v1/images/i/mounted-output/full"


def test_mcp_list_shared_workflows_returns_only_shared_records_over_http(
    monkeypatch: pytest.MonkeyPatch, mcp_users: Any, mock_invoker: Any
) -> None:
    import json

    from invokeai.app import api_app
    from invokeai.app.api_app import SubPathASGIMiddleware
    from invokeai.app.services.shared.pagination import SQLiteDirection
    from invokeai.app.services.workflow_records.workflow_records_common import (
        WorkflowCategory,
        WorkflowMeta,
        WorkflowRecordOrderBy,
        WorkflowWithoutID,
    )

    records = mock_invoker.services.workflow_records
    records.start(mock_invoker)

    def workflow(name: str) -> WorkflowWithoutID:
        return WorkflowWithoutID(
            name=name,
            author="MCP test",
            description=f"{name} description",
            version="1.0.0",
            contact="",
            tags="",
            notes="",
            exposedFields=[],
            meta=WorkflowMeta(version="3.0.0", category=WorkflowCategory.User),
            nodes=[],
            edges=[],
        )

    public = records.create(workflow("Public MCP workflow"), user_id=mcp_users.first.user_id, is_public=True)
    private = records.create(workflow("Private MCP workflow"), user_id=mcp_users.second.user_id)
    defaults = records.get_many(
        order_by=WorkflowRecordOrderBy.Name,
        direction=SQLiteDirection.Ascending,
        categories=[WorkflowCategory.Default],
    ).items

    monkeypatch.setattr(
        api_app,
        "app_config",
        InvokeAIAppConfig(host="127.0.0.1", port=9090, allow_origins=["https://studio.example:8443"]),
    )
    app = FastAPI()
    server = api_app._mount_mcp_server(app, enabled=True)
    assert server is not None
    routed_app = SubPathASGIMiddleware(app, "/invoke")
    token = mcp_users.token(mcp_users.first.user_id, mcp_users.first.email)
    from mcp_types import CLIENT_CAPABILITIES_META_KEY, CLIENT_INFO_META_KEY, PROTOCOL_VERSION_META_KEY

    tool_call = {
        "jsonrpc": "2.0",
        "id": 1,
        "method": "tools/call",
        "params": {
            "name": "list_shared_workflows",
            "arguments": {"per_page": 100},
            "_meta": {
                PROTOCOL_VERSION_META_KEY: "2026-07-28",
                CLIENT_CAPABILITIES_META_KEY: {},
                CLIENT_INFO_META_KEY: {"name": "test", "version": "1"},
            },
        },
    }

    async def request() -> httpx.Response:
        transport = httpx.ASGITransport(app=routed_app)
        async with (
            server.session_manager.run(),
            httpx.AsyncClient(transport=transport, base_url="http://localhost") as client,
        ):
            return await client.post(
                "/invoke/api/mcp",
                json=tool_call,
                headers={
                    "Authorization": f"Bearer {token}",
                    "Accept": "application/json, text/event-stream",
                    "MCP-Protocol-Version": "2026-07-28",
                    "MCP-Method": "tools/call",
                    "MCP-Name": "list_shared_workflows",
                    "Host": "studio.example:8443",
                    "Origin": "https://studio.example:8443",
                },
            )

    response = asyncio.run(asyncio.wait_for(request(), timeout=10))
    assert response.status_code == 200, response.text
    result = json.loads(response.json()["result"]["content"][0]["text"])
    items = result["items"]
    default_ids = {item.workflow_id for item in defaults}
    assert {item["workflow_id"] for item in items} == default_ids | {public.workflow_id}
    assert private.workflow_id not in {item["workflow_id"] for item in items}
    assert {item["name"] for item in items} == {item.name for item in defaults} | {public.name}
    assert private.name not in {item["name"] for item in items}


@pytest.mark.parametrize("startup_failure", [False, True])
def test_mcp_lifespan_cleans_up_server_socket_and_dependencies(
    monkeypatch: pytest.MonkeyPatch, startup_failure: bool
) -> None:
    from invokeai.app import api_app

    events: list[str] = []
    monkeypatch.setattr(api_app.ApiDependencies, "initialize", lambda **_kwargs: events.append("initialize"))
    monkeypatch.setattr(api_app.ApiDependencies, "shutdown", lambda: events.append("shutdown"))
    monkeypatch.setattr(api_app.socket_io, "start", lambda: events.append("socket_start"))
    monkeypatch.setattr(api_app.socket_io, "stop", lambda: events.append("socket_stop"))

    @asynccontextmanager
    async def run_session_manager():
        events.append("mcp_start")
        if startup_failure:
            raise RuntimeError("MCP startup failed")
        try:
            yield
        finally:
            events.append("mcp_stop")

    app = FastAPI()
    app.state.mcp_server = SimpleNamespace(session_manager=SimpleNamespace(run=run_session_manager))

    async def run_lifespan() -> None:
        async with api_app.lifespan(app):
            events.append("inside")
            if not startup_failure:
                raise RuntimeError("server stopped")

    with pytest.raises(RuntimeError):
        asyncio.run(run_lifespan())

    if startup_failure:
        assert events == ["initialize", "mcp_start", "socket_stop", "shutdown"]
    else:
        assert events == ["initialize", "mcp_start", "socket_start", "inside", "mcp_stop", "socket_stop", "shutdown"]
