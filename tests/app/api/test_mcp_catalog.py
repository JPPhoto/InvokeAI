import asyncio
from pathlib import Path
from types import SimpleNamespace
from typing import Annotated, Any

import pytest
from pydantic import BaseModel, DirectoryPath, Field
from typing_extensions import TypeAliasType

from invokeai.app.api.dependencies import ApiDependencies
from invokeai.app.invocations.fields import Input, InputField
from invokeai.app.services.auth.token_service import TokenData
from invokeai.app.services.shared.pagination import SQLiteDirection
from invokeai.app.services.workflow_records.workflow_records_common import (
    WorkflowCategory,
    WorkflowMeta,
    WorkflowRecordOrderBy,
    WorkflowWithoutID,
)
from invokeai.mcp.auth import MCP_USER_SCOPE_KEY


def _input_extra(*, input: str = "direct", field_kind: str = "input", ui_hidden: bool = False) -> dict[str, Any]:
    return {"input": input, "field_kind": field_kind, "ui_hidden": ui_hidden}


_ResourceURI = TypeAliasType("ResourceURI", Annotated[str, Field(json_schema_extra={"format": "uri"})])


class _CatalogInvocation(BaseModel):
    alpha: str = Field(
        default="schema alpha",
        title="Alpha title",
        description="Schema alpha description",
        json_schema_extra=_input_extra(),
    )
    zero: int = Field(default=3, ge=0, description="Schema zero description", json_schema_extra=_input_extra())
    seed: int = Field(default=0, ge=0, le=4294967295, json_schema_extra=_input_extra())
    enabled: bool = Field(default=True, description="Schema enabled description", json_schema_extra=_input_extra())
    nullable: str | None = InputField(default="schema nullable", input=Input.Any)
    required_any: int | None = InputField(input=Input.Any)
    required_any_saved: int | None = InputField(input=Input.Any)
    bounded_integer: int = Field(default=20, ge=1, le=100, json_schema_extra=_input_extra())
    widened_integer: int = Field(default=25, ge=1, le=100, json_schema_extra=_input_extra())
    wrong_kind_integer: int = Field(default=25, ge=1, le=100, json_schema_extra=_input_extra())
    schema_only: float = Field(default=0.25, ge=0, description="Schema only", json_schema_extra=_input_extra())
    required_text: str = Field(json_schema_extra=_input_extra())
    integer_values: list[int] = InputField(default_factory=list, input=Input.Direct)
    hidden: str = Field(default="", json_schema_extra=_input_extra(ui_hidden=True))
    connected: int = Field(default=1, json_schema_extra=_input_extra())
    internal: str = Field(default="", json_schema_extra=_input_extra(field_kind="internal"))
    node_attribute: str = Field(default="", json_schema_extra=_input_extra(field_kind="node_attribute"))
    unsupported: dict[str, str] = Field(default_factory=dict, json_schema_extra=_input_extra())
    file_path: str = Field(default="", json_schema_extra=_input_extra())
    maybe_location: Path | None = Field(default=None, json_schema_extra=_input_extra())
    folder: DirectoryPath | None = Field(default=None, json_schema_extra=_input_extra())
    links: list[_ResourceURI] = Field(default_factory=list, json_schema_extra=_input_extra())


def _catalog_tools() -> tuple[Any, Any]:
    from invokeai.mcp.catalog import describe_workflow, list_shared_workflows

    return describe_workflow, list_shared_workflows


@pytest.fixture
def catalog_records(monkeypatch: pytest.MonkeyPatch, mock_invoker: Any) -> Any:
    records = mock_invoker.services.workflow_records
    records.start(mock_invoker)
    monkeypatch.setattr(ApiDependencies, "invoker", mock_invoker, raising=False)
    return records


def _ctx(user_id: str = "mcp-user", *, is_admin: bool = False) -> Any:
    token_data = TokenData(user_id=user_id, email=f"{user_id}@mcp.test", is_admin=is_admin)
    return SimpleNamespace(
        request_context=SimpleNamespace(request=SimpleNamespace(scope={"state": {MCP_USER_SCOPE_KEY: token_data}}))
    )


def _workflow(
    name: str,
    *,
    nodes: list[dict[str, Any]] | None = None,
    edges: list[dict[str, Any]] | None = None,
    exposed_fields: list[dict[str, str]] | None = None,
    form: dict[str, Any] | None = None,
    notes: str = "",
) -> WorkflowWithoutID:
    return WorkflowWithoutID(
        name=name,
        author="Private author metadata",
        description=f"{name} description",
        version="1.0.0",
        contact="private-contact@example.test",
        tags="beta, public-tag",
        notes=notes,
        exposedFields=exposed_fields or [],
        meta=WorkflowMeta(version="3.0.0", category=WorkflowCategory.User),
        nodes=nodes or [],
        edges=edges or [],
        form=form,
    )


def _node(node_id: str, inputs: dict[str, Any], node_type: str = "catalog_node") -> dict[str, Any]:
    return {"id": node_id, "type": "invocation", "data": {"type": node_type, "inputs": inputs}}


def _field_element(element_id: str, field_name: str, *, node_id: str = "node") -> dict[str, Any]:
    return {
        "id": element_id,
        "type": "node-field",
        "data": {"fieldIdentifier": {"nodeId": node_id, "fieldName": field_name}},
    }


def _form(field_names: list[str]) -> dict[str, Any]:
    elements = {
        "root": {
            "id": "root",
            "type": "container",
            "data": {"layout": "column", "children": [*field_names, "root"]},
        }
    }
    elements.update({name: _field_element(name, name) for name in field_names})
    return {"rootElementId": "root", "elements": elements}


def _register_catalog_invocation(monkeypatch: pytest.MonkeyPatch, additional: dict[str, Any] | None = None) -> None:
    from invokeai.app.invocations.baseinvocation import InvocationRegistry

    invocations = {"catalog_node": _CatalogInvocation, **(additional or {})}
    monkeypatch.setattr(
        InvocationRegistry,
        "get_invocation_for_type",
        classmethod(lambda _cls, invocation_type: invocations.get(invocation_type)),
    )


@pytest.mark.parametrize(
    ("schema", "value", "expected"),
    [
        ({"type": "integer", "multipleOf": 2}, 4_294_967_295, False),
        ({"type": "integer", "multipleOf": 2}, 4_294_967_294, True),
        ({"type": "number", "multipleOf": 0.1}, 0.3, True),
        ({"type": "number", "multipleOf": 0.1}, 0.31, False),
    ],
)
def test_schema_multiple_of_uses_exact_json_number_arithmetic(
    schema: dict[str, Any], value: int | float, expected: bool
) -> None:
    from invokeai.mcp.catalog import _schema_value_matches

    assert _schema_value_matches(schema, value, {}) is expected


def test_catalog_tools_are_registered_and_list_only_shared_metadata(catalog_records: Any) -> None:
    public = catalog_records.create(
        _workflow("Zebra public", notes="stored-private-note"), user_id="public-owner", is_public=True
    )
    catalog_records.create(_workflow("Aardvark private"), user_id="private-owner")
    defaults = catalog_records.get_many(
        order_by=WorkflowRecordOrderBy.Name,
        direction=SQLiteDirection.Ascending,
        categories=[WorkflowCategory.Default],
    ).items

    from invokeai.mcp.server import create_mcp_server

    tools = asyncio.run(create_mcp_server().list_tools())
    assert {tool.name for tool in tools} == {
        "list_shared_workflows",
        "describe_workflow",
        "submit_workflow",
        "acknowledge_submission",
    }

    _, list_shared_workflows = _catalog_tools()
    result = list_shared_workflows(ctx=_ctx(), page=0, per_page=1000)
    ids = [item["workflow_id"] for item in result["items"]]
    names = [item["name"] for item in result["items"]]

    assert public.workflow_id in ids
    assert {item.workflow_id for item in defaults}.issubset(ids)
    assert "Aardvark private" not in names
    assert result["total"] == len(defaults) + 1
    assert result["per_page"] == 100
    assert names == [
        item["name"]
        for item in sorted(result["items"], key=lambda item: (item["name"].casefold(), item["workflow_id"]))
    ]
    assert all("user_id" not in item and "workflow" not in item and "notes" not in item for item in result["items"])
    assert "stored-private-note" not in str(result)


def test_describe_hides_private_workflows_from_owner_and_admin(catalog_records: Any) -> None:
    private = catalog_records.create(_workflow("Private workflow"), user_id="owner-id")
    public = catalog_records.create(_workflow("Public workflow"), user_id="owner-id", is_public=True)
    default = catalog_records.get_many(
        order_by=WorkflowRecordOrderBy.Name,
        direction=SQLiteDirection.Ascending,
        categories=[WorkflowCategory.Default],
        per_page=1,
    ).items[0]

    describe_workflow, _ = _catalog_tools()
    owner_result = describe_workflow(ctx=_ctx("owner-id"), workflow_id=private.workflow_id)
    missing_result = describe_workflow(ctx=_ctx("owner-id"), workflow_id="missing-workflow-id")
    public_result = describe_workflow(ctx=_ctx("owner-id"), workflow_id=public.workflow_id)
    default_result = describe_workflow(ctx=_ctx("owner-id"), workflow_id=default.workflow_id)
    admin_result = describe_workflow(ctx=_ctx("admin-id", is_admin=True), workflow_id=private.workflow_id)

    assert owner_result == admin_result == missing_result == {"status": "not_found"}
    assert public_result["status"] == "ok"
    assert public_result["workflow_id"] == public.workflow_id
    assert public_result["revision"] == public.revision
    assert set(public_result) == {
        "status",
        "workflow_id",
        "revision",
        "name",
        "description",
        "version",
        "category",
        "tags",
        "parameters",
    }
    assert default_result["status"] == "ok"
    assert default_result["workflow_id"] == default.workflow_id


def test_describe_defaults_missing_seed_mode_to_fixed(catalog_records: Any, monkeypatch: pytest.MonkeyPatch) -> None:
    _register_catalog_invocation(monkeypatch)
    workflow = catalog_records.create(
        _workflow(
            "Seed mode",
            nodes=[_node("node", {"seed": {"value": 42}})],
            form=_form(["seed"]),
        ),
        user_id="owner",
        is_public=True,
    )
    random_workflow = catalog_records.create(
        _workflow(
            "Random seed mode",
            nodes=[_node("node", {"seed": {"value": 42, "seedMode": "random"}})],
            form=_form(["seed"]),
        ),
        user_id="owner",
        is_public=True,
    )

    describe_workflow, _ = _catalog_tools()
    result = describe_workflow(ctx=_ctx("owner"), workflow_id=workflow.workflow_id)
    random_result = describe_workflow(ctx=_ctx("owner"), workflow_id=random_workflow.workflow_id)

    assert result["parameters"][0]["seed_mode"] == "fixed"
    assert random_result["parameters"][0]["seed_mode"] == "random"


def test_describe_uses_cycle_safe_form_order_and_registered_safe_inputs(
    catalog_records: Any, monkeypatch: pytest.MonkeyPatch
) -> None:
    _register_catalog_invocation(monkeypatch)
    nodes = [
        _node(
            "node",
            {
                "zero": {"value": 0},
                "enabled": {"value": False},
                "nullable": {"value": None},
                "required_any_saved": {"value": 0},
                "alpha": {
                    "value": {"nested": "graph-shaped string default"},
                    "label": "Saved Alpha",
                    "description": "Saved description",
                },
                "required_text": {"value": {"nested": "graph-shaped required value"}},
                "integer_values": {"value": [1, {"nested": "graph-shaped array value"}]},
                "hidden": {"value": "hidden-secret"},
                "connected": {"value": 8},
                "internal": {"value": "internal-secret"},
                "node_attribute": {"value": "attribute-secret"},
                "unsupported": {"value": {"secret": "unsupported-secret"}},
                "file_path": {"value": "/private/path.txt"},
                "unregistered": {"value": "unregistered-secret"},
            },
        )
    ]
    form = _form(
        [
            "zero",
            "enabled",
            "nullable",
            "required_any",
            "required_any_saved",
            "schema_only",
            "alpha",
            "required_text",
            "integer_values",
            "hidden",
            "connected",
            "internal",
            "node_attribute",
            "unsupported",
            "file_path",
            "unregistered",
            "zero",
        ]
    )
    form["elements"]["invalid"] = {"type": "node-field", "data": {"fieldIdentifier": {"nodeId": "node"}}}
    workflow = catalog_records.create(
        _workflow(
            "Safe parameters",
            nodes=nodes,
            edges=[{"source": "source", "sourceHandle": "value", "target": "node", "targetHandle": "connected"}],
            form=form,
            notes="secret workflow notes",
        ),
        user_id="owner",
        is_public=True,
    )

    describe_workflow, _ = _catalog_tools()
    result = describe_workflow(ctx=_ctx("owner"), workflow_id=workflow.workflow_id)
    parameters = result["parameters"]

    assert [parameter["name"] for parameter in parameters] == [
        "node::zero",
        "node::enabled",
        "node::nullable",
        "node::required_any",
        "node::required_any_saved",
        "node::schema_only",
        "node::alpha",
        "node::required_text",
        "node::integer_values",
    ]
    assert parameters[0]["input_schema"]["default"] == 0
    assert parameters[0]["input_schema"]["minimum"] == 0
    assert parameters[1]["input_schema"]["default"] is False
    assert parameters[2]["input_schema"]["default"] is None
    assert parameters[3]["required"] is True
    assert "default" not in parameters[3]["input_schema"]
    assert parameters[4]["input_schema"]["default"] == 0
    assert parameters[4]["required"] is False
    assert parameters[5]["input_schema"]["default"] == 0.25
    # Invalid saved values fall back to a valid schema default, or omit it for a required field.
    assert parameters[6]["input_schema"]["default"] == "schema alpha"
    assert parameters[6]["input_schema"]["title"] == "Saved Alpha"
    assert parameters[6]["input_schema"]["description"] == "Saved description"
    assert parameters[7]["required"] is True
    assert "default" not in parameters[7]["input_schema"]
    assert parameters[8]["input_schema"]["default"] == []
    assert parameters[8]["required"] is False
    assert "hidden-secret" not in str(result)
    assert "internal-secret" not in str(result)
    assert "attribute-secret" not in str(result)
    assert "unsupported-secret" not in str(result)
    assert "unregistered-secret" not in str(result)
    assert "/private/path.txt" not in str(result)
    assert "secret workflow notes" not in str(result)
    assert "graph-shaped" not in str(result)
    assert "user_id" not in result and "workflow" not in result


def test_describe_omits_path_and_nested_uri_resources(catalog_records: Any, monkeypatch: pytest.MonkeyPatch) -> None:
    from invokeai.app.invocations.image import SaveImageToFileInvocation

    _register_catalog_invocation(monkeypatch, {"save_image_to_file": SaveImageToFileInvocation})
    form = _form(["maybe_location", "folder", "links"])
    form["elements"]["export-directory"] = _field_element("export-directory", "output_directory", node_id="exporter")
    form["elements"]["root"]["data"]["children"].append("export-directory")
    workflow = catalog_records.create(
        _workflow(
            "Resources",
            nodes=[
                _node(
                    "node",
                    {
                        "maybe_location": {"value": "/private/mcp-file"},
                        "folder": {"value": "/private/mcp-folder"},
                        "links": {"value": ["https://private.example/resource"]},
                    },
                ),
                _node("exporter", {"output_directory": {"value": "private-output-folder"}}, "save_image_to_file"),
            ],
            form=form,
        ),
        user_id="owner",
        is_public=True,
    )

    describe_workflow, _ = _catalog_tools()
    result = describe_workflow(ctx=_ctx("owner"), workflow_id=workflow.workflow_id)

    assert result["parameters"] == []
    assert "/private/mcp-file" not in str(result)
    assert "/private/mcp-folder" not in str(result)
    assert "private.example/resource" not in str(result)
    assert "private-output-folder" not in str(result)


def test_describe_applies_valid_narrowing_form_number_settings(
    catalog_records: Any, monkeypatch: pytest.MonkeyPatch
) -> None:
    _register_catalog_invocation(monkeypatch)
    form = _form(["bounded_integer", "widened_integer", "wrong_kind_integer"])
    form["elements"]["bounded_integer"]["data"]["settings"] = {
        "type": "integer-field-config",
        "component": "number-input",
        "min": 10,
        "max": 40,
        "step": 10,
    }
    form["elements"]["widened_integer"]["data"]["settings"] = {
        "type": "integer-field-config",
        "component": "number-input",
        "min": 0,
        "max": 101,
        "step": 0.5,
    }
    form["elements"]["wrong_kind_integer"]["data"]["settings"] = {
        "type": "float-field-config",
        "component": "slider",
        "min": 10,
        "max": 40,
        "step": 10,
    }
    workflow = catalog_records.create(
        _workflow("Numeric settings", nodes=[_node("node", {})], form=form),
        user_id="owner",
        is_public=True,
    )

    describe_workflow, _ = _catalog_tools()
    result = describe_workflow(ctx=_ctx("owner"), workflow_id=workflow.workflow_id)
    parameters = {parameter["field_name"]: parameter["input_schema"] for parameter in result["parameters"]}

    assert parameters["bounded_integer"]["minimum"] == 10
    assert parameters["bounded_integer"]["maximum"] == 40
    assert parameters["bounded_integer"]["multipleOf"] == 10
    assert parameters["bounded_integer"]["default"] == 20
    assert parameters["widened_integer"]["minimum"] == 1
    assert parameters["widened_integer"]["maximum"] == 100
    assert "multipleOf" not in parameters["widened_integer"]
    assert parameters["wrong_kind_integer"]["minimum"] == 1
    assert parameters["wrong_kind_integer"]["maximum"] == 100
    assert "multipleOf" not in parameters["wrong_kind_integer"]


@pytest.mark.parametrize(
    "form",
    [None, {"rootElementId": "missing", "elements": {}}, {"rootElementId": "root", "elements": {"root": "bad"}}],
)
def test_describe_falls_back_to_ordered_legacy_exposed_fields_when_form_has_no_usable_fields(
    monkeypatch: pytest.MonkeyPatch,
    form: dict[str, Any] | None,
) -> None:
    _register_catalog_invocation(monkeypatch)
    workflow = _workflow(
        "Legacy form",
        nodes=[_node("node", {})],
        exposed_fields=[
            {"nodeId": "node", "fieldName": "alpha"},
            {"nodeId": "node", "fieldName": "zero"},
            {"nodeId": "node", "fieldName": "alpha"},
        ],
        form=form,
    )

    from invokeai.mcp.catalog import _workflow_parameters

    result = _workflow_parameters(workflow)

    assert [parameter["name"] for parameter in result] == ["node::alpha", "node::zero"]
    assert result[0]["input_schema"]["default"] == "schema alpha"
    assert result[1]["input_schema"]["default"] == 3


def test_describe_uses_usable_form_fields_without_appending_legacy_fallback(monkeypatch: pytest.MonkeyPatch) -> None:
    _register_catalog_invocation(monkeypatch)
    workflow = _workflow(
        "Form wins",
        nodes=[_node("node", {})],
        exposed_fields=[{"nodeId": "node", "fieldName": "zero"}],
        form=_form(["alpha"]),
    )

    from invokeai.mcp.catalog import _workflow_parameters

    result = _workflow_parameters(workflow)

    assert [parameter["name"] for parameter in result] == ["node::alpha"]


def test_describe_does_not_restore_legacy_fields_when_form_refs_are_unusable(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _register_catalog_invocation(monkeypatch)
    workflow = _workflow(
        "Unusable form fields",
        nodes=[_node("node", {})],
        edges=[{"source": "source", "sourceHandle": "value", "target": "node", "targetHandle": "connected"}],
        exposed_fields=[{"nodeId": "node", "fieldName": "alpha"}],
        form=_form(["hidden", "connected"]),
    )

    from invokeai.mcp.catalog import _workflow_parameters

    assert _workflow_parameters(workflow) == []


@pytest.mark.parametrize("tool_name", ["list_shared_workflows", "describe_workflow"])
def test_every_catalog_tool_requires_request_identity(tool_name: str) -> None:
    describe_workflow, list_shared_workflows = _catalog_tools()
    with pytest.raises(PermissionError, match="Authenticated MCP request required"):
        if tool_name == "list_shared_workflows":
            list_shared_workflows(
                page=0, per_page=20, ctx=SimpleNamespace(request_context=SimpleNamespace(request=None))
            )
        else:
            describe_workflow(
                workflow_id="workflow-id",
                ctx=SimpleNamespace(request_context=SimpleNamespace(request=None)),
            )
