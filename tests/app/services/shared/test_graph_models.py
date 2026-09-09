import subprocess
import sys
import textwrap

from pydantic import TypeAdapter, model_validator
from pydantic.json_schema import models_json_schema

from invokeai.app.invocations.math import AddInvocation
from invokeai.app.services.shared import graph as graph_facade
from invokeai.app.services.shared import graph_models


def test_graph_facade_reexports_graph_models() -> None:
    exported_names = (
        "EdgeConnection",
        "Edge",
        "WorkflowCallFrame",
        "WorkflowCallExecution",
        "WorkflowCallParentRef",
        "ExecutionFrame",
        "ExecutionReference",
        "ExecutionToken",
        "PreparedExecState",
        "WorkflowCallStatus",
        "ExecutionRef",
        "PreparedExecutionRef",
    )

    for name in exported_names:
        assert getattr(graph_facade, name) is getattr(graph_models, name)

    assert graph_facade.model_validator is model_validator


def test_graph_models_preserve_graph_and_execution_state_serialization() -> None:
    source_graph = graph_facade.Graph()
    source_graph.add_node(AddInvocation(id="source", a=1, b=2))
    source_graph.add_node(AddInvocation(id="destination", a=3, b=4))
    edge = graph_facade.Edge(
        source=graph_facade.EdgeConnection(node_id="source", field="value"),
        destination=graph_facade.EdgeConnection(node_id="destination", field="a"),
    )
    source_graph.add_edge(edge)

    execution_ref = graph_facade.ExecutionReference(
        reference_id="state-id:source",
        state_id="state-id",
        exec_node_id="source",
        source_node_id="source",
        frame=graph_facade.ExecutionFrame(state_id="state-id", frame_id="frame-id"),
    )
    execution_token = graph_facade.ExecutionToken(
        token_id="token-id",
        reference_id=execution_ref.reference_id,
        owner_node_id="source",
        port="value",
        frame=execution_ref.frame,
        value=5,
    )
    state = graph_facade.GraphExecutionState(
        id="state-id",
        graph=source_graph,
        execution_graph=source_graph.model_copy(deep=True),
        execution_refs={execution_ref.reference_id: execution_ref},
        execution_tokens={execution_token.token_id: execution_token},
    )

    graph_json = source_graph.model_dump_json()
    restored_graph = TypeAdapter(graph_facade.Graph).validate_json(graph_json)
    assert restored_graph.model_dump(mode="json", warnings=False) == source_graph.model_dump(
        mode="json", warnings=False
    )

    state_json = state.model_dump_json(exclude_none=True)
    restored_state = graph_facade.GraphExecutionState.model_validate_json(state_json)
    assert restored_state.model_dump(mode="json", warnings=False, exclude_none=True) == state.model_dump(
        mode="json", warnings=False, exclude_none=True
    )

    schema_models = [
        (graph_facade.Graph, "serialization"),
        (graph_facade.GraphExecutionState, "serialization"),
        (graph_facade.Edge, "serialization"),
        (graph_facade.EdgeConnection, "serialization"),
        (graph_facade.WorkflowCallFrame, "serialization"),
        (graph_facade.WorkflowCallExecution, "serialization"),
        (graph_facade.WorkflowCallParentRef, "serialization"),
        (graph_facade.ExecutionFrame, "serialization"),
        (graph_facade.ExecutionReference, "serialization"),
        (graph_facade.ExecutionToken, "serialization"),
    ]
    _, schema = models_json_schema(schema_models)
    definitions = schema["$defs"]
    assert {
        "Graph",
        "GraphExecutionState",
        "Edge",
        "EdgeConnection",
        "WorkflowCallFrame",
        "WorkflowCallExecution",
        "WorkflowCallParentRef",
        "ExecutionFrame",
        "ExecutionReference",
        "ExecutionToken",
    } <= definitions.keys()
    assert {"id", "nodes", "edges"} <= definitions["Graph"]["properties"].keys()
    assert {"id", "graph", "execution_graph", "execution_refs", "execution_tokens"} <= definitions[
        "GraphExecutionState"
    ]["properties"].keys()
    assert {"source", "destination", "type"} <= definitions["Edge"]["properties"].keys()
    assert {"reference_id", "exec_node_id", "frame"} <= definitions["ExecutionReference"]["properties"].keys()
    assert {"token_id", "reference_id", "owner_node_id", "value"} <= definitions["ExecutionToken"]["properties"].keys()


def test_graph_models_preserve_lazy_networkx_and_registry_behavior() -> None:
    script = """
    import builtins
    import sys

    real_import = builtins.__import__

    def blocked_import(name, globals=None, locals=None, fromlist=(), level=0):
        if name == "networkx" or name.startswith("networkx."):
            raise ModuleNotFoundError("No module named 'networkx'")
        return real_import(name, globals, locals, fromlist, level)

    builtins.__import__ = blocked_import
    from invokeai.app.invocations.baseinvocation import InvocationRegistry

    import invokeai.app.services.shared.graph_models  # noqa: F401

    from invokeai.app.services.shared.graph import *  # noqa: F401 F403

    registered_classes = set(InvocationRegistry.get_invocation_classes())
    assert any(cls.__name__ == "AddInvocation" and cls.get_type() == "add" for cls in registered_classes)
    assert any(cls.__name__ == "IfInvocation" and cls.get_type() == "if" for cls in registered_classes)

    assert "networkx" not in sys.modules
    print("GRAPH_MODELS_COMPATIBLE")
    """

    result = subprocess.run(
        [sys.executable, "-c", textwrap.dedent(script)],
        capture_output=True,
        text=True,
        timeout=300,
        check=False,
    )

    assert result.returncode == 0, result.stderr
    assert "GRAPH_MODELS_COMPATIBLE" in result.stdout
