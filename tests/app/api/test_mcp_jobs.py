import asyncio
import base64
from pathlib import Path
from types import SimpleNamespace
from typing import Any

import pytest
from sqlalchemy import insert

from invokeai.app.api.dependencies import ApiDependencies
from invokeai.app.invocations.fields import ImageField
from invokeai.app.invocations.primitives import ImageOutput
from invokeai.app.services.auth.token_service import TokenData
from invokeai.app.services.image_records.image_records_common import ImageCategory, ResourceOrigin
from invokeai.app.services.session_queue.session_queue_common import DEFAULT_QUEUE_ID, Batch
from invokeai.app.services.session_queue.session_queue_default import SessionQueue
from invokeai.app.services.shared.database.database import Database
from invokeai.app.services.shared.database.schema.users import users
from invokeai.app.services.shared.graph import Graph
from invokeai.app.services.urls.urls_default import LocalUrlService
from invokeai.mcp.auth import MCP_USER_SCOPE_KEY


def _ctx(user_id: str, *, is_admin: bool = False, root_path: str = "") -> Any:
    token = TokenData(user_id=user_id, email=f"{user_id}@mcp.test", is_admin=is_admin)
    return SimpleNamespace(
        request_context=SimpleNamespace(
            request=SimpleNamespace(
                scope={
                    "state": {MCP_USER_SCOPE_KEY: token},
                    "root_path": root_path,
                    "headers": [(b"host", b"untrusted.example")],
                }
            )
        )
    )


def _call_tool(
    tool_name: str,
    args: dict[str, Any],
    *,
    user_id: str = "job-owner",
    is_admin: bool = False,
    root_path: str = "",
) -> Any:
    from invokeai.mcp.server import create_mcp_server

    return asyncio.run(
        create_mcp_server().call_tool(tool_name, args, context=_ctx(user_id, is_admin=is_admin, root_path=root_path))
    )


@pytest.fixture
def job_env(database: Database, mock_invoker: Any, monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> SimpleNamespace:
    with database.begin(write=True) as conn:
        conn.execute(
            insert(users),
            [
                {"user_id": "job-owner", "email": "job-owner@mcp.test", "password_hash": "test"},
                {"user_id": "other-user", "email": "other-user@mcp.test", "password_hash": "test"},
                {"user_id": "admin-user", "email": "admin-user@mcp.test", "password_hash": "test"},
            ],
        )

    queue = SessionQueue(database)
    queue.start(mock_invoker)
    mock_invoker.services.session_queue = queue
    mock_invoker.services.board_access.start(mock_invoker)

    image_paths: dict[str, Path] = {}
    mock_invoker.services.image_files = SimpleNamespace(
        get_path=lambda image_name, thumbnail=False, image_subfolder="": image_paths[image_name]
    )
    mock_invoker.services.urls = LocalUrlService()
    images = mock_invoker.services.images
    images.start(mock_invoker)
    monkeypatch.setattr(ApiDependencies, "invoker", mock_invoker, raising=False)

    return SimpleNamespace(queue=queue, invoker=mock_invoker, image_paths=image_paths, tmp_path=tmp_path)


def _enqueue(
    job_env: SimpleNamespace,
    *,
    user_id: str = "job-owner",
    queue_id: str = DEFAULT_QUEUE_ID,
    runs: int = 1,
) -> tuple[str, list[int]]:
    result = asyncio.run(
        job_env.queue.enqueue_batch(queue_id, Batch(graph=Graph(), runs=runs), prepend=False, user_id=user_id)
    )
    return result.batch.batch_id, result.item_ids


def _save_image(
    job_env: SimpleNamespace,
    image_name: str,
    data: bytes,
    *,
    user_id: str = "job-owner",
    is_intermediate: bool = False,
) -> None:
    job_env.invoker.services.image_records.save(
        image_name=image_name,
        image_origin=ResourceOrigin.INTERNAL,
        image_category=ImageCategory.GENERAL,
        width=8,
        height=8,
        has_workflow=True,
        is_intermediate=is_intermediate,
        user_id=user_id,
    )
    path = job_env.tmp_path / image_name
    path.write_bytes(data)
    job_env.image_paths[image_name] = path


def _set_results(job_env: SimpleNamespace, item_id: int, results: dict[str, Any]) -> None:
    item = job_env.queue.get_queue_item(item_id)
    item.session.results = results
    job_env.queue.set_queue_item_session(item_id, item.session)


def test_status_and_results_return_queue_state_and_final_image_content(job_env: SimpleNamespace) -> None:
    image_name = "final-output.png"
    image_bytes = b"final image bytes"
    intermediate_name = "intermediate-output.png"
    _save_image(job_env, image_name, image_bytes)
    _save_image(job_env, intermediate_name, b"temporary", is_intermediate=True)
    batch_id, item_ids = _enqueue(job_env, runs=4)
    first_item_id, failed_item_id, traceback_failed_item_id, safe_failed_item_id = item_ids

    _set_results(
        job_env,
        first_item_id,
        {
            "final-node": ImageOutput(image=ImageField(image_name=image_name), width=8, height=8),
            "intermediate-node": ImageOutput(image=ImageField(image_name=intermediate_name), width=8, height=8),
        },
    )
    job_env.queue.complete_queue_item(first_item_id)
    job_env.queue.fail_queue_item(
        failed_item_id,
        error_type="RuntimeError",
        error_message="FileNotFoundError: missing output at /mnt/AI/InvokeAI3/outputs/private.png",
        error_traceback="TRACEBACK_SECRET",
    )
    job_env.queue.fail_queue_item(
        traceback_failed_item_id,
        error_type="RuntimeError",
        error_message='Traceback (most recent call last): File "/mnt/InvokeAI/invoke.py", line 42, in invoke',
        error_traceback="TRACEBACK_SECRET",
    )
    job_env.queue.fail_queue_item(
        safe_failed_item_id,
        error_type="ValueError",
        error_message="Generation failed safely",
        error_traceback="TRACEBACK_SECRET",
    )

    arguments = {"batch_id": batch_id, "item_ids": item_ids}
    status_result = _call_tool("get_job_status", arguments).structured_content
    result = _call_tool("get_job_results", arguments)

    assert status_result == {
        "status": "available",
        "batch_id": batch_id,
        "items": [
            {"item_id": first_item_id, "status": "completed", "error_type": None, "error_message": None},
            {
                "item_id": failed_item_id,
                "status": "failed",
                "error_type": "RuntimeError",
                "error_message": "Job failed; detailed error omitted.",
            },
            {
                "item_id": traceback_failed_item_id,
                "status": "failed",
                "error_type": "RuntimeError",
                "error_message": "Job failed; detailed error omitted.",
            },
            {
                "item_id": safe_failed_item_id,
                "status": "failed",
                "error_type": "ValueError",
                "error_message": "Job failed; detailed error omitted.",
            },
        ],
    }
    structured = result.structured_content
    assert structured["status"] == "available"
    assert [item["status"] for item in structured["items"]] == ["completed", "failed", "failed", "failed"]
    images = structured["items"][0]["images"]
    assert len(images) == 1
    assert images[0] == {
        "node_id": "final-node",
        "image_index": 0,
        "image_name": image_name,
        "status": "available",
        "image_url": f"/api/v1/images/i/{image_name}/full",
        "thumbnail_url": f"/api/v1/images/i/{image_name}/thumbnail",
        "width": 8,
        "height": 8,
        "embedded": True,
        "content_block_index": 0,
    }
    assert structured["items"][1]["error_message"] == "Job failed; detailed error omitted."
    assert structured["items"][2]["error_message"] == "Job failed; detailed error omitted."
    assert structured["items"][3]["error_message"] == "Job failed; detailed error omitted."
    assert all("error_traceback" not in item for item in structured["items"])
    assert "TRACEBACK_SECRET" not in str(structured)
    assert "/mnt/AI/InvokeAI3/outputs/private.png" not in str(status_result)
    assert "/mnt/AI/InvokeAI3/outputs/private.png" not in str(structured)
    assert len(result.content) == 1
    assert base64.b64decode(result.content[0].data) == image_bytes


def test_status_and_results_replace_all_error_messages_with_safe_text(job_env: SimpleNamespace) -> None:
    batch_id, item_ids = _enqueue(job_env, runs=3)
    posix_item_id, windows_item_id, network_path_item_id = item_ids
    posix_path = "/srv/private/model.safetensors"
    windows_path = r"C:\Private\model.safetensors"
    network_path = "//srv/private/model.safetensors"
    job_env.queue.fail_queue_item(
        posix_item_id,
        error_type="RuntimeError",
        error_message=f"model_path={posix_path}",
        error_traceback=None,
    )
    job_env.queue.fail_queue_item(
        windows_item_id,
        error_type="RuntimeError",
        error_message=f"model_path:{windows_path}",
        error_traceback=None,
    )
    job_env.queue.fail_queue_item(
        network_path_item_id,
        error_type="RuntimeError",
        error_message=f"model_path={network_path}",
        error_traceback=None,
    )
    arguments = {"batch_id": batch_id, "item_ids": item_ids}

    for tool_name in ("get_job_status", "get_job_results"):
        result = _call_tool(tool_name, arguments)
        items = result.structured_content["items"]
        assert [item["status"] for item in items] == ["failed", "failed", "failed"]
        assert [item["error_type"] for item in items] == ["RuntimeError"] * 3
        assert [item["error_message"] for item in items] == ["Job failed; detailed error omitted."] * 3
        assert posix_path not in str(result.structured_content)
        assert windows_path not in str(result.structured_content)
        assert network_path not in str(result.structured_content)


def test_results_ignore_image_references_nested_in_metadata(job_env: SimpleNamespace) -> None:
    from invokeai.app.invocations.fields import MetadataField
    from invokeai.app.invocations.metadata import MetadataOutput
    from invokeai.app.invocations.primitives import ImageCollectionOutput
    from invokeai.app.invocations.workflow_return import WorkflowReturnOutput

    _save_image(job_env, "metadata-control.png", b"reference image")
    _save_image(job_env, "actual-output.png", b"final image")
    _save_image(job_env, "collection-output.png", b"collection image")
    _save_image(job_env, "returned-image.png", b"returned image")
    _save_image(job_env, "typed-output-image.png", b"typed output image")
    _save_image(job_env, "typed-collection-image.png", b"typed collection image")
    _save_image(job_env, "persisted-image.png", b"persisted image")
    _save_image(job_env, "persisted-collection-image.png", b"persisted collection image")
    batch_id, item_ids = _enqueue(job_env)
    _set_results(
        job_env,
        item_ids[0],
        {
            "metadata-node": MetadataOutput(
                metadata=MetadataField({"controlnets": [{"image": {"image_name": "metadata-control.png"}}]})
            ),
            "final-node": ImageOutput(image=ImageField(image_name="actual-output.png"), width=8, height=8),
            "collection-node": ImageCollectionOutput(collection=[ImageField(image_name="collection-output.png")]),
            "workflow-return-node": WorkflowReturnOutput(
                values={
                    "image": ImageField(image_name="returned-image.png"),
                    "typed-output": ImageOutput(
                        image=ImageField(image_name="typed-output-image.png"), width=8, height=8
                    ),
                    "typed-collection": ImageCollectionOutput(
                        collection=[ImageField(image_name="typed-collection-image.png")]
                    ),
                    "persisted-image": {"image_name": "persisted-image.png"},
                    "persisted-collection": [{"image_name": "persisted-collection-image.png"}],
                    "metadata": {"controlnets": [{"image": {"image_name": "metadata-control.png"}}]},
                }
            ),
        },
    )
    job_env.queue.complete_queue_item(item_ids[0])

    result = _call_tool("get_job_results", {"batch_id": batch_id, "item_ids": item_ids})
    images = result.structured_content["items"][0]["images"]

    assert [image["node_id"] for image in images] == [
        "final-node",
        "collection-node",
        "workflow-return-node",
        "workflow-return-node",
        "workflow-return-node",
        "workflow-return-node",
        "workflow-return-node",
    ]
    assert [image["image_name"] for image in images] == [
        "actual-output.png",
        "collection-output.png",
        "returned-image.png",
        "typed-output-image.png",
        "typed-collection-image.png",
        "persisted-image.png",
        "persisted-collection-image.png",
    ]


def test_result_urls_include_asgi_root_path_without_using_host(job_env: SimpleNamespace) -> None:
    _save_image(job_env, "proxy-output.png", b"image bytes")
    batch_id, item_ids = _enqueue(job_env)
    _set_results(
        job_env,
        item_ids[0],
        {"final-node": ImageOutput(image=ImageField(image_name="proxy-output.png"), width=8, height=8)},
    )
    job_env.queue.complete_queue_item(item_ids[0])
    arguments = {"batch_id": batch_id, "item_ids": item_ids}

    proxied = _call_tool("get_job_results", arguments, root_path="/invoke")
    unprefixed = _call_tool("get_job_results", arguments)

    proxied_image = proxied.structured_content["items"][0]["images"][0]
    root_image = unprefixed.structured_content["items"][0]["images"][0]
    assert proxied_image["image_url"] == "/invoke/api/v1/images/i/proxy-output.png/full"
    assert proxied_image["thumbnail_url"] == "/invoke/api/v1/images/i/proxy-output.png/thumbnail"
    assert root_image["image_url"] == "/api/v1/images/i/proxy-output.png/full"
    assert "untrusted.example" not in str(proxied.structured_content)


def test_results_retry_during_image_move_maintenance_but_status_remains_available(
    job_env: SimpleNamespace,
) -> None:
    from mcp.server.mcpserver.exceptions import ToolError

    _save_image(job_env, "maintenance-output.png", b"image bytes")
    batch_id, item_ids = _enqueue(job_env)
    _set_results(
        job_env,
        item_ids[0],
        {"final-node": ImageOutput(image=ImageField(image_name="maintenance-output.png"), width=8, height=8)},
    )
    job_env.queue.complete_queue_item(item_ids[0])
    job_env.invoker.services.image_moves = SimpleNamespace(is_maintenance_active=lambda: True)
    arguments = {"batch_id": batch_id, "item_ids": item_ids}

    status = _call_tool("get_job_status", arguments)

    assert status.structured_content["status"] == "available"
    assert status.structured_content["items"][0]["status"] == "completed"
    with pytest.raises(ToolError, match="Image storage maintenance is active"):
        _call_tool("get_job_results", arguments)


def test_status_and_results_hide_foreign_mismatched_and_pruned_items(job_env: SimpleNamespace) -> None:
    owned_batch_id, owned_ids = _enqueue(job_env, runs=2)
    foreign_batch_id, foreign_ids = _enqueue(job_env, user_id="other-user")
    other_queue_batch_id, other_queue_ids = _enqueue(job_env, queue_id="other-queue")
    pruned_batch_id, pruned_ids = _enqueue(job_env)
    job_env.queue.complete_queue_item(pruned_ids[0])
    job_env.queue.prune(DEFAULT_QUEUE_ID, user_id="job-owner")

    requests = [
        (owned_batch_id, [foreign_ids[0]], "job-owner", False),
        (owned_batch_id, [*owned_ids[:1], foreign_ids[0]], "job-owner", True),
        (owned_batch_id, [owned_ids[0]], "admin-user", True),
        (owned_batch_id, [foreign_ids[0]], "admin-user", True),
        (owned_batch_id, [999999999], "job-owner", False),
        (owned_batch_id, [other_queue_ids[0]], "job-owner", False),
        (owned_batch_id, [pruned_ids[0]], "job-owner", False),
        (foreign_batch_id, [owned_ids[0]], "job-owner", False),
        (other_queue_batch_id, [other_queue_ids[0]], "job-owner", False),
    ]

    for batch_id, item_ids, user_id, is_admin in requests:
        for tool_name in ("get_job_status", "get_job_results"):
            result = _call_tool(
                tool_name,
                {"batch_id": batch_id, "item_ids": item_ids},
                user_id=user_id,
                is_admin=is_admin,
            )
            structured = result.structured_content
            assert structured == {"status": "unavailable", "batch_id": batch_id, "item_ids": item_ids}
            assert "items" not in structured
            if tool_name == "get_job_results":
                assert result.content == []


def test_results_mark_deleted_and_unreadable_images_unavailable_but_keep_other_outputs(
    job_env: SimpleNamespace,
) -> None:
    _save_image(job_env, "good.png", b"good")
    _save_image(job_env, "missing-file.png", b"gone")
    _save_image(job_env, "missing-record.png", b"gone")
    _save_image(job_env, "intermediate.png", b"temporary", is_intermediate=True)
    _save_image(job_env, "foreign.png", b"private", user_id="other-user")
    job_env.image_paths["missing-file.png"].unlink()
    job_env.invoker.services.image_records.delete("missing-record.png")

    batch_id, item_ids = _enqueue(job_env)
    item_id = item_ids[0]
    _set_results(
        job_env,
        item_id,
        {
            "good-node": ImageOutput(image=ImageField(image_name="good.png"), width=8, height=8),
            "file-node": ImageOutput(image=ImageField(image_name="missing-file.png"), width=8, height=8),
            "record-node": ImageOutput(image=ImageField(image_name="missing-record.png"), width=8, height=8),
            "intermediate-node": ImageOutput(image=ImageField(image_name="intermediate.png"), width=8, height=8),
            "foreign-node": ImageOutput(image=ImageField(image_name="foreign.png"), width=8, height=8),
        },
    )
    job_env.queue.complete_queue_item(item_id)

    result = _call_tool("get_job_results", {"batch_id": batch_id, "item_ids": item_ids})
    images = result.structured_content["items"][0]["images"]

    assert [(image["node_id"], image["status"]) for image in images] == [
        ("good-node", "available"),
        ("file-node", "unavailable"),
        ("record-node", "unavailable"),
        ("foreign-node", "unavailable"),
    ]
    assert "image_name" not in images[1]
    assert "image_url" not in images[1]
    assert "foreign.png" not in str(result.structured_content)
    assert len(result.content) == 1


def test_results_embed_at_most_four_images_and_keep_urls_for_the_rest(job_env: SimpleNamespace) -> None:
    names = [f"image-{index}.png" for index in range(5)]
    for name in names:
        _save_image(job_env, name, name.encode())
    batch_id, item_ids = _enqueue(job_env)
    _set_results(
        job_env,
        item_ids[0],
        {
            f"node-{index}": ImageOutput(image=ImageField(image_name=name), width=8, height=8)
            for index, name in enumerate(names)
        },
    )
    job_env.queue.complete_queue_item(item_ids[0])

    result = _call_tool("get_job_results", {"batch_id": batch_id, "item_ids": item_ids})
    images = result.structured_content["items"][0]["images"]

    assert sum(image["embedded"] for image in images) == 4
    assert len(result.content) == 4
    assert images[-1]["image_url"] == "/api/v1/images/i/image-4.png/full"
    assert images[-1]["embedded"] is False
    assert images[-1]["content_block_index"] is None


def test_results_enforce_raw_byte_limit_at_boundary_and_for_oversized_images(job_env: SimpleNamespace) -> None:
    from invokeai.mcp.jobs import MAX_EMBEDDED_IMAGE_BYTES

    boundary_name = "boundary.png"
    extra_name = "extra.png"
    oversized_name = "oversized.png"
    _save_image(job_env, boundary_name, b"b" * MAX_EMBEDDED_IMAGE_BYTES)
    _save_image(job_env, extra_name, b"x")
    _save_image(job_env, oversized_name, b"o" * (MAX_EMBEDDED_IMAGE_BYTES + 1))
    batch_id, item_ids = _enqueue(job_env, runs=2)
    _set_results(
        job_env,
        item_ids[0],
        {
            "boundary-node": ImageOutput(image=ImageField(image_name=boundary_name), width=8, height=8),
            "extra-node": ImageOutput(image=ImageField(image_name=extra_name), width=8, height=8),
        },
    )
    _set_results(
        job_env,
        item_ids[1],
        {"oversized-node": ImageOutput(image=ImageField(image_name=oversized_name), width=8, height=8)},
    )
    job_env.queue.complete_queue_item(item_ids[0])
    job_env.queue.complete_queue_item(item_ids[1])

    result = _call_tool("get_job_results", {"batch_id": batch_id, "item_ids": item_ids})
    first_images, second_images = [item["images"] for item in result.structured_content["items"]]

    assert first_images[0]["embedded"] is True
    content_index = first_images[0]["content_block_index"]
    assert len(base64.b64decode(result.content[content_index].data)) == MAX_EMBEDDED_IMAGE_BYTES
    assert first_images[1]["embedded"] is False
    assert second_images[0]["embedded"] is False
    assert second_images[0]["image_url"] == f"/api/v1/images/i/{oversized_name}/full"


def test_job_tools_are_registered(monkeypatch):
    from invokeai.mcp.server import create_mcp_server

    monkeypatch.setattr(ApiDependencies, "invoker", object(), raising=False)
    tools = asyncio.run(create_mcp_server().list_tools())

    tools_by_name = {tool.name: tool for tool in tools}
    assert {"get_job_status", "get_job_results"}.issubset(tools_by_name)
    for name in ("get_job_status", "get_job_results"):
        assert {"batch_id", "item_ids"}.issubset(tools_by_name[name].input_schema["required"])
