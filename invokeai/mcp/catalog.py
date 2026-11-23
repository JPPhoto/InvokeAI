"""Workflow catalog tools for MCP clients."""

import math
import re
from collections.abc import Mapping, Sequence
from fractions import Fraction
from pathlib import Path
from typing import Any, get_args, get_origin

from mcp.server.mcpserver import Context
from starlette.requests import Request

from invokeai.app.api.dependencies import ApiDependencies
from invokeai.app.invocations.baseinvocation import InvocationRegistry
from invokeai.app.services.shared.pagination import SQLiteDirection
from invokeai.app.services.workflow_records.workflow_records_common import (
    WorkflowCategory,
    WorkflowNotFoundError,
    WorkflowRecordOrderBy,
)
from invokeai.mcp.auth import require_mcp_user

_MAX_PAGE = 1_000
_MAX_PER_PAGE = 100
_JSON_SCALAR_TYPES = frozenset({"boolean", "integer", "number", "string"})
_RESOURCE_FORMATS = frozenset({"binary", "directory-path", "file-path", "path", "uri", "uri-reference", "url"})
_SEED_MODES = frozenset({"fixed", "random", "increment", "decrement"})
_INPUT_SCHEMA_KEYS = frozenset(
    {
        "anyOf",
        "const",
        "default",
        "description",
        "enum",
        "exclusiveMaximum",
        "exclusiveMinimum",
        "format",
        "maximum",
        "maxItems",
        "maxLength",
        "minimum",
        "minItems",
        "minLength",
        "multipleOf",
        "oneOf",
        "pattern",
        "title",
        "type",
        "items",
    }
)


def _bounded_page(page: int, per_page: int) -> tuple[int, int]:
    if isinstance(page, bool) or not isinstance(page, int) or page < 0 or page > _MAX_PAGE:
        raise ValueError(f"page must be between 0 and {_MAX_PAGE}")
    if isinstance(per_page, bool) or not isinstance(per_page, int) or per_page < 1:
        raise ValueError("per_page must be a positive integer")
    return page, min(per_page, _MAX_PER_PAGE)


def _tags(value: str) -> list[str]:
    return [tag.strip() for tag in value.split(",") if tag.strip()]


def list_shared_workflows(ctx: Context[Any, Request], page: int = 0, per_page: int = 20) -> dict[str, Any]:
    """List built-in and published workflows. Pages are zero-based; page size is capped at 100."""
    require_mcp_user(ctx)
    page, per_page = _bounded_page(page, per_page)
    records = ApiDependencies.invoker.services.workflow_records.get_many(
        order_by=WorkflowRecordOrderBy.Name,
        direction=SQLiteDirection.Ascending,
        categories=None,
        page=page,
        per_page=per_page,
        query=None,
        tags=None,
        has_been_opened=None,
        shared_only=True,
    )
    return {
        "page": records.page,
        "per_page": records.per_page,
        "pages": records.pages,
        "total": records.total,
        "items": [
            {
                "workflow_id": item.workflow_id,
                "name": item.name,
                "description": item.description,
                "category": item.category.value,
                "tags": _tags(item.tags),
                "is_public": item.is_public,
                "updated_at": str(item.updated_at),
                "revision": item.revision,
            }
            for item in records.items
        ],
    }


def _form_field_references(form: Any) -> list[tuple[str, str, Mapping[str, Any] | None]]:
    if not isinstance(form, Mapping):
        return []
    elements = form.get("elements")
    root_id = form.get("rootElementId")
    if not isinstance(elements, Mapping) or not isinstance(root_id, str):
        return []

    references: list[tuple[str, str, Mapping[str, Any] | None]] = []
    stack = [root_id]
    visited: set[str] = set()
    while stack:
        element_id = stack.pop()
        if element_id in visited:
            continue
        visited.add(element_id)
        element = elements.get(element_id)
        if not isinstance(element, Mapping):
            continue

        if element.get("type") == "node-field":
            data = element.get("data")
            identifier = data.get("fieldIdentifier") if isinstance(data, Mapping) else None
            if isinstance(identifier, Mapping):
                node_id = identifier.get("nodeId")
                field_name = identifier.get("fieldName")
                if isinstance(node_id, str) and isinstance(field_name, str):
                    settings = data.get("settings")
                    references.append((node_id, field_name, settings if isinstance(settings, Mapping) else None))

        data = element.get("data")
        children = data.get("children") if isinstance(data, Mapping) else None
        if isinstance(children, Sequence) and not isinstance(children, (str, bytes)):
            stack.extend(child_id for child_id in reversed(children) if isinstance(child_id, str))
    return references


def _legacy_field_references(exposed_fields: Any) -> list[tuple[str, str, Mapping[str, Any] | None]]:
    if not isinstance(exposed_fields, Sequence) or isinstance(exposed_fields, (str, bytes)):
        return []
    references: list[tuple[str, str, Mapping[str, Any] | None]] = []
    for exposed_field in exposed_fields:
        if isinstance(exposed_field, Mapping):
            node_id = exposed_field.get("nodeId")
            field_name = exposed_field.get("fieldName")
        else:
            node_id = getattr(exposed_field, "nodeId", None)
            field_name = getattr(exposed_field, "fieldName", None)
        if isinstance(node_id, str) and isinstance(field_name, str):
            references.append((node_id, field_name, None))
    return references


def _node_maps(nodes: Any) -> dict[str, Mapping[str, Any]]:
    if not isinstance(nodes, Sequence) or isinstance(nodes, (str, bytes)):
        return {}
    by_id: dict[str, Mapping[str, Any]] = {}
    for node in nodes:
        if not isinstance(node, Mapping) or node.get("type") != "invocation":
            continue
        node_id = node.get("id")
        data = node.get("data")
        if isinstance(node_id, str) and isinstance(data, Mapping):
            by_id.setdefault(node_id, data)
    return by_id


def _connected_inputs(edges: Any) -> set[tuple[str, str]]:
    if not isinstance(edges, Sequence) or isinstance(edges, (str, bytes)):
        return set()
    return {
        (target, target_handle)
        for edge in edges
        if isinstance(edge, Mapping)
        for target, target_handle in [(edge.get("target"), edge.get("targetHandle"))]
        if isinstance(target, str) and isinstance(target_handle, str)
    }


def _is_resource_input(
    field_name: str,
    field_info: Any,
    schema: Mapping[str, Any],
    definitions: Mapping[str, Any],
) -> bool:
    name_parts = field_name.casefold().split("_")
    if {"directory", "path", "resource"}.intersection(name_parts):
        return True
    if _schema_contains_resource_format(schema, definitions):
        return True

    return _is_resource_annotation(field_info.annotation)


def _is_resource_annotation(annotation: Any) -> bool:
    if annotation is Path:
        return True
    if isinstance(annotation, type):
        if annotation.__name__.endswith("ResourceField"):
            return True
        try:
            if issubclass(annotation, Path):
                return True
        except TypeError:
            pass
    origin = get_origin(annotation)
    return origin is not None and any(_is_resource_annotation(arg) for arg in get_args(annotation))


def _schema_contains_resource_format(
    schema: Any,
    definitions: Mapping[str, Any],
    resolving: frozenset[str] = frozenset(),
) -> bool:
    if not isinstance(schema, Mapping):
        return False

    format_ = schema.get("format")
    if isinstance(format_, str) and format_.casefold() in _RESOURCE_FORMATS:
        return True
    if "contentEncoding" in schema:
        return True

    reference = schema.get("$ref")
    if isinstance(reference, str) and reference not in resolving:
        resolved = _resolve_ref(schema, definitions)
        if resolved is not None and _schema_contains_resource_format(resolved, definitions, resolving | {reference}):
            return True

    for value in schema.values():
        if isinstance(value, Mapping) and _schema_contains_resource_format(value, definitions, resolving):
            return True
        if isinstance(value, Sequence) and not isinstance(value, (str, bytes)):
            if any(_schema_contains_resource_format(item, definitions, resolving) for item in value):
                return True
    return False


def _resolve_ref(schema: Mapping[str, Any], definitions: Mapping[str, Any]) -> Mapping[str, Any] | None:
    reference = schema.get("$ref")
    if not isinstance(reference, str) or not reference.startswith("#/$defs/"):
        return None
    definition = definitions.get(reference.rsplit("/", 1)[-1])
    if not isinstance(definition, Mapping):
        return None
    return {**definition, **{key: value for key, value in schema.items() if key != "$ref"}}


def _is_supported_schema(
    schema: Any, definitions: Mapping[str, Any], *, allow_array: bool = True, resolving: frozenset[str] = frozenset()
) -> bool:
    if not isinstance(schema, Mapping):
        return False
    reference = schema.get("$ref")
    if isinstance(reference, str):
        if reference in resolving:
            return False
        resolved = _resolve_ref(schema, definitions)
        return resolved is not None and _is_supported_schema(
            resolved, definitions, allow_array=allow_array, resolving=resolving | {reference}
        )

    schema_type = schema.get("type")
    if isinstance(schema_type, str):
        if schema_type in _JSON_SCALAR_TYPES:
            return True
        if schema_type == "array" and allow_array:
            return _is_supported_schema(schema.get("items"), definitions, allow_array=False, resolving=resolving)
        if schema_type == "null":
            return True
        return False
    if isinstance(schema_type, list):
        return any(value != "null" for value in schema_type) and all(
            value == "null" or value in _JSON_SCALAR_TYPES for value in schema_type
        )

    choices = schema.get("anyOf") or schema.get("oneOf")
    if isinstance(choices, list):
        non_null = [choice for choice in choices if not (isinstance(choice, Mapping) and choice.get("type") == "null")]
        return bool(non_null) and all(
            _is_supported_schema(choice, definitions, allow_array=allow_array, resolving=resolving)
            for choice in non_null
        )
    return False


def _public_schema(
    schema: Mapping[str, Any], definitions: Mapping[str, Any], resolving: frozenset[str] = frozenset()
) -> dict[str, Any]:
    reference = schema.get("$ref")
    if isinstance(reference, str):
        if reference in resolving:
            return {}
        resolved = _resolve_ref(schema, definitions)
        if resolved is None:
            return {}
        return _public_schema(resolved, definitions, resolving | {reference})

    result: dict[str, Any] = {}
    for key, value in schema.items():
        if key not in _INPUT_SCHEMA_KEYS:
            continue
        if key == "items" and isinstance(value, Mapping):
            result[key] = _public_schema(value, definitions, resolving)
        elif key in {"anyOf", "oneOf"} and isinstance(value, list):
            result[key] = [
                _public_schema(option, definitions, resolving) if isinstance(option, Mapping) else option
                for option in value
            ]
        else:
            result[key] = value
    return result


def _schema_value_matches(
    schema: Any,
    value: Any,
    definitions: Mapping[str, Any],
    resolving: frozenset[str] = frozenset(),
) -> bool:
    if not isinstance(schema, Mapping):
        return False

    reference = schema.get("$ref")
    if isinstance(reference, str):
        if reference in resolving:
            return False
        resolved = _resolve_ref(schema, definitions)
        return resolved is not None and _schema_value_matches(resolved, value, definitions, resolving | {reference})

    any_of = schema.get("anyOf")
    one_of = schema.get("oneOf")
    if isinstance(any_of, list) and not any(
        _schema_value_matches(choice, value, definitions, resolving) for choice in any_of
    ):
        return False
    if (
        isinstance(one_of, list)
        and sum(_schema_value_matches(choice, value, definitions, resolving) for choice in one_of) != 1
    ):
        return False
    has_choices = isinstance(any_of, list) or isinstance(one_of, list)

    schema_type = schema.get("type")
    if isinstance(schema_type, list):
        if not any(_schema_type_matches(candidate, value) for candidate in schema_type):
            return False
    elif isinstance(schema_type, str):
        if not _schema_type_matches(schema_type, value):
            return False
    elif not has_choices:
        return False

    if "const" in schema and value != schema["const"]:
        return False
    enum = schema.get("enum")
    if isinstance(enum, list) and value not in enum:
        return False

    if isinstance(value, (int, float)) and not isinstance(value, bool):
        if isinstance(value, float) and not math.isfinite(value):
            return False
        if isinstance(schema.get("minimum"), (int, float)) and value < schema["minimum"]:
            return False
        if isinstance(schema.get("maximum"), (int, float)) and value > schema["maximum"]:
            return False
        if isinstance(schema.get("exclusiveMinimum"), (int, float)) and value <= schema["exclusiveMinimum"]:
            return False
        if isinstance(schema.get("exclusiveMaximum"), (int, float)) and value >= schema["exclusiveMaximum"]:
            return False
        multiple_of = schema.get("multipleOf")
        if isinstance(multiple_of, (int, float)) and multiple_of > 0:
            try:
                if Fraction(str(value)) % Fraction(str(multiple_of)) != 0:
                    return False
            except (ValueError, ZeroDivisionError):
                return False

    if isinstance(value, str):
        if isinstance(schema.get("minLength"), int) and len(value) < schema["minLength"]:
            return False
        if isinstance(schema.get("maxLength"), int) and len(value) > schema["maxLength"]:
            return False
        pattern = schema.get("pattern")
        if isinstance(pattern, str):
            try:
                if re.search(pattern, value) is None:
                    return False
            except re.error:
                return False

    if isinstance(value, list):
        if isinstance(schema.get("minItems"), int) and len(value) < schema["minItems"]:
            return False
        if isinstance(schema.get("maxItems"), int) and len(value) > schema["maxItems"]:
            return False
        items = schema.get("items")
        if items is not None and (
            not isinstance(items, Mapping)
            or not all(_schema_value_matches(items, item, definitions, resolving) for item in value)
        ):
            return False

    return True


def _schema_type_matches(schema_type: str, value: Any) -> bool:
    if schema_type == "null":
        return value is None
    if schema_type == "boolean":
        return isinstance(value, bool)
    if schema_type == "integer":
        return isinstance(value, int) and not isinstance(value, bool)
    if schema_type == "number":
        return isinstance(value, (int, float)) and not isinstance(value, bool)
    if schema_type == "string":
        return isinstance(value, str)
    if schema_type == "array":
        return isinstance(value, list)
    return False


def _numeric_schema_type(schema: Mapping[str, Any]) -> str | None:
    schema_type = schema.get("type")
    if isinstance(schema_type, str) and schema_type in {"integer", "number"}:
        return schema_type
    if isinstance(schema_type, list):
        numeric_types = [value for value in schema_type if value in ("integer", "number")]
        return numeric_types[0] if len(numeric_types) == 1 else None

    choices = schema.get("anyOf") or schema.get("oneOf")
    if isinstance(choices, list):
        numeric_types = [
            _numeric_schema_type(choice)
            for choice in choices
            if isinstance(choice, Mapping) and choice.get("type") != "null"
        ]
        if numeric_types and all(value == numeric_types[0] for value in numeric_types):
            return numeric_types[0]
    return None


def _finite_number(value: Any) -> bool:
    return not isinstance(value, bool) and (
        isinstance(value, int) or (isinstance(value, float) and math.isfinite(value))
    )


def _apply_form_number_settings(schema: dict[str, Any], settings: Any) -> None:
    if not isinstance(settings, Mapping):
        return

    schema_type = _numeric_schema_type(schema)
    if schema_type is None:
        return
    expected_settings_type = "integer-field-config" if schema_type == "integer" else "float-field-config"
    if settings.get("type") not in (None, expected_settings_type):
        return

    minimum = settings.get("min")
    maximum = settings.get("max")
    minimum = minimum if _finite_number(minimum) else None
    maximum = maximum if _finite_number(maximum) else None
    inverted_bounds = minimum is not None and maximum is not None and minimum > maximum

    if minimum is not None and not inverted_bounds:
        upper = schema.get("maximum")
        exclusive_upper = schema.get("exclusiveMaximum")
        current = schema.get("minimum")
        exclusive_current = schema.get("exclusiveMinimum")
        inside_upper = (not _finite_number(upper) or minimum <= upper) and (
            not _finite_number(exclusive_upper) or minimum < exclusive_upper
        )
        narrows_lower = (
            minimum > current
            if _finite_number(current)
            else minimum > exclusive_current
            if _finite_number(exclusive_current)
            else True
        )
        if inside_upper and narrows_lower:
            schema.pop("exclusiveMinimum", None)
            schema["minimum"] = minimum

    if maximum is not None and not inverted_bounds:
        lower = schema.get("minimum")
        exclusive_lower = schema.get("exclusiveMinimum")
        current = schema.get("maximum")
        exclusive_current = schema.get("exclusiveMaximum")
        inside_lower = (not _finite_number(lower) or maximum >= lower) and (
            not _finite_number(exclusive_lower) or maximum > exclusive_lower
        )
        narrows_upper = (
            maximum < current
            if _finite_number(current)
            else maximum < exclusive_current
            if _finite_number(exclusive_current)
            else True
        )
        if inside_lower and narrows_upper:
            schema.pop("exclusiveMaximum", None)
            schema["maximum"] = maximum

    step = settings.get("step")
    current_step = schema.get("multipleOf")
    step_is_valid = _finite_number(step) and step > 0
    if schema_type == "integer":
        step_is_valid = step_is_valid and isinstance(step, int)
    if step_is_valid and _finite_number(current_step) and current_step > 0:
        ratio = step / current_step
        step_is_valid = abs(ratio - round(ratio)) < 1e-9
    if step_is_valid:
        schema["multipleOf"] = step


def _field_parameter(
    node_id: str,
    field_name: str,
    node_data: Mapping[str, Any],
    invocation_cache: dict[str, tuple[Any, Mapping[str, Any], Mapping[str, Any]] | None],
    connected: set[tuple[str, str]],
    form_settings: Mapping[str, Any] | None,
) -> dict[str, Any] | None:
    node_type = node_data.get("type")
    if not isinstance(node_type, str) or (node_id, field_name) in connected:
        return None
    if node_type not in invocation_cache:
        invocation_class = InvocationRegistry.get_invocation_for_type(node_type)
        if invocation_class is None:
            invocation_cache[node_type] = None
        else:
            invocation_schema = invocation_class.model_json_schema()
            properties = invocation_schema.get("properties")
            definitions = invocation_schema.get("$defs", {})
            invocation_cache[node_type] = (
                (invocation_class, properties, definitions if isinstance(definitions, Mapping) else {})
                if isinstance(properties, Mapping)
                else None
            )
    cached = invocation_cache[node_type]
    if cached is None:
        return None

    invocation_class, properties, definitions = cached
    field_info = invocation_class.model_fields.get(field_name)
    field_schema = properties.get(field_name)
    if field_info is None or not isinstance(field_schema, Mapping):
        return None
    extra = field_info.json_schema_extra
    if not isinstance(extra, Mapping):
        return None
    if (
        extra.get("field_kind") != "input"
        or extra.get("input") not in {"direct", "any"}
        or extra.get("ui_hidden") is True
    ):
        return None

    input_kind = extra.get("input")
    original_required = extra.get("orig_required")

    if _is_resource_input(field_name, field_info, field_schema, definitions):
        return None
    if not _is_supported_schema(field_schema, definitions):
        return None

    input_schema = _public_schema(field_schema, definitions)
    _apply_form_number_settings(input_schema, form_settings)
    inputs = node_data.get("inputs")
    instance = inputs.get(field_name) if isinstance(inputs, Mapping) else None
    is_seed = field_name == "seed" and input_schema.get("type") == "integer"
    seed_mode = None
    if is_seed:
        raw_seed_mode = instance.get("seedMode") if isinstance(instance, Mapping) else None
        seed_mode = raw_seed_mode if isinstance(raw_seed_mode, str) and raw_seed_mode in _SEED_MODES else "fixed"
    has_saved_value = isinstance(instance, Mapping) and "value" in instance
    saved_value_is_valid = has_saved_value and _schema_value_matches(input_schema, instance["value"], definitions)
    if input_kind == "any" and original_required is True and not saved_value_is_valid:
        # Input.Any is optional in the Pydantic model so a connection can provide it. Its None
        # schema default is synthetic; the original requiredness lives in json_schema_extra.
        input_schema.pop("default", None)
    invalid_schema_default = "default" in input_schema and not _schema_value_matches(
        input_schema, input_schema["default"], definitions
    )
    if invalid_schema_default:
        input_schema.pop("default")
    if isinstance(instance, Mapping):
        label = instance.get("label")
        if isinstance(label, str) and label:
            input_schema["title"] = label
        description = instance.get("description")
        if instance.get("descriptionOverride") is True:
            if isinstance(description, str):
                input_schema["description"] = description
            else:
                input_schema.pop("description", None)
        elif isinstance(description, str) and description:
            input_schema["description"] = description
        if saved_value_is_valid:
            input_schema["default"] = instance["value"]

    required = original_required if isinstance(original_required, bool) else "default" not in input_schema
    if invalid_schema_default:
        required = True
    if saved_value_is_valid:
        required = False
    if seed_mode == "random":
        required = False

    parameter = {
        "name": f"{node_id}::{field_name}",
        "node_id": node_id,
        "field_name": field_name,
        "required": required,
        "input_schema": input_schema,
    }
    if is_seed:
        parameter["seed_mode"] = seed_mode
    return parameter


def _workflow_parameters(workflow: Any) -> list[dict[str, Any]]:
    nodes = _node_maps(workflow.nodes)
    connected = _connected_inputs(workflow.edges)
    invocation_cache: dict[str, tuple[Any, Mapping[str, Any], Mapping[str, Any]] | None] = {}

    def extract(references: Sequence[tuple[str, str, Mapping[str, Any] | None]]) -> list[dict[str, Any]]:
        parameters: list[dict[str, Any]] = []
        seen: set[tuple[str, str]] = set()
        for node_id, field_name, form_settings in references:
            key = (node_id, field_name)
            if key in seen:
                continue
            node_data = nodes.get(node_id)
            if node_data is None:
                continue
            parameter = _field_parameter(node_id, field_name, node_data, invocation_cache, connected, form_settings)
            if parameter is not None:
                seen.add(key)
                parameters.append(parameter)
        return parameters

    form_references = _form_field_references(workflow.form)
    if form_references:
        return extract(form_references)
    return extract(_legacy_field_references(workflow.exposedFields))


def _workflow_seed_parameters(workflow: Any) -> list[dict[str, Any]]:
    nodes = _node_maps(workflow.nodes)
    connected = _connected_inputs(workflow.edges)
    invocation_cache: dict[str, tuple[Any, Mapping[str, Any], Mapping[str, Any]] | None] = {}
    return [
        parameter
        for node_id, node_data in nodes.items()
        if (parameter := _field_parameter(node_id, "seed", node_data, invocation_cache, connected, None)) is not None
    ]


def describe_workflow(ctx: Context[Any, Request], workflow_id: str) -> dict[str, Any]:
    """Describe a built-in or published workflow and its direct, supported inputs."""
    require_mcp_user(ctx)
    try:
        record = ApiDependencies.invoker.services.workflow_records.get(workflow_id)
    except WorkflowNotFoundError:
        return {"status": "not_found"}

    if record.workflow.meta.category is not WorkflowCategory.Default and not record.is_public:
        return {"status": "not_found"}

    workflow = record.workflow
    return {
        "status": "ok",
        "workflow_id": record.workflow_id,
        "revision": record.revision,
        "name": workflow.name,
        "description": workflow.description,
        "version": workflow.version,
        "category": workflow.meta.category.value,
        "tags": _tags(workflow.tags),
        "parameters": _workflow_parameters(workflow),
    }
