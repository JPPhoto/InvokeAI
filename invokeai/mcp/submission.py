"""Submission receipt tools for MCP clients."""

import asyncio
import hashlib
import json
import math
import secrets
from collections.abc import Mapping
from fractions import Fraction
from math import gcd
from typing import Annotated, Any

from fastapi import HTTPException
from mcp.server.mcpserver import Context
from mcp.server.mcpserver.exceptions import ToolError
from pydantic import Field
from starlette.requests import Request

from invokeai.app.api.dependencies import ApiDependencies
from invokeai.app.api.routers.image_move_maintenance import assert_image_move_maintenance_inactive
from invokeai.app.invocations.baseinvocation import Classification, InvocationRegistry
from invokeai.app.services.session_queue.session_queue_common import (
    DEFAULT_QUEUE_ID,
    Batch,
    EnqueueBatchReceipt,
    EnqueueBatchResult,
    EnqueueIdempotencyConflictError,
    EnqueueReceiptLimitError,
    TooManySessionsError,
)
from invokeai.app.services.shared.workflow_graph_builder import (
    InvalidWorkflowInputError,
    UnsupportedWorkflowNodeError,
    build_graph_from_workflow,
)
from invokeai.app.services.workflow_records.workflow_records_common import (
    WorkflowCategory,
    WorkflowNotFoundError,
    WorkflowWithoutID,
)
from invokeai.app.util.misc import SEED_MAX
from invokeai.mcp.auth import require_mcp_user
from invokeai.mcp.catalog import _schema_value_matches, _workflow_parameters, _workflow_seed_parameters

_ACCEPTED_SEED_MODES = frozenset({"fixed", "random"})


def _request_fingerprint(workflow_id: str, revision: int, parameters: Mapping[str, Any]) -> str:
    try:
        canonical_request = json.dumps(
            {"workflow_id": workflow_id, "revision": revision, "parameters": parameters},
            ensure_ascii=False,
            separators=(",", ":"),
            sort_keys=True,
            allow_nan=False,
        )
    except (TypeError, ValueError) as error:
        raise ToolError("parameters must contain only finite JSON values") from error
    return hashlib.sha256(canonical_request.encode("utf-8")).hexdigest()


def _random_seed(schema: Mapping[str, Any]) -> int:
    if "const" in schema:
        constant = schema["const"]
        if isinstance(constant, int) and not isinstance(constant, bool) and _schema_value_matches(schema, constant, {}):
            return constant
        raise ToolError("Random seed mode has no valid seed values")
    enum = schema.get("enum")
    if isinstance(enum, list):
        allowed = [value for value in enum if isinstance(value, int) and not isinstance(value, bool)]
        allowed = [value for value in allowed if _schema_value_matches(schema, value, {})]
        if not allowed:
            raise ToolError("Random seed mode has no valid seed values")
        return allowed[secrets.randbelow(len(allowed))]

    minimum = schema.get("minimum", 0)
    maximum = schema.get("maximum", SEED_MAX)
    lower = max(0, math.ceil(minimum) if isinstance(minimum, (int, float)) else 0)
    upper = min(SEED_MAX, math.floor(maximum) if isinstance(maximum, (int, float)) else SEED_MAX)
    exclusive_minimum = schema.get("exclusiveMinimum")
    exclusive_maximum = schema.get("exclusiveMaximum")
    if isinstance(exclusive_minimum, (int, float)):
        lower = max(lower, math.floor(exclusive_minimum) + 1)
    if isinstance(exclusive_maximum, (int, float)):
        upper = min(upper, math.ceil(exclusive_maximum) - 1)

    multiple_of = schema.get("multipleOf", 1)
    if not isinstance(multiple_of, (int, float)) or multiple_of <= 0:
        raise ToolError("Random seed mode has no valid seed values")
    fraction = Fraction(str(multiple_of))
    step = fraction.numerator // gcd(fraction.numerator, fraction.denominator)
    first = ((lower + step - 1) // step) * step
    count = (upper - first) // step + 1
    if count <= 0:
        raise ToolError("Random seed mode has no valid seed values")
    seed = first + secrets.randbelow(count) * step
    if not _schema_value_matches(schema, seed, {}):
        raise ToolError("Random seed mode has no valid seed values")
    return seed


def _reject_unsupported_nodes(workflow: WorkflowWithoutID) -> None:
    for node in workflow.nodes:
        if node.get("type") != "invocation":
            continue
        data = node.get("data")
        node_type = data.get("type") if isinstance(data, Mapping) else None
        if not isinstance(node_type, str):
            continue
        invocation_class = InvocationRegistry.get_invocation_for_type(node_type)
        if node_type.endswith(("_batch", "_generator")) or (
            invocation_class is not None
            and invocation_class.UIConfig.category == "batch"
            and invocation_class.UIConfig.classification == Classification.Special
        ):
            raise ToolError("Batch and generator nodes are not supported by submit_workflow")


def _apply_parameters(workflow: WorkflowWithoutID, parameters: Mapping[str, Any]) -> None:
    described_parameters = _workflow_parameters(workflow)
    by_name = {parameter["name"]: parameter for parameter in described_parameters}
    unknown_parameters = parameters.keys() - by_name.keys()
    if unknown_parameters:
        raise ToolError(f"Unknown workflow parameter: {sorted(unknown_parameters)[0]}")

    all_parameters = dict(by_name)
    for parameter in _workflow_seed_parameters(workflow):
        all_parameters.setdefault(parameter["name"], parameter)
    valid_defaults = {
        name: parameter["input_schema"]["default"]
        for name, parameter in all_parameters.items()
        if "default" in parameter["input_schema"]
        and _schema_value_matches(parameter["input_schema"], parameter["input_schema"]["default"], {})
    }
    for parameter in all_parameters.values():
        mode = parameter.get("seed_mode", "fixed")
        if mode not in _ACCEPTED_SEED_MODES:
            raise ToolError("Increment and decrement seed modes are not supported by submit_workflow")
        if (
            parameter["name"] in by_name
            and parameter["required"]
            and parameter["name"] not in parameters
            and parameter["name"] not in valid_defaults
        ):
            raise ToolError(f"Missing required workflow parameter: {parameter['name']}")
        if parameter["name"] in parameters and not _schema_value_matches(
            parameter["input_schema"], parameters[parameter["name"]], {}
        ):
            raise ToolError(f"Invalid value for workflow parameter: {parameter['name']}")

    nodes_by_id = {node["id"]: node for node in workflow.nodes if isinstance(node.get("id"), str)}
    for parameter in all_parameters.values():
        name = parameter["name"]
        seed_mode = parameter.get("seed_mode")
        if name in parameters:
            value = parameters[name]
        elif seed_mode == "random":
            value = _random_seed(parameter["input_schema"])
        elif name in valid_defaults:
            value = valid_defaults[name]
        else:
            continue

        node = nodes_by_id[parameter["node_id"]]
        data = node["data"]
        if not isinstance(data, dict):
            raise ToolError("Workflow parameter target is invalid")
        inputs = data.setdefault("inputs", {})
        if not isinstance(inputs, dict):
            raise ToolError("Workflow parameter target is invalid")
        instance = inputs.get(parameter["field_name"])
        if not isinstance(instance, dict):
            instance = {}
            inputs[parameter["field_name"]] = instance
        instance["value"] = value


def _prepare_submission(
    user_id: str,
    workflow_id: str,
    revision: int,
    parameters: Mapping[str, Any],
    idempotency_key: str,
) -> tuple[str, EnqueueBatchReceipt | Batch]:
    request_fingerprint = _request_fingerprint(workflow_id, revision, parameters)
    services = ApiDependencies.invoker.services
    try:
        receipt = services.session_queue.get_enqueue_receipt(
            queue_id=DEFAULT_QUEUE_ID,
            idempotency_key=idempotency_key,
            user_id=user_id,
            request_fingerprint=request_fingerprint,
        )
    except EnqueueIdempotencyConflictError as error:
        raise ToolError("This idempotency key was already used for a different request") from error
    if receipt is not None:
        return request_fingerprint, receipt

    try:
        record = services.workflow_records.get(workflow_id)
    except WorkflowNotFoundError as error:
        raise ToolError("Workflow not found or not available") from error

    if record.workflow.meta.category is not WorkflowCategory.Default and not record.is_public:
        raise ToolError("Workflow not found or not available")
    if record.revision != revision:
        raise ToolError("Workflow revision is stale; describe the workflow again before submitting")

    workflow = WorkflowWithoutID.model_validate(record.workflow.model_dump(exclude={"id"}))
    _reject_unsupported_nodes(workflow)
    _apply_parameters(workflow, parameters)
    try:
        graph = build_graph_from_workflow(workflow.model_dump(mode="python"), workflow_mode="root")
        graph.validate_self()
    except (InvalidWorkflowInputError, UnsupportedWorkflowNodeError, ValueError, TypeError) as error:
        raise ToolError("Workflow graph is invalid or cannot be submitted") from error

    return request_fingerprint, Batch(
        graph=graph,
        workflow=workflow,
        runs=1,
        data=None,
        idempotency_key=idempotency_key,
    )


def _accepted(batch_id: str, item_ids: list[int], requested: int, enqueued: int) -> dict[str, Any]:
    return {
        "status": "accepted",
        "batch_id": batch_id,
        "item_ids": item_ids,
        "requested": requested,
        "enqueued": enqueued,
    }


async def submit_workflow(
    ctx: Context[Any, Request],
    workflow_id: Annotated[str, Field(min_length=1, description="The workflow to submit.")],
    revision: Annotated[
        int, Field(strict=True, gt=0, description="The workflow revision returned by describe_workflow.")
    ],
    parameters: dict[str, Any],
    idempotency_key: Annotated[str, Field(min_length=1, max_length=255)],
) -> dict[str, Any]:
    """Submit one run of a public or built-in workflow with exposed parameter values."""
    token = require_mcp_user(ctx)
    if isinstance(revision, bool) or not isinstance(revision, int) or revision <= 0:
        raise ToolError("revision must be a positive integer")
    if not isinstance(parameters, Mapping) or any(not isinstance(key, str) for key in parameters):
        raise ToolError("parameters must be an object with string keys")

    try:
        request_fingerprint, prepared = await asyncio.to_thread(
            _prepare_submission, token.user_id, workflow_id, revision, parameters, idempotency_key
        )
    except ToolError:
        raise
    except (EnqueueIdempotencyConflictError, EnqueueReceiptLimitError, TooManySessionsError) as error:
        raise ToolError("The queue cannot accept this submission right now; retry later") from error

    if isinstance(prepared, EnqueueBatchReceipt):
        return _accepted(prepared.batch_id, prepared.item_ids, prepared.requested, prepared.enqueued)

    try:
        await asyncio.to_thread(assert_image_move_maintenance_inactive)
    except HTTPException as error:
        if error.status_code == 409:
            raise ToolError("Image storage maintenance is active") from error
        raise

    try:
        result: EnqueueBatchResult = await ApiDependencies.invoker.services.session_queue.enqueue_batch(
            DEFAULT_QUEUE_ID,
            prepared,
            prepend=False,
            user_id=token.user_id,
            request_fingerprint=request_fingerprint,
        )
    except EnqueueIdempotencyConflictError as error:
        raise ToolError("This idempotency key was already used for a different request") from error
    except (EnqueueReceiptLimitError, TooManySessionsError) as error:
        raise ToolError("The queue cannot accept this submission right now; retry later") from error
    if result.enqueued == 0:
        raise ToolError("The queue is full; retry this request later")
    return _accepted(result.batch.batch_id, result.item_ids, result.requested, result.enqueued)


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
