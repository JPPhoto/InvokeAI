"""MCP server construction."""

from mcp.server.mcpserver import MCPServer

from invokeai.mcp.catalog import describe_workflow, list_shared_workflows


def create_mcp_server() -> MCPServer:
    server = MCPServer(name="InvokeAI")
    server.add_tool(list_shared_workflows)
    server.add_tool(describe_workflow)
    return server
