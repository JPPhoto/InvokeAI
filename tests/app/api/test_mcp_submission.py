import asyncio
import hashlib
import json
from types import SimpleNamespace
from typing import Any

import pytest
from mcp.server.mcpserver.exceptions import ToolError, UnexpectedToolError
from pydantic import ValidationError
from sqlalchemy import insert, select

from invokeai.app.api.dependencies import ApiDependencies
from invokeai.app.services.auth.token_service import TokenData
from invokeai.app.services.session_queue.session_queue_common import (
    DEFAULT_QUEUE_ID,
    Batch,
    EnqueueBatchReceipt,
    EnqueueBatchResult,
    EnqueueIdempotencyConflictError,
    EnqueueReceiptLimitError,
    TooManySessionsError,
)
from invokeai.app.services.session_queue.session_queue_default import SessionQueue
from invokeai.app.services.shared.database.database import Database
from invokeai.app.services.shared.database.schema.session_queue import session_queue_enqueue_receipts
from invokeai.app.services.shared.database.schema.users import users
from invokeai.app.services.shared.graph import Graph
from invokeai.app.services.workflow_records.workflow_records_common import (
    WorkflowCategory,
    WorkflowMeta,
    WorkflowWithoutID,
)
from invokeai.mcp.auth import MCP_USER_SCOPE_KEY


def _ctx(user_id: str, *, is_admin: bool = False) -> Any:
    token = TokenData(user_id=user_id, email=f"{user_id}@mcp.test", is_admin=is_admin)
    return SimpleNamespace(
        request_context=SimpleNamespace(request=SimpleNamespace(scope={"state": {MCP_USER_SCOPE_KEY: token}}))
    )


def _workflow_node(node_id: str, node_type: str, inputs: dict[str, Any]) -> dict[str, Any]:
    return {
        "id": node_id,
        "type": "invocation",
        "position": {"x": 0, "y": 0},
        "data": {
            "id": node_id,
            "type": node_type,
            "version": "1.0.0",
            "nodePack": "invokeai",
            "label": "",
            "notes": "",
            "isOpen": True,
            "isIntermediate": False,
            "useCache": True,
            "dynamicInputTemplates": {},
            "inputs": inputs,
        },
    }


def _submission_workflow(
    *,
    nodes: list[dict[str, Any]] | None = None,
    edges: list[dict[str, Any]] | None = None,
    exposed_fields: list[dict[str, str]] | None = None,
    category: WorkflowCategory = WorkflowCategory.User,
) -> WorkflowWithoutID:
    return WorkflowWithoutID(
        name="Submission workflow",
        author="",
        description="",
        version="1.0.0",
        contact="",
        tags="",
        notes="",
        exposedFields=exposed_fields or [],
        meta=WorkflowMeta(version="3.0.0", category=category),
        nodes=nodes or [_workflow_node("add-1", "add", {"a": {"value": 2}, "b": {"value": 3}})],
        edges=edges or [],
        form=None,
    )


def _seed_workflow(seed_mode: str | None, seed: int = 42, *, exposed: bool = True) -> WorkflowWithoutID:
    seed_input = {"value": seed, **({"seedMode": seed_mode} if seed_mode is not None else {})}
    return _submission_workflow(
        nodes=[_workflow_node("noise-1", "noise", {"seed": seed_input})],
        exposed_fields=[{"nodeId": "noise-1", "fieldName": "seed"}] if exposed else [],
    )


def _configure_submission(
    monkeypatch: pytest.MonkeyPatch,
    workflow: WorkflowWithoutID | None = None,
    *,
    revision: int = 4,
    user_id: str = "workflow-owner",
    is_public: bool = True,
    queue_enqueued: int = 1,
    queue_error: Exception | None = None,
) -> Any:
    record = SimpleNamespace(
        workflow_id="workflow-id",
        revision=revision,
        user_id=user_id,
        is_public=is_public,
        workflow=workflow or _submission_workflow(),
    )
    events: list[str] = []
    receipt_calls: list[dict[str, Any]] = []
    queue_calls: list[dict[str, Any]] = []
    workflow_reads: list[str] = []
    receipts: dict[tuple[str, str, str], tuple[str, EnqueueBatchReceipt]] = {}

    def get_enqueue_receipt(
        *, queue_id: str, idempotency_key: str, user_id: str, request_fingerprint: str
    ) -> EnqueueBatchReceipt | None:
        events.append("receipt")
        call = {
            "queue_id": queue_id,
            "idempotency_key": idempotency_key,
            "user_id": user_id,
            "request_fingerprint": request_fingerprint,
        }
        receipt_calls.append(call)
        stored = receipts.get((queue_id, user_id, idempotency_key))
        if stored is None:
            return None
        if stored[0] != request_fingerprint:
            raise EnqueueIdempotencyConflictError("fingerprint mismatch")
        return stored[1]

    async def enqueue_batch(
        queue_id: str,
        batch: Batch,
        prepend: bool,
        user_id: str,
        *,
        request_fingerprint: str,
    ) -> EnqueueBatchResult:
        events.append("enqueue")
        queue_calls.append(
            {
                "queue_id": queue_id,
                "batch": batch,
                "prepend": prepend,
                "user_id": user_id,
                "request_fingerprint": request_fingerprint,
            }
        )
        if queue_error is not None:
            raise queue_error
        item_ids = [100 + len(queue_calls) + i for i in range(queue_enqueued)]
        result = EnqueueBatchResult(
            queue_id=queue_id,
            enqueued=queue_enqueued,
            requested=1,
            batch=batch,
            priority=0,
            item_ids=item_ids,
        )
        if queue_enqueued:
            receipts[(queue_id, user_id, batch.idempotency_key or "")] = (
                request_fingerprint,
                EnqueueBatchReceipt(
                    batch_id=batch.batch_id,
                    requested=1,
                    enqueued=queue_enqueued,
                    item_ids=item_ids,
                ),
            )
        return result

    def get_workflow(requested_workflow_id: str) -> Any:
        events.append("workflow")
        workflow_reads.append(requested_workflow_id)
        return record

    queue = SimpleNamespace(get_enqueue_receipt=get_enqueue_receipt, enqueue_batch=enqueue_batch)
    records = SimpleNamespace(get=get_workflow)
    image_moves = SimpleNamespace(is_maintenance_active=lambda: False)
    invoker = SimpleNamespace(
        services=SimpleNamespace(session_queue=queue, workflow_records=records, image_moves=image_moves)
    )
    monkeypatch.setattr(ApiDependencies, "invoker", invoker, raising=False)
    return SimpleNamespace(
        record=record,
        image_moves=image_moves,
        events=events,
        receipt_calls=receipt_calls,
        queue_calls=queue_calls,
        workflow_reads=workflow_reads,
        receipts=receipts,
    )


def _call_submit(
    *,
    ctx: Any | None = None,
    workflow_id: str = "workflow-id",
    revision: int = 4,
    idempotency_key: str = "mcp-submit-key",
    parameters: dict[str, Any] | None = None,
) -> Any:
    from invokeai.mcp.submission import submit_workflow

    return asyncio.run(
        submit_workflow(
            ctx=ctx or _ctx("submission-owner"),
            workflow_id=workflow_id,
            revision=revision,
            idempotency_key=idempotency_key,
            parameters={} if parameters is None else parameters,
        )
    )


def _server_with_queue_spy(monkeypatch: pytest.MonkeyPatch) -> tuple[Any, list[dict[str, Any]]]:
    from invokeai.mcp.server import create_mcp_server

    calls: list[dict[str, Any]] = []
    queue = SimpleNamespace(acknowledge_enqueue=lambda **kwargs: calls.append(kwargs))
    invoker = SimpleNamespace(services=SimpleNamespace(session_queue=queue))
    monkeypatch.setattr(ApiDependencies, "invoker", invoker, raising=False)
    return create_mcp_server(), calls


@pytest.mark.timeout(15)
def test_submit_workflow_accepts_a_valid_request_through_registered_tool(monkeypatch: pytest.MonkeyPatch) -> None:
    from invokeai.mcp.server import create_mcp_server

    harness = _configure_submission(monkeypatch)

    result = asyncio.run(
        create_mcp_server().call_tool(
            "submit_workflow",
            {
                "workflow_id": "workflow-id",
                "revision": 4,
                "parameters": {},
                "idempotency_key": "mcp-submit-key",
            },
            context=_ctx("submission-owner"),
        )
    )

    accepted = result.structured_content
    batch = harness.queue_calls[0]["batch"]
    assert accepted == {
        "status": "accepted",
        "batch_id": batch.batch_id,
        "item_ids": [101],
        "requested": 1,
        "enqueued": 1,
    }
    assert harness.events == ["receipt", "workflow", "enqueue"]
    assert harness.receipt_calls[0]["user_id"] == "submission-owner"
    assert harness.queue_calls[0]["queue_id"] == DEFAULT_QUEUE_ID
    assert harness.queue_calls[0]["user_id"] == "submission-owner"
    assert batch.runs == 1
    assert batch.data is None
    assert batch.idempotency_key == "mcp-submit-key"
    assert batch.workflow is not harness.record.workflow
    assert harness.queue_calls[0]["prepend"] is False


def test_described_schema_default_replaces_invalid_saved_value_when_omitted(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    from invokeai.mcp.catalog import describe_workflow

    workflow = _submission_workflow(
        nodes=[_workflow_node("noise-1", "noise", {"seed": {"value": -1}})],
        exposed_fields=[{"nodeId": "noise-1", "fieldName": "seed"}],
    )
    harness = _configure_submission(monkeypatch, workflow)

    description = describe_workflow(ctx=_ctx("submission-owner"), workflow_id="workflow-id")
    seed_parameter = description["parameters"][0]
    assert seed_parameter["input_schema"]["default"] == 0

    _call_submit()

    assert harness.queue_calls[0]["batch"].graph.nodes["noise-1"].seed == seed_parameter["input_schema"]["default"]


def test_submit_workflow_schema_requires_identity_revision_and_bounded_key(monkeypatch: pytest.MonkeyPatch) -> None:
    server, _ = _server_with_queue_spy(monkeypatch)
    tool = next(tool for tool in asyncio.run(server.list_tools()) if tool.name == "submit_workflow")
    schema = tool.input_schema
    properties = schema["properties"]

    assert {"workflow_id", "revision", "parameters", "idempotency_key"}.issubset(schema["required"])
    assert properties["revision"]["type"] == "integer"
    assert properties["revision"]["exclusiveMinimum"] == 0
    assert properties["parameters"]["type"] == "object"
    assert properties["idempotency_key"]["minLength"] == 1
    assert properties["idempotency_key"]["maxLength"] == 255


@pytest.mark.parametrize("revision", [True, 0, -1])
def test_submit_workflow_schema_rejects_bool_and_nonpositive_revision(
    monkeypatch: pytest.MonkeyPatch, revision: Any
) -> None:
    server, _ = _server_with_queue_spy(monkeypatch)

    with pytest.raises(ToolError) as exc_info:
        asyncio.run(
            server.call_tool(
                "submit_workflow",
                {
                    "workflow_id": "workflow-id",
                    "revision": revision,
                    "parameters": {},
                    "idempotency_key": "submission-key",
                },
                context=_ctx("submission-owner"),
            )
        )
    assert isinstance(exc_info.value.__cause__, ValidationError)


@pytest.mark.parametrize(
    ("parameters", "message"),
    [
        ({"add-1::b": 4}, "Unknown workflow parameter"),
        ({"add-1::a": True}, "Invalid value for workflow parameter"),
    ],
)
def test_submit_workflow_rejects_unknown_or_invalid_exposed_parameters_before_enqueue(
    monkeypatch: pytest.MonkeyPatch, parameters: dict[str, Any], message: str
) -> None:
    workflow = _submission_workflow(exposed_fields=[{"nodeId": "add-1", "fieldName": "a"}])
    harness = _configure_submission(monkeypatch, workflow)

    with pytest.raises(ToolError, match=message):
        _call_submit(parameters=parameters)

    assert harness.events == ["receipt", "workflow"]
    assert harness.queue_calls == []


def test_submit_workflow_replays_receipt_before_edited_or_unpublished_workflow_lookup(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    workflow = _submission_workflow(
        exposed_fields=[{"nodeId": "add-1", "fieldName": "a"}, {"nodeId": "add-1", "fieldName": "b"}]
    )
    harness = _configure_submission(monkeypatch, workflow)
    parameters = {"add-1::a": 6, "add-1::b": 7}
    first = _call_submit(parameters=parameters)
    harness.record.revision = 5
    harness.record.is_public = False
    replay = _call_submit(parameters={"add-1::b": 7, "add-1::a": 6})

    assert replay == first
    assert harness.workflow_reads == ["workflow-id"]
    assert harness.receipt_calls[0]["request_fingerprint"] == harness.receipt_calls[1]["request_fingerprint"]
    assert harness.events == ["receipt", "workflow", "enqueue", "receipt"]
    expected_fingerprint = hashlib.sha256(
        json.dumps(
            {"workflow_id": "workflow-id", "revision": 4, "parameters": parameters},
            ensure_ascii=False,
            separators=(",", ":"),
            sort_keys=True,
            allow_nan=False,
        ).encode("utf-8")
    ).hexdigest()
    assert harness.receipt_calls[0]["request_fingerprint"] == expected_fingerprint
    assert len(harness.queue_calls) == 1


def test_submit_workflow_blocks_new_admission_during_image_move_maintenance(monkeypatch: pytest.MonkeyPatch) -> None:
    harness = _configure_submission(monkeypatch)
    harness.image_moves.is_maintenance_active = lambda: True

    with pytest.raises(ToolError, match="Image storage maintenance is active"):
        _call_submit()

    assert harness.events == ["receipt", "workflow"]
    assert harness.queue_calls == []
    assert harness.receipts == {}


def test_submit_workflow_replays_accepted_receipt_during_image_move_maintenance(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    harness = _configure_submission(monkeypatch)
    first = _call_submit()
    harness.image_moves.is_maintenance_active = lambda: True

    replay = _call_submit()

    assert replay == first
    assert harness.events == ["receipt", "workflow", "enqueue", "receipt"]
    assert len(harness.queue_calls) == 1


def test_submit_workflow_rejects_nonfinite_parameter_values_before_receipt_lookup(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    harness = _configure_submission(monkeypatch)

    with pytest.raises(ToolError, match="finite JSON values"):
        _call_submit(parameters={"add-1::a": float("nan")})

    assert harness.events == []


def test_submit_workflow_conflicting_key_fails_before_workflow_lookup(monkeypatch: pytest.MonkeyPatch) -> None:
    workflow = _submission_workflow(exposed_fields=[{"nodeId": "add-1", "fieldName": "a"}])
    harness = _configure_submission(monkeypatch, workflow)
    _call_submit(parameters={"add-1::a": 6})
    assert harness.record.workflow.nodes[0]["data"]["inputs"]["a"]["value"] == 2

    with pytest.raises(ToolError, match="different request"):
        _call_submit(parameters={"add-1::a": 7})

    assert harness.workflow_reads == ["workflow-id"]
    assert harness.events == ["receipt", "workflow", "enqueue", "receipt"]
    assert len(harness.queue_calls) == 1


@pytest.mark.parametrize(
    ("request_user", "is_admin", "workflow_user"),
    [
        ("workflow-owner", False, "workflow-owner"),
        ("admin", True, "workflow-owner"),
        ("submission-owner", False, "system"),
    ],
)
def test_submit_workflow_denies_private_workflows_even_to_owner_or_admin(
    monkeypatch: pytest.MonkeyPatch, request_user: str, is_admin: bool, workflow_user: str
) -> None:
    harness = _configure_submission(monkeypatch, is_public=False, user_id=workflow_user)

    with pytest.raises(ToolError, match="not available"):
        _call_submit(ctx=_ctx(request_user, is_admin=is_admin))

    assert harness.events == ["receipt", "workflow"]
    assert harness.queue_calls == []


@pytest.mark.parametrize(
    ("category", "workflow_user", "is_public"),
    [
        (WorkflowCategory.Default, "private-owner", False),
        (WorkflowCategory.User, "workflow-owner", True),
    ],
)
def test_submit_workflow_allows_default_private_or_public_user_workflows(
    monkeypatch: pytest.MonkeyPatch, category: WorkflowCategory, workflow_user: str, is_public: bool
) -> None:
    workflow = _submission_workflow(category=category)
    harness = _configure_submission(monkeypatch, workflow, user_id=workflow_user, is_public=is_public)

    result = _call_submit()

    assert result["status"] == "accepted"
    assert harness.queue_calls[0]["user_id"] == "submission-owner"


def test_submit_workflow_rejects_stale_revision_before_enqueue(monkeypatch: pytest.MonkeyPatch) -> None:
    harness = _configure_submission(monkeypatch, revision=5)

    with pytest.raises(ToolError, match="revision is stale"):
        _call_submit(revision=4)

    assert harness.events == ["receipt", "workflow"]
    assert harness.queue_calls == []


@pytest.mark.parametrize(
    ("node_type", "inputs"),
    [
        ("range", {"start": {"value": 1}, "stop": {"value": 4}, "step": {"value": 1}}),
        (
            "random_range",
            {"low": {"value": 1}, "high": {"value": 8}, "size": {"value": 2}, "seed": {"value": 5}},
        ),
    ],
)
def test_submit_workflow_accepts_collection_invocations_through_registered_tool(
    monkeypatch: pytest.MonkeyPatch, node_type: str, inputs: dict[str, Any]
) -> None:
    from invokeai.mcp.server import create_mcp_server

    workflow = _submission_workflow(nodes=[_workflow_node(f"{node_type}-1", node_type, inputs)])
    harness = _configure_submission(monkeypatch, workflow)

    result = asyncio.run(
        create_mcp_server().call_tool(
            "submit_workflow",
            {
                "workflow_id": "workflow-id",
                "revision": 4,
                "parameters": {},
                "idempotency_key": "mcp-collection-key",
            },
            context=_ctx("submission-owner"),
        )
    )

    accepted = result.structured_content
    batch = harness.queue_calls[0]["batch"]
    assert accepted["status"] == "accepted"
    assert batch.runs == 1
    assert batch.data is None
    assert set(batch.graph.nodes) == {f"{node_type}-1"}
    assert batch.graph.nodes[f"{node_type}-1"].get_type() == node_type


@pytest.mark.parametrize(
    "node",
    [
        _workflow_node("image-batch-1", "image_batch", {}),
        _workflow_node(
            "string-generator-1",
            "string_generator",
            {"generator": {"value": {"type": "string_generator_dynamic_prompts_random", "input": "{a|b}"}}},
        ),
        _workflow_node(
            "image-generator-1",
            "image_generator",
            {"generator": {"value": {"type": "image_generator_images_from_board", "board_id": "board-id"}}},
        ),
        _workflow_node("custom-generator-1", "async_prompt_generator", {}),
    ],
    ids=["disconnected-special-batch", "dynamic-prompt-generator", "board-image-generator", "async-generator"],
)
def test_submit_workflow_rejects_batch_and_generator_nodes_before_enqueue(
    monkeypatch: pytest.MonkeyPatch, node: dict[str, Any]
) -> None:
    harness = _configure_submission(monkeypatch, _submission_workflow(nodes=[node]))

    with pytest.raises(ToolError, match="Batch and generator nodes"):
        _call_submit()

    assert harness.events == ["receipt", "workflow"]
    assert harness.queue_calls == []


@pytest.mark.parametrize(
    ("mode", "parameters", "expected_seed", "draw_expected"),
    [
        (None, {}, 42, False),
        ("fixed", {"noise-1::seed": 73}, 73, False),
        ("random", {"noise-1::seed": 73}, 73, False),
    ],
)
def test_submit_workflow_uses_fixed_and_explicit_random_seed_values(
    monkeypatch: pytest.MonkeyPatch,
    mode: str | None,
    parameters: dict[str, Any],
    expected_seed: int,
    draw_expected: bool,
) -> None:
    from invokeai.mcp import submission

    harness = _configure_submission(monkeypatch, _seed_workflow(mode))
    draws: list[int] = []

    def draw_seed(upper: int) -> int:
        draws.append(upper)
        return 19

    monkeypatch.setattr(submission.secrets, "randbelow", draw_seed)
    _call_submit(parameters=parameters)

    graph_seed = harness.queue_calls[0]["batch"].graph.nodes["noise-1"].seed
    assert graph_seed == expected_seed
    assert bool(draws) is draw_expected


def test_submit_workflow_draws_random_seed_once_and_replays_without_redrawing(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    from invokeai.mcp import submission

    harness = _configure_submission(monkeypatch, _seed_workflow("random"))
    draws: list[int] = []

    def draw_seed(upper: int) -> int:
        draws.append(upper)
        return 123456

    monkeypatch.setattr(submission.secrets, "randbelow", draw_seed)
    first = _call_submit()
    harness.record.revision = 5
    harness.record.is_public = False
    replay = _call_submit()

    assert first == replay
    assert harness.queue_calls[0]["batch"].graph.nodes["noise-1"].seed == 123456
    assert draws == [4294967296]
    assert harness.workflow_reads == ["workflow-id"]
    assert len(harness.queue_calls) == 1


def test_submit_workflow_honors_random_seed_mode_when_seed_is_not_exposed(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    from invokeai.mcp import submission

    harness = _configure_submission(monkeypatch, _seed_workflow("random", exposed=False))
    monkeypatch.setattr(submission.secrets, "randbelow", lambda _upper: 2468)

    _call_submit()

    assert harness.queue_calls[0]["batch"].graph.nodes["noise-1"].seed == 2468


def test_submit_workflow_keeps_connected_seed_graph_driven(monkeypatch: pytest.MonkeyPatch) -> None:
    workflow = _submission_workflow(
        nodes=[
            _workflow_node("seed-source", "integer", {"value": {"value": 81}}),
            _workflow_node("noise-1", "noise", {"seed": {"value": 42, "seedMode": "increment"}}),
        ],
        edges=[
            {
                "id": "seed-edge",
                "type": "default",
                "source": "seed-source",
                "sourceHandle": "value",
                "target": "noise-1",
                "targetHandle": "seed",
            }
        ],
        exposed_fields=[{"nodeId": "noise-1", "fieldName": "seed"}],
    )
    harness = _configure_submission(monkeypatch, workflow)

    with pytest.raises(ToolError, match="Unknown workflow parameter"):
        _call_submit(parameters={"noise-1::seed": 17})

    _call_submit()

    batch = harness.queue_calls[0]["batch"]
    assert [(edge.source.node_id, edge.destination.node_id, edge.destination.field) for edge in batch.graph.edges] == [
        ("seed-source", "noise-1", "seed")
    ]


@pytest.mark.parametrize(
    ("mode", "parameters"),
    [
        ("increment", {}),
        ("decrement", {}),
        ("increment", {"noise-1::seed": 3}),
        ("decrement", {"noise-1::seed": 3}),
    ],
)
def test_submit_workflow_rejects_advancing_seed_modes_before_enqueue(
    monkeypatch: pytest.MonkeyPatch, mode: str, parameters: dict[str, Any]
) -> None:
    harness = _configure_submission(monkeypatch, _seed_workflow(mode))

    with pytest.raises(ToolError, match="Increment and decrement seed modes"):
        _call_submit(parameters=parameters)

    assert harness.events == ["receipt", "workflow"]
    assert harness.queue_calls == []


def test_submit_workflow_rejects_advancing_seed_mode_when_seed_is_not_exposed(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    harness = _configure_submission(monkeypatch, _seed_workflow("increment", exposed=False))

    with pytest.raises(ToolError, match="Increment and decrement seed modes"):
        _call_submit()

    assert harness.events == ["receipt", "workflow"]
    assert harness.queue_calls == []


def test_submit_workflow_leaves_zero_item_queue_admission_retryable(monkeypatch: pytest.MonkeyPatch) -> None:
    harness = _configure_submission(monkeypatch, queue_enqueued=0)

    for _ in range(2):
        with pytest.raises(ToolError, match="queue is full; retry"):
            _call_submit()

    assert harness.events == ["receipt", "workflow", "enqueue", "receipt", "workflow", "enqueue"]
    assert harness.receipts == {}


@pytest.mark.parametrize("queue_error", [EnqueueReceiptLimitError("limit"), TooManySessionsError("too many")])
def test_submit_workflow_translates_queue_admission_errors_safely(
    monkeypatch: pytest.MonkeyPatch, queue_error: Exception
) -> None:
    harness = _configure_submission(monkeypatch, queue_error=queue_error)

    with pytest.raises(ToolError, match="queue cannot accept this submission") as exc_info:
        _call_submit()

    assert not isinstance(exc_info.value, UnexpectedToolError)
    assert harness.events == ["receipt", "workflow", "enqueue"]
    assert harness.receipts == {}


@pytest.mark.timeout(15)
def test_submit_workflow_receipts_are_caller_scoped_with_real_sqlite(
    database: Database, mock_invoker: Any, monkeypatch: pytest.MonkeyPatch
) -> None:
    with database.begin(write=True) as conn:
        conn.execute(
            insert(users),
            [
                {"user_id": "submission-owner", "email": "owner@mcp.test", "password_hash": "test"},
                {"user_id": "submission-other", "email": "other@mcp.test", "password_hash": "test"},
            ],
        )

    queue = SessionQueue(database)
    queue.start(mock_invoker)
    mock_invoker.services.session_queue = queue
    record = SimpleNamespace(
        workflow_id="workflow-id",
        revision=4,
        user_id="workflow-owner",
        is_public=True,
        workflow=_submission_workflow(),
    )
    workflow_reads: list[str] = []

    def get_workflow(workflow_id: str) -> Any:
        workflow_reads.append(workflow_id)
        return record

    mock_invoker.services.workflow_records = SimpleNamespace(get=get_workflow)
    monkeypatch.setattr(ApiDependencies, "invoker", mock_invoker, raising=False)

    first = _call_submit(idempotency_key="caller-scoped-key")
    other_user = _call_submit(ctx=_ctx("submission-other"), idempotency_key="caller-scoped-key")
    retry = _call_submit(idempotency_key="caller-scoped-key")

    assert first == retry
    assert first["item_ids"] != other_user["item_ids"]
    assert workflow_reads == ["workflow-id", "workflow-id"]
    assert queue.get_enqueue_receipt(DEFAULT_QUEUE_ID, "caller-scoped-key", "submission-owner") is not None
    assert queue.get_enqueue_receipt(DEFAULT_QUEUE_ID, "caller-scoped-key", "submission-other") is not None


def test_acknowledge_submission_schema_and_registered_tool_reject_invalid_keys(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    server, queue_calls = _server_with_queue_spy(monkeypatch)
    tool = next(tool for tool in asyncio.run(server.list_tools()) if tool.name == "acknowledge_submission")
    key_schema = tool.input_schema["properties"]["idempotency_key"]

    assert key_schema["minLength"] == 1
    assert key_schema["maxLength"] == 255

    for idempotency_key in ("", "x" * 256):
        with pytest.raises(ToolError) as exc_info:
            asyncio.run(
                server.call_tool(
                    "acknowledge_submission",
                    {"idempotency_key": idempotency_key},
                    context=_ctx("submission-owner"),
                )
            )
        assert not isinstance(exc_info.value, UnexpectedToolError)
        assert isinstance(exc_info.value.__cause__, ValidationError)
    assert queue_calls == []


def test_acknowledge_submission_fails_closed_without_identity(monkeypatch: pytest.MonkeyPatch) -> None:
    server, queue_calls = _server_with_queue_spy(monkeypatch)
    ctx = SimpleNamespace(request_context=SimpleNamespace(request=None))

    with pytest.raises(UnexpectedToolError) as exc_info:
        asyncio.run(server.call_tool("acknowledge_submission", {"idempotency_key": "submission-key"}, context=ctx))

    assert isinstance(exc_info.value.__cause__, PermissionError)
    assert queue_calls == []


def test_acknowledge_submission_is_owner_scoped_and_idempotent(
    database: Database, mock_invoker: Any, monkeypatch: Any
) -> None:
    with database.begin(write=True) as conn:
        conn.execute(
            insert(users),
            [
                {"user_id": "submission-owner", "email": "owner@mcp.test", "password_hash": "test"},
                {"user_id": "submission-other", "email": "other@mcp.test", "password_hash": "test"},
            ],
        )
    queue = SessionQueue(database)
    queue.start(mock_invoker)
    mock_invoker.services.session_queue = queue
    monkeypatch.setattr(ApiDependencies, "invoker", mock_invoker, raising=False)

    asyncio.run(
        queue.enqueue_batch(
            DEFAULT_QUEUE_ID,
            Batch(graph=Graph(), idempotency_key="submission-key"),
            prepend=False,
            user_id="submission-owner",
        )
    )
    asyncio.run(
        queue.enqueue_batch(
            "other-queue",
            Batch(graph=Graph(), idempotency_key="submission-key"),
            prepend=False,
            user_id="submission-owner",
        )
    )

    from invokeai.mcp.submission import acknowledge_submission

    assert acknowledge_submission(_ctx("submission-other"), "submission-key") == {"status": "acknowledged"}
    with database.begin(write=False) as conn:
        acknowledged_at = conn.execute(
            select(session_queue_enqueue_receipts.c.acknowledged_at).where(
                session_queue_enqueue_receipts.c.user_id == "submission-owner",
                session_queue_enqueue_receipts.c.queue_id == DEFAULT_QUEUE_ID,
                session_queue_enqueue_receipts.c.idempotency_key == "submission-key",
            )
        ).scalar_one()
    assert acknowledged_at is None

    assert acknowledge_submission(_ctx("submission-owner"), "submission-key") == {"status": "acknowledged"}
    assert acknowledge_submission(_ctx("submission-owner"), "submission-key") == {"status": "acknowledged"}
    with database.begin(write=False) as conn:
        receipts = conn.execute(
            select(session_queue_enqueue_receipts.c.queue_id, session_queue_enqueue_receipts.c.acknowledged_at).where(
                session_queue_enqueue_receipts.c.user_id == "submission-owner",
                session_queue_enqueue_receipts.c.idempotency_key == "submission-key",
            )
        ).all()
    acknowledged_by_queue = dict(receipts)
    assert acknowledged_by_queue[DEFAULT_QUEUE_ID] is not None
    assert acknowledged_by_queue["other-queue"] is None
