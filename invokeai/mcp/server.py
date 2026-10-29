"""MCP server construction."""

from mcp.server.mcpserver import MCPServer


def create_mcp_server() -> MCPServer:
    return MCPServer(name="InvokeAI")
