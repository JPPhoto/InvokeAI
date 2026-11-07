"""Read-only MCP tools for submitted InvokeAI jobs."""

import asyncio
import base64
import mimetypes
import types
from collections.abc import Iterator, Mapping
from pathlib import Path
from typing import Annotated, Any, Union, get_args, get_origin

from fastapi import HTTPException
from mcp.server.mcpserver import Context
from mcp.server.mcpserver.exceptions import ToolError
from mcp.types import CallToolResult, ImageContent
from pydantic import Field, ValidationError
from starlette.requests import Request

from invokeai.app.api.dependencies import ApiDependencies
from invokeai.app.api.routers._access import assert_image_read_access
from invokeai.app.api.routers.image_move_maintenance import assert_image_move_maintenance_inactive
from invokeai.app.invocations.baseinvocation import BaseInvocationOutput, InvocationRegistry
from invokeai.app.invocations.fields import ImageField
from invokeai.app.invocations.workflow_return import WorkflowReturnOutput
from invokeai.app.services.image_records.image_records_common import ImageRecordNotFoundException
from invokeai.app.services.session_queue.session_queue_common import (
    DEFAULT_QUEUE_ID,
    SessionQueueItem,
    SessionQueueItemNotFoundError,
)
from invokeai.mcp.auth import require_mcp_user

MAX_EMBEDDED_IMAGES = 4
MAX_EMBEDDED_IMAGE_BYTES = 16 * 1024 * 1024

JobItemId = Annotated[int, Field(strict=True, gt=0)]
JobItemIds = Annotated[list[JobItemId], Field(min_length=1)]
BatchId = Annotated[str, Field(min_length=1, max_length=255)]


def _unavailable(batch_id: str, item_ids: list[int]) -> dict[str, Any]:
    return {"status": "unavailable", "batch_id": batch_id, "item_ids": item_ids}


def _get_job_items(batch_id: str, item_ids: list[int], user_id: str) -> list[SessionQueueItem] | None:
    """Load only the exact items after checking queue and owner via the lightweight owner projection."""
    queue = ApiDependencies.invoker.services.session_queue
    seen: set[int] = set()
    for item_id in item_ids:
        if item_id in seen:
            return None
        seen.add(item_id)
        try:
            owner = queue.get_queue_item_owner(item_id)
        except SessionQueueItemNotFoundError:
            return None
        if owner.queue_id != DEFAULT_QUEUE_ID or owner.user_id != user_id:
            return None

    items: list[SessionQueueItem] = []
    for item_id in item_ids:
        try:
            item = queue.get_queue_item_for_api(item_id)
        except SessionQueueItemNotFoundError:
            return None
        if item.queue_id != DEFAULT_QUEUE_ID or item.batch_id != batch_id or item.user_id != user_id:
            return None
        items.append(item)
    return items


def _item_status(item: SessionQueueItem) -> dict[str, Any]:
    return {
        "item_id": item.item_id,
        "status": item.status,
        "error_type": item.error_type,
        "error_message": "Job failed; detailed error omitted." if item.error_message is not None else None,
    }


async def get_job_status(ctx: Context[Any, Request], batch_id: BatchId, item_ids: JobItemIds) -> dict[str, Any]:
    """Get queue status for the exact items returned when a workflow was submitted."""
    token = require_mcp_user(ctx)
    items = await asyncio.to_thread(_get_job_items, batch_id, item_ids, token.user_id)
    if items is None:
        return _unavailable(batch_id, item_ids)
    return {"status": "available", "batch_id": batch_id, "items": [_item_status(item) for item in items]}


def _iter_declared_image_names(value: Any, annotation: Any) -> Iterator[str]:
    origin = get_origin(annotation)
    args = get_args(annotation)
    if origin is Annotated:
        yield from _iter_declared_image_names(value, args[0])
        return
    if origin in (Union, types.UnionType):
        for arg in args:
            if arg is not type(None):
                yield from _iter_declared_image_names(value, arg)
        return
    if annotation is ImageField:
        if isinstance(value, ImageField):
            yield value.image_name
        elif isinstance(value, Mapping) and isinstance(value.get("image_name"), str):
            try:
                yield ImageField.model_validate(value).image_name
            except ValidationError:
                return
        return
    if origin in (list, tuple):
        if not isinstance(value, (list, tuple)) or not args:
            return
        for child in value:
            yield from _iter_declared_image_names(child, args[0])


def _iter_image_names(value: Any) -> Iterator[str]:
    if isinstance(value, Mapping):
        output_type = value.get("type")
        output_class = InvocationRegistry.get_output_for_type(output_type) if isinstance(output_type, str) else None
        if output_class is None:
            return
        try:
            value = output_class.model_validate(value)
        except ValidationError:
            return
    if not isinstance(value, BaseInvocationOutput):
        return
    if isinstance(value, WorkflowReturnOutput):
        for returned_value in value.values.values():
            yield from _iter_returned_image_names(returned_value)
        return
    for field_name, field_info in type(value).model_fields.items():
        yield from _iter_declared_image_names(getattr(value, field_name, None), field_info.annotation)


def _iter_returned_image_names(value: Any) -> Iterator[str]:
    if isinstance(value, ImageField):
        yield value.image_name
    elif isinstance(value, BaseInvocationOutput):
        yield from _iter_image_names(value)
    elif isinstance(value, Mapping):
        if isinstance(value.get("image_name"), str):
            yield from _iter_declared_image_names(value, ImageField)
        else:
            yield from _iter_image_names(value)
    elif isinstance(value, (list, tuple)):
        for child in value:
            yield from _iter_returned_image_names(child)


def _unavailable_image(node_id: str, image_index: int) -> dict[str, Any]:
    return {"node_id": node_id, "image_index": image_index, "status": "unavailable"}


def _assert_image_read_maintenance_inactive() -> None:
    try:
        assert_image_move_maintenance_inactive()
    except HTTPException as error:
        if error.status_code == 409:
            raise ToolError("Image storage maintenance is active; retry later") from error
        raise


def _request_path(url: str, scope: Mapping[str, Any]) -> str:
    root_path = scope.get("app_root_path", scope.get("root_path", ""))
    if not isinstance(root_path, str):
        root_path = ""
    path = f"/{url.lstrip('/')}"
    return f"{root_path.rstrip('/')}{path}"


def _append_image_result(
    *,
    node_id: str,
    image_index: int,
    image_name: str,
    user: Any,
    scope: Mapping[str, Any],
    content: list[ImageContent],
    embedded_count: int,
    embedded_bytes: int,
) -> tuple[dict[str, Any] | None, ImageContent | None, int]:
    try:
        assert_image_read_access(image_name, user)
    except HTTPException as error:
        if error.status_code in (403, 404):
            return _unavailable_image(node_id, image_index), None, embedded_bytes
        raise

    services = ApiDependencies.invoker.services
    try:
        record = services.image_records.get(image_name)
    except ImageRecordNotFoundException:
        return _unavailable_image(node_id, image_index), None, embedded_bytes
    if record.is_intermediate:
        return None, None, embedded_bytes

    _assert_image_read_maintenance_inactive()

    try:
        image_path = Path(services.images.get_path(image_name))
        file_size = image_path.stat().st_size
    except (ImageRecordNotFoundException, FileNotFoundError, OSError, ValueError):
        return _unavailable_image(node_id, image_index), None, embedded_bytes
    if file_size <= 0:
        return _unavailable_image(node_id, image_index), None, embedded_bytes

    image_result: dict[str, Any] = {
        "node_id": node_id,
        "image_index": image_index,
        "image_name": image_name,
        "status": "available",
        "image_url": _request_path(services.images.get_url(image_name), scope),
        "thumbnail_url": _request_path(services.images.get_url(image_name, thumbnail=True), scope),
        "width": record.width,
        "height": record.height,
        "embedded": False,
        "content_block_index": None,
    }
    remaining_bytes = MAX_EMBEDDED_IMAGE_BYTES - embedded_bytes
    if embedded_count >= MAX_EMBEDDED_IMAGES or file_size > remaining_bytes:
        return image_result, None, embedded_bytes

    try:
        with image_path.open("rb") as image_file:
            image_bytes = image_file.read(remaining_bytes + 1)
    except OSError:
        return _unavailable_image(node_id, image_index), None, embedded_bytes
    if len(image_bytes) > remaining_bytes:
        return image_result, None, embedded_bytes
    if len(image_bytes) != file_size:
        return _unavailable_image(node_id, image_index), None, embedded_bytes

    mime_type = mimetypes.guess_type(image_path.name)[0] or "image/png"
    image_content = ImageContent(data=base64.b64encode(image_bytes).decode("ascii"), mime_type=mime_type)
    image_result["embedded"] = True
    image_result["content_block_index"] = len(content)
    return image_result, image_content, embedded_bytes + len(image_bytes)


def _build_job_results(
    batch_id: str,
    item_ids: list[int],
    items: list[SessionQueueItem],
    user: Any,
    scope: Mapping[str, Any],
) -> CallToolResult:
    content: list[ImageContent] = []
    structured_items: list[dict[str, Any]] = []
    embedded_count = 0
    embedded_bytes = 0

    for item in items:
        entry = _item_status(item) | {"images": []}
        results = item.session.results
        for node_id, output in results.items():
            if not isinstance(node_id, str):
                continue
            for image_index, image_name in enumerate(_iter_image_names(output)):
                image_result, image_content, embedded_bytes = _append_image_result(
                    node_id=node_id,
                    image_index=image_index,
                    image_name=image_name,
                    user=user,
                    scope=scope,
                    content=content,
                    embedded_count=embedded_count,
                    embedded_bytes=embedded_bytes,
                )
                if image_result is None:
                    continue
                entry["images"].append(image_result)
                if image_content is not None:
                    content.append(image_content)
                    embedded_count += 1
        structured_items.append(entry)

    return CallToolResult(
        content=content,
        structured_content={"status": "available", "batch_id": batch_id, "items": structured_items},
    )


async def get_job_results(ctx: Context[Any, Request], batch_id: BatchId, item_ids: JobItemIds) -> CallToolResult:
    """Get final image outputs for the exact submitted items, embedding a bounded number of images."""
    token = require_mcp_user(ctx)
    items = await asyncio.to_thread(_get_job_items, batch_id, item_ids, token.user_id)
    if items is None:
        return CallToolResult(content=[], structured_content=_unavailable(batch_id, item_ids))
    scope = ctx.request_context.request.scope
    return await asyncio.to_thread(_build_job_results, batch_id, item_ids, items, token, scope)
