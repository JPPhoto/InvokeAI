"""MCP server construction."""

from mcp.server.mcpserver import MCPServer

from invokeai.mcp.catalog import describe_workflow, list_shared_workflows
from invokeai.mcp.jobs import get_job_results, get_job_status
from invokeai.mcp.submission import acknowledge_submission, submit_workflow


def create_mcp_server() -> MCPServer:
    server = MCPServer(name="InvokeAI")
    server.add_tool(list_shared_workflows)
    server.add_tool(describe_workflow)
    server.add_tool(submit_workflow)
    server.add_tool(acknowledge_submission)
    server.add_tool(get_job_status)
    server.add_tool(get_job_results)
    return server
