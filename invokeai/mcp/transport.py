"""Streamable HTTP transport mounted on InvokeAI's API listener."""

from urllib.parse import urlsplit

from mcp.server.mcpserver import MCPServer
from mcp.server.transport_security import TransportSecuritySettings
from starlette.types import ASGIApp

from invokeai.app.services.config.config_default import InvokeAIAppConfig
from invokeai.mcp.auth import MCPAuthMiddleware

_LOCAL_HOSTS = ("localhost", "127.0.0.1", "::1")
_WILDCARD_HOSTS = {"*", "0.0.0.0", "::"}


def _display_host(host: str) -> str:
    normalized = host.strip().strip("[]")
    return f"[{normalized}]" if ":" in normalized else normalized


def _host_forms(host: str, port: int | None = None) -> set[str]:
    normalized = host.strip().strip("[]")
    if not normalized or "*" in normalized or normalized.lower() in _WILDCARD_HOSTS:
        return set()
    display = _display_host(normalized)
    result = {display}
    if port is not None:
        result.add(f"{display}:{port}")
    return result


def transport_security_settings(app_config: InvokeAIAppConfig) -> TransportSecuritySettings:
    """Keep SDK DNS rebinding checks enabled with explicit, non-wildcard entries."""
    allowed_hosts: set[str] = set()
    for host in (*_LOCAL_HOSTS, app_config.host):
        allowed_hosts.update(_host_forms(host, app_config.port))

    scheme_ports = {"http": 80, "https": 443}
    allowed_origins: set[str] = set()
    for origin in app_config.allow_origins:
        if "*" in origin:
            continue
        allowed_origins.add(origin)
        try:
            parsed = urlsplit(origin)
            hostname = parsed.hostname
            port = parsed.port
        except ValueError:
            continue
        if not hostname or parsed.username or parsed.password:
            continue
        allowed_hosts.update(
            _host_forms(hostname, port if port is not None else scheme_ports.get(parsed.scheme.lower()))
        )
        scheme = parsed.scheme.lower()
        if (
            port is not None
            and port == scheme_ports.get(scheme)
            and parsed.path in ("", "/")
            and not parsed.query
            and not parsed.fragment
        ):
            # Browsers omit :80 and :443 from the serialized Origin header.
            allowed_origins.add(f"{scheme}://{_display_host(hostname)}")

    scheme = "https" if app_config.ssl_certfile else "http"
    for host in (*_LOCAL_HOSTS, app_config.host):
        host_forms = _host_forms(host)
        if not host_forms:
            continue
        host_header = next(iter(host_forms))
        allowed_origins.add(f"{scheme}://{host_header}:{app_config.port}")
        if app_config.port == scheme_ports[scheme]:
            # Browsers omit a scheme's default port from the serialized Origin header.
            allowed_origins.add(f"{scheme}://{host_header}")

    return TransportSecuritySettings(
        enable_dns_rebinding_protection=True,
        allowed_hosts=sorted(allowed_hosts),
        allowed_origins=sorted(allowed_origins),
    )


def build_mcp_transport(server: MCPServer, app_config: InvokeAIAppConfig) -> ASGIApp:
    app = server.streamable_http_app(
        streamable_http_path="/mcp",
        stateless_http=True,
        transport_security=transport_security_settings(app_config),
    )
    return MCPAuthMiddleware(app)
