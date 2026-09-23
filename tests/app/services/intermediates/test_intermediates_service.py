"""The intermediates cleanup engine against a real database, real files and the real queue tables.

Every test drives the public service interface; the eligibility policy is exercised through the
same SQL that production runs, never through a stub that decides what is safe.
"""

import time
import uuid
from pathlib import Path
from typing import Optional
from unittest.mock import MagicMock

import pytest
from PIL import Image

from invokeai.app.services.image_files.image_files_disk import DiskImageFileStorage
from invokeai.app.services.image_records.image_records_common import (
    ImageCategory,
    ImageRecordChanges,
    ImageRecordNotFoundException,
    ResourceOrigin,
)
from invokeai.app.services.intermediates import intermediates_default
from invokeai.app.services.intermediates.intermediates_base import IntermediatesCaller
from invokeai.app.services.intermediates.intermediates_common import (
    IntermediatesIdempotencyConflictError,
    IntermediatesOperation,
    IntermediatesOperationNotFoundError,
    IntermediatesOperationRequest,
    IntermediatesPreviewNotFoundError,
    IntermediatesPreviewRequest,
    IntermediatesScope,
    IntermediatesScopeForbiddenError,
    IntermediatesScopeTarget,
    IntermediatesUnavailableError,
)
from invokeai.app.services.intermediates.intermediates_default import IntermediatesService
from invokeai.app.services.intermediates.intermediates_records_sqlite import IntermediatesRecordsSqlite
from invokeai.app.services.invoker import Invoker
from invokeai.app.services.session_queue.session_queue_sqlite import SqliteSessionQueue
from invokeai.app.services.video_files.video_files_disk import DiskVideoFileStorage
from invokeai.app.services.video_records.video_records_common import VideoRecordNotFoundException
from invokeai.app.services.videos.videos_default import VideoService

ADMIN = IntermediatesCaller(user_id="admin", is_admin=True)
ALICE = IntermediatesCaller(user_id="alice", is_admin=False)
BOB = IntermediatesCaller(user_id="bob", is_admin=False)


@pytest.fixture
def invoker(mock_invoker: Invoker, tmp_path: Path) -> Invoker:
    """The shared mock invoker with real image/video file storage and a real queue table."""
    services = mock_invoker.services
    services.image_files = DiskImageFileStorage(tmp_path / "outputs")
    services.image_files.start(mock_invoker)
    services.video_files = DiskVideoFileStorage(str(tmp_path / "outputs" / "videos"))
    services.videos = VideoService()
    services.videos.start(mock_invoker)
    services.session_queue = SqliteSessionQueue(db=services.image_records._db)
    services.image_moves = None
    # These are multi-account scenarios; the single-user case is covered explicitly below.
    services.configuration.multiuser = True
    with services.image_records._db.transaction() as cursor:
        cursor.executemany(
            "INSERT INTO users (user_id, email, display_name, password_hash, is_admin, is_active)"
            " VALUES (?, ?, ?, 'x', ?, 1);",
            [
                ("admin", "admin@example.com", "Admin", 1),
                ("alice", "alice@example.com", "Alice", 0),
                ("bob", "bob@example.com", "Bob", 0),
            ],
        )
    return mock_invoker


@pytest.fixture
def service(invoker: Invoker) -> IntermediatesService:
    svc = IntermediatesService(records=IntermediatesRecordsSqlite(db=invoker.services.image_records._db))
    invoker.services.intermediates = svc
    svc.start(invoker)
    yield svc
    svc.stop()


def _seed_image(
    invoker: Invoker,
    name: str,
    *,
    user_id: str = "alice",
    project_id: Optional[str] = None,
    session_id: Optional[str] = None,
    is_intermediate: bool = True,
    created_at: Optional[str] = "2020-01-01 00:00:00.000",
    with_file: bool = True,
    size: Optional[int] = None,
) -> None:
    records = invoker.services.image_records
    records.save(
        image_name=name,
        image_origin=ResourceOrigin.INTERNAL,
        image_category=ImageCategory.GENERAL,
        width=8,
        height=8,
        has_workflow=False,
        is_intermediate=is_intermediate,
        session_id=session_id,
        user_id=user_id,
        project_id=project_id,
    )
    if created_at is not None:
        with records._db.transaction() as cursor:
            cursor.execute("UPDATE images SET created_at = ? WHERE image_name = ?;", (created_at, name))
    if with_file:
        invoker.services.image_files.save(image=Image.new("RGB", (8, 8)), image_name=name)
        measured = invoker.services.image_files.get_file_size_bytes(name)
        records.set_file_size_bytes(name, size if size is not None else measured)


def _seed_video(invoker: Invoker, name: str, *, user_id: str = "alice", is_intermediate: bool = True) -> None:
    records = invoker.services.video_records
    records.save(
        video_name=name,
        video_origin=ResourceOrigin.INTERNAL,
        video_category=ImageCategory.GENERAL,
        width=8,
        height=8,
        duration=1.0,
        fps=8.0,
        has_workflow=False,
        is_intermediate=is_intermediate,
        user_id=user_id,
    )
    with records._db.transaction() as cursor:
        cursor.execute("UPDATE videos SET created_at = '2020-01-01 00:00:00.000' WHERE video_name = ?;", (name,))
    files = invoker.services.video_files
    path = files.get_path(name)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(b"\x00" * 64)
    records.set_file_size_bytes(name, 64)


def _enqueue_row(
    invoker: Invoker, *, session_id: str, status: str, user_id: str = "alice", session_json: str = "{}"
) -> int:
    with invoker.services.image_records._db.transaction() as cursor:
        cursor.execute(
            "INSERT INTO session_queue (queue_id, session, session_id, batch_id, priority, user_id, status)"
            " VALUES ('default', ?, ?, ?, 0, ?, ?);",
            (session_json, session_id, uuid.uuid4().hex, user_id, status),
        )
        return int(cursor.lastrowid or 0)


def _project(invoker: Invoker, user_id: str, name: str, data: dict) -> str:
    return invoker.services.project_records.create(user_id, name, data).project_id


def _wait(
    service: IntermediatesService, operation_id: str, caller: IntermediatesCaller = ALICE
) -> IntermediatesOperation:
    deadline = time.monotonic() + 10
    while time.monotonic() < deadline:
        operation = service.get_operation(operation_id, caller)
        if operation.status in ("completed", "failed"):
            return operation
        time.sleep(0.02)
    raise AssertionError("operation did not finish")


def _run(service: IntermediatesService, caller: IntermediatesCaller, scope: IntermediatesScope, mode: str = "safe"):
    preview = service.create_preview(IntermediatesPreviewRequest(mode=mode, scope=scope), caller)
    started = service.start_operation(
        IntermediatesOperationRequest(preview_id=preview.preview_id, idempotency_key=uuid.uuid4().hex), caller
    )
    return preview, _wait(service, started.operation_id, caller)


def _owner(user_id: str) -> IntermediatesScope:
    return IntermediatesScope(kind="owner", user_id=user_id)


def _exists(invoker: Invoker, name: str) -> bool:
    try:
        invoker.services.image_records.get(name)
        return True
    except ImageRecordNotFoundException:
        return False


# ── summary ──


def test_summary_groups_rows_and_classifies_under_the_policy(invoker: Invoker, service: IntermediatesService) -> None:
    project = _project(
        invoker, "alice", "Portraits", {"canvas": {"stagingArea": {"pendingImages": [{"imageName": "staged.png"}]}}}
    )
    _seed_image(invoker, "safe.png", project_id=project, size=100)
    _seed_image(invoker, "staged.png", project_id=project, size=50)
    _seed_image(invoker, "active-output.png", project_id=project, session_id="s-active")
    _seed_image(invoker, "active-input.png", size=30)
    _seed_image(invoker, "fresh.png", created_at=None)
    _seed_image(invoker, "unmeasured.png", project_id=project, size=None)
    invoker.services.image_records.set_file_size_bytes("unmeasured.png", None)
    _seed_image(invoker, "deleted-project.png", project_id="gone", size=7)
    _seed_image(invoker, "durable.png", project_id=project, is_intermediate=False)
    invoker.services.board_image_records.add_image_to_board(
        invoker.services.project_records.get_board_id("alice", project), "durable.png"
    )
    _seed_image(invoker, "bobs.png", user_id="bob", size=9)
    _enqueue_row(invoker, session_id="s-active", status="in_progress")
    _enqueue_row(
        invoker,
        session_id="s-pending",
        status="pending",
        session_json='{"graph": {"nodes": {"a": {"image": {"image_name": "active-input.png"}}}}}',
    )
    _enqueue_row(invoker, session_id="s-done", status="completed", session_json='{"image_name": "safe.png"}')

    summary = service.get_summary(
        ALICE, owner_id=None, search=None, sort="reclaimable_bytes", descending=True, offset=0, limit=50
    )

    rows = {(row.project_id, row.project_name): row for row in summary.items}
    assert set(rows) == {(project, "Portraits"), (None, None)}
    portraits = rows[(project, "Portraits")]
    assert (portraits.images.safe, portraits.images.referenced, portraits.images.active, portraits.images.recent) == (
        2,
        1,
        1,
        0,
    )
    # The board's newest durable image is the row's thumbnail; intermediates never are.
    assert portraits.cover_image_name == "durable.png"
    assert portraits.reclaimable_bytes == 100
    assert portraits.referenced_bytes == 50
    assert portraits.unknown_size_count == 1
    unassigned = rows[(None, None)]
    assert (unassigned.images.safe, unassigned.images.active, unassigned.images.recent) == (1, 1, 1)
    assert unassigned.reclaimable_bytes == 7
    assert summary.totals.safe_images == 3
    assert summary.totals.in_use_images == 4
    assert summary.totals.reclaimable_bytes == 107
    assert summary.can_manage_everyone is False
    assert all(row.user_id == "alice" for row in summary.items)


def test_summary_scopes_owners_search_sort_and_pages(invoker: Invoker, service: IntermediatesService) -> None:
    alpha = _project(invoker, "alice", "Alpha", {})
    beta = _project(invoker, "alice", "Beta", {})
    _seed_image(invoker, "a.png", project_id=alpha, size=10)
    _seed_image(invoker, "b.png", project_id=beta, size=20)
    _seed_image(invoker, "bob.png", user_id="bob", size=30)

    everyone = service.get_summary(
        ADMIN, owner_id=None, search=None, sort="reclaimable_bytes", descending=True, offset=0, limit=50
    )
    assert [(row.user_id, row.project_name) for row in everyone.items] == [
        ("bob", None),
        ("alice", "Beta"),
        ("alice", "Alpha"),
    ]
    assert everyone.items[0].user_display_name == "Bob"
    assert everyone.can_manage_everyone is True

    by_name = service.get_summary(
        ADMIN, owner_id="alice", search=None, sort="project_name", descending=False, offset=1, limit=1
    )
    assert [row.project_name for row in by_name.items] == ["Beta"]
    assert by_name.total == 2 and by_name.totals.reclaimable_bytes == 30

    focused = service.get_summary(
        ALICE,
        owner_id=None,
        project_id=beta,
        search=None,
        sort="project_name",
        descending=False,
        offset=0,
        limit=1,
    )
    assert [(row.project_id, row.project_name) for row in focused.items] == [(beta, "Beta")]
    assert focused.total == 1

    searched = service.get_summary(
        ADMIN, owner_id=None, search="bo", sort="project_name", descending=False, offset=0, limit=50
    )
    assert [row.user_id for row in searched.items] == ["bob"]
    # Owner names are not searchable for a non-admin, whose rows are all their own anyway.
    assert (
        service.get_summary(
            ALICE, owner_id=None, search="alice", sort="project_name", descending=False, offset=0, limit=50
        ).items
        == []
    )

    with pytest.raises(IntermediatesScopeForbiddenError):
        service.get_summary(
            ALICE, owner_id="bob", search=None, sort="project_name", descending=False, offset=0, limit=50
        )


def test_summary_triggers_measurement_of_unmeasured_sizes(invoker: Invoker, service: IntermediatesService) -> None:
    _seed_image(invoker, "later.png", size=None)
    invoker.services.image_records.set_file_size_bytes("later.png", None)
    _seed_image(invoker, "missing.png", with_file=False)

    first = service.get_summary(
        ALICE, owner_id=None, search=None, sort="project_name", descending=False, offset=0, limit=50
    )
    assert first.measuring is True

    deadline = time.monotonic() + 10
    while time.monotonic() < deadline:
        if not service._records.has_unmeasured_intermediates():
            break
        time.sleep(0.02)
    expected = invoker.services.image_files.get_file_size_bytes("later.png")
    assert invoker.services.image_records.get("later.png").file_size_bytes == expected
    # A missing file measures as nothing on disk, not as unknown.
    assert invoker.services.image_records.get("missing.png").file_size_bytes == 0


def test_measurement_retries_when_an_unmeasured_file_is_still_too_new(
    invoker: Invoker, service: IntermediatesService, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(intermediates_default, "MEASURE_MIN_AGE_SECONDS", 1)
    _seed_image(invoker, "young.png", created_at=None)
    invoker.services.image_records.set_file_size_bytes("young.png", None)

    summary = service.get_summary(
        ALICE, owner_id=None, search=None, sort="project_name", descending=False, offset=0, limit=50
    )
    assert summary.measuring is True

    deadline = time.monotonic() + 4
    while time.monotonic() < deadline and invoker.services.image_records.get("young.png").file_size_bytes is None:
        time.sleep(0.02)
    assert invoker.services.image_records.get("young.png").file_size_bytes is not None


# ── previews and policy ──


def test_safe_cleanup_deletes_only_safe_items_and_reports_what_it_kept(
    invoker: Invoker, service: IntermediatesService
) -> None:
    project = _project(invoker, "alice", "P", {"layers": [{"imageName": "referenced.png"}]})
    _seed_image(invoker, "safe.png", project_id=project, size=100)
    _seed_image(invoker, "referenced.png", project_id=project)
    _seed_image(invoker, "active.png", project_id=project, session_id="s1")
    _seed_image(invoker, "fresh.png", project_id=project, created_at=None)
    _seed_video(invoker, "safe.mp4")
    _enqueue_row(invoker, session_id="s1", status="pending")
    deleted_callbacks: list[str] = []
    invoker.services.images.on_deleted(deleted_callbacks.append)

    preview, operation = _run(service, ALICE, _owner("alice"))

    assert (preview.impact.delete_images, preview.impact.delete_videos) == (1, 1)
    assert (
        preview.impact.keep_referenced_images,
        preview.impact.keep_active_images,
        preview.impact.keep_recent_images,
    ) == (1, 1, 1)
    assert preview.impact.reclaimable_bytes == 164
    assert preview.affected_documents == []
    assert operation.status == "completed"
    assert (operation.progress.deleted_images, operation.progress.deleted_videos) == (1, 1)
    assert operation.progress.reclaimed_bytes == 164
    assert not _exists(invoker, "safe.png")
    assert not invoker.services.image_files.get_path("safe.png").exists()
    assert not invoker.services.video_files.get_path("safe.mp4").exists()
    with pytest.raises(VideoRecordNotFoundException):
        invoker.services.video_records.get("safe.mp4")
    assert all(_exists(invoker, name) for name in ("referenced.png", "active.png", "fresh.png"))
    assert deleted_callbacks == ["safe.png"]
    assert list(invoker.services.image_files.image_root.glob(".delete_*")) == []


def test_force_cleanup_deletes_referenced_items_but_never_active_or_recent(
    invoker: Invoker, service: IntermediatesService
) -> None:
    project = _project(invoker, "alice", "Drafts", {"stagingArea": {"pendingImages": [{"imageName": "staged.png"}]}})
    workflow = invoker.services.workflow_records.create(_workflow_naming("staged.png"), user_id="bob")
    _seed_image(invoker, "staged.png", project_id=project, size=40)
    _seed_image(invoker, "active.png", project_id=project, session_id="s1")
    _seed_image(invoker, "fresh.png", project_id=project, created_at=None)
    _enqueue_row(invoker, session_id="s1", status="waiting")

    preview = service.create_preview(IntermediatesPreviewRequest(mode="force", scope=_owner("alice")), ALICE)
    assert preview.impact.delete_images == 1
    assert (preview.impact.keep_active_images, preview.impact.keep_recent_images) == (1, 1)
    # Alice sees her own project; Bob's workflow is counted but not described.
    assert [(doc.kind, doc.name, doc.references) for doc in preview.affected_documents] == [("project", "Drafts", 1)]
    assert preview.affected_documents_hidden == 1

    admin_preview = service.create_preview(IntermediatesPreviewRequest(mode="force", scope=_owner("alice")), ADMIN)
    assert {(doc.kind, doc.owner_id) for doc in admin_preview.affected_documents} == {
        ("project", project),
        ("workflow", workflow.workflow_id),
    }
    assert admin_preview.affected_documents_hidden == 0

    started = service.start_operation(
        IntermediatesOperationRequest(preview_id=preview.preview_id, idempotency_key="k"), ALICE
    )
    operation = _wait(service, started.operation_id)
    assert operation.status == "completed"
    assert not _exists(invoker, "staged.png")
    assert _exists(invoker, "active.png") and _exists(invoker, "fresh.png")


def _workflow_naming(image_name: str):
    from invokeai.app.services.workflow_records.workflow_records_common import (
        WorkflowCategory,
        WorkflowMeta,
        WorkflowWithoutID,
    )

    return WorkflowWithoutID(
        name="W",
        author="",
        description="",
        version="1.0.0",
        contact="",
        tags="",
        notes="",
        exposedFields=[],
        meta=WorkflowMeta(version="3.0.0", category=WorkflowCategory.User),
        nodes=[{"id": "n", "data": {"image": {"image_name": image_name}}}],
        edges=[],
    )


def test_selection_scope_targets_exactly_the_chosen_rows(invoker: Invoker, service: IntermediatesService) -> None:
    keep = _project(invoker, "alice", "Keep", {})
    clear = _project(invoker, "alice", "Clear", {})
    _seed_image(invoker, "keep.png", project_id=keep)
    _seed_image(invoker, "clear.png", project_id=clear)
    _seed_image(invoker, "unassigned.png")
    _seed_image(invoker, "orphaned-project.png", project_id="gone")

    scope = IntermediatesScope(
        kind="selection",
        targets=[
            IntermediatesScopeTarget(user_id="alice", project_id=clear),
            IntermediatesScopeTarget(user_id="alice", project_id=None),
            IntermediatesScopeTarget(user_id="alice", project_id=None),
        ],
    )
    preview, operation = _run(service, ALICE, scope)

    assert preview.target_rows == 2
    assert preview.impact.delete_images == 3
    assert operation.progress.deleted_images == 3
    assert _exists(invoker, "keep.png")
    assert not any(_exists(invoker, n) for n in ("clear.png", "unassigned.png", "orphaned-project.png"))


def test_a_preview_freezes_its_targets(invoker: Invoker, service: IntermediatesService) -> None:
    _seed_image(invoker, "before.png")
    preview = service.create_preview(IntermediatesPreviewRequest(mode="safe", scope=_owner("alice")), ALICE)
    _seed_image(invoker, "after.png")

    started = service.start_operation(
        IntermediatesOperationRequest(preview_id=preview.preview_id, idempotency_key="k"), ALICE
    )
    operation = _wait(service, started.operation_id)

    assert operation.target_images == 1
    assert not _exists(invoker, "before.png")
    assert _exists(invoker, "after.png")


def test_the_final_check_keeps_targets_protected_after_the_preview(
    invoker: Invoker, service: IntermediatesService
) -> None:
    project = _project(invoker, "alice", "P", {})
    _seed_image(invoker, "promoted.png", project_id=project)
    _seed_image(invoker, "now-referenced.png", project_id=project)
    _seed_image(invoker, "now-active.png", project_id=project, session_id="s-late")
    _seed_image(invoker, "still-safe.png", project_id=project)
    preview = service.create_preview(IntermediatesPreviewRequest(mode="safe", scope=_owner("alice")), ALICE)
    assert preview.impact.delete_images == 4

    invoker.services.image_records.update("promoted.png", ImageRecordChanges(is_intermediate=False))
    invoker.services.project_records.update(
        "alice", project, expected_revision=1, name="P", data={"imageName": "now-referenced.png"}
    )
    _enqueue_row(invoker, session_id="s-late", status="pending")

    started = service.start_operation(
        IntermediatesOperationRequest(preview_id=preview.preview_id, idempotency_key="k"), ALICE
    )
    operation = _wait(service, started.operation_id)

    assert operation.progress.deleted_images == 1
    assert operation.progress.retained_images == 3
    assert all(_exists(invoker, n) for n in ("promoted.png", "now-referenced.png", "now-active.png"))
    assert not _exists(invoker, "still-safe.png")
    assert invoker.services.image_files.get_path("promoted.png").exists()


def test_a_promoted_video_keeps_its_file(invoker: Invoker, service: IntermediatesService) -> None:
    _seed_video(invoker, "promoted.mp4")
    _seed_video(invoker, "gone.mp4")
    preview = service.create_preview(IntermediatesPreviewRequest(mode="safe", scope=_owner("alice")), ALICE)
    from invokeai.app.services.video_records.video_records_common import VideoRecordChanges

    invoker.services.video_records.update("promoted.mp4", VideoRecordChanges(is_intermediate=False))

    started = service.start_operation(
        IntermediatesOperationRequest(preview_id=preview.preview_id, idempotency_key="k"), ALICE
    )
    operation = _wait(service, started.operation_id)

    assert (operation.progress.deleted_videos, operation.progress.retained_videos) == (1, 1)
    assert invoker.services.video_files.get_path("promoted.mp4").exists()
    assert not invoker.services.video_files.get_path("gone.mp4").exists()
    assert list(Path(invoker.services.video_files.get_path("gone.mp4")).parent.glob(".delete_*")) == []


# ── authorization ──


def test_non_admins_are_confined_to_their_own_account(invoker: Invoker, service: IntermediatesService) -> None:
    with pytest.raises(IntermediatesScopeForbiddenError):
        service.create_preview(
            IntermediatesPreviewRequest(mode="safe", scope=IntermediatesScope(kind="everyone")), ALICE
        )
    with pytest.raises(IntermediatesScopeForbiddenError):
        service.create_preview(IntermediatesPreviewRequest(mode="safe", scope=_owner("bob")), ALICE)
    with pytest.raises(IntermediatesScopeForbiddenError):
        service.create_preview(
            IntermediatesPreviewRequest(
                mode="safe",
                scope=IntermediatesScope(
                    kind="selection",
                    targets=[IntermediatesScopeTarget(user_id="alice"), IntermediatesScopeTarget(user_id="bob")],
                ),
            ),
            ALICE,
        )


def test_admins_can_clear_everyone_and_a_chosen_account(invoker: Invoker, service: IntermediatesService) -> None:
    _seed_image(invoker, "alice.png", user_id="alice")
    _seed_image(invoker, "bob.png", user_id="bob")
    _seed_image(invoker, "admin.png", user_id="admin")

    _, first = _run(service, ADMIN, _owner("bob"))
    assert first.progress.deleted_images == 1 and _exists(invoker, "alice.png")

    _, second = _run(service, ADMIN, IntermediatesScope(kind="everyone"))
    assert second.progress.deleted_images == 2
    assert not any(_exists(invoker, n) for n in ("alice.png", "bob.png", "admin.png"))


def test_a_demoted_admin_stops_at_the_next_batch(invoker: Invoker, service: IntermediatesService, monkeypatch) -> None:
    monkeypatch.setattr(intermediates_default, "DELETE_BATCH_SIZE", 1)
    for index in range(3):
        _seed_image(invoker, f"bob-{index}.png", user_id="bob")
    preview = service.create_preview(IntermediatesPreviewRequest(mode="safe", scope=_owner("bob")), ADMIN)
    real_get = invoker.services.users.get
    calls = {"n": 0}

    def demote_after_first_batch(user_id: str):
        user = real_get(user_id)
        calls["n"] += 1
        if user is not None and user_id == "admin" and calls["n"] > 1:
            return user.model_copy(update={"is_admin": False})
        return user

    monkeypatch.setattr(invoker.services.users, "get", demote_after_first_batch)

    started = service.start_operation(
        IntermediatesOperationRequest(preview_id=preview.preview_id, idempotency_key="k"), ADMIN
    )
    operation = _wait(service, started.operation_id, ADMIN)

    assert operation.status == "failed"
    assert "no longer administers" in (operation.error or "")
    assert operation.progress.deleted_images == 1
    assert sum(_exists(invoker, f"bob-{i}.png") for i in range(3)) == 2


# ── operations: idempotency, retry, availability ──


def test_operations_are_idempotent_single_use_and_private(invoker: Invoker, service: IntermediatesService) -> None:
    _seed_image(invoker, "a.png")
    preview = service.create_preview(IntermediatesPreviewRequest(mode="safe", scope=_owner("alice")), ALICE)
    other = service.create_preview(IntermediatesPreviewRequest(mode="safe", scope=_owner("alice")), ALICE)

    with pytest.raises(IntermediatesPreviewNotFoundError):
        service.start_operation(IntermediatesOperationRequest(preview_id=preview.preview_id, idempotency_key="k"), BOB)

    first = service.start_operation(
        IntermediatesOperationRequest(preview_id=preview.preview_id, idempotency_key="k"), ALICE
    )
    again = service.start_operation(
        IntermediatesOperationRequest(preview_id=preview.preview_id, idempotency_key="k"), ALICE
    )
    assert again.operation_id == first.operation_id

    with pytest.raises(IntermediatesIdempotencyConflictError):
        service.start_operation(IntermediatesOperationRequest(preview_id=other.preview_id, idempotency_key="k"), ALICE)
    with pytest.raises(IntermediatesPreviewNotFoundError):
        service.start_operation(
            IntermediatesOperationRequest(preview_id=preview.preview_id, idempotency_key="k2"), ALICE
        )

    _wait(service, first.operation_id)
    with pytest.raises(IntermediatesOperationNotFoundError):
        service.get_operation(first.operation_id, BOB)
    assert service.get_operation(first.operation_id, ADMIN).status == "completed"


def test_a_failed_batch_is_reported_and_retried_without_widening(
    invoker: Invoker, service: IntermediatesService, monkeypatch
) -> None:
    monkeypatch.setattr(intermediates_default, "DELETE_BATCH_SIZE", 1)
    _seed_image(invoker, "ok.png")
    _seed_image(invoker, "flaky.png")
    real_delete = invoker.services.images.delete_intermediates_by_names

    def fail_flaky_once(names, guard=None):
        if "flaky.png" in names and not getattr(fail_flaky_once, "failed", False):
            fail_flaky_once.failed = True  # type: ignore[attr-defined]
            raise OSError("disk hiccup")
        return real_delete(names, guard)

    monkeypatch.setattr(invoker.services.images, "delete_intermediates_by_names", fail_flaky_once)

    _, operation = _run(service, ALICE, _owner("alice"))
    assert operation.status == "completed"
    assert (operation.progress.deleted_images, operation.progress.failed_images) == (1, 1)
    assert _exists(invoker, "flaky.png")

    _seed_image(invoker, "new-since.png")
    retry = service.retry_operation(operation.operation_id, ALICE)
    retried = _wait(service, retry.operation_id)
    assert retried.retried_from_operation_id == operation.operation_id
    assert retried.target_images == 1
    assert retried.progress.deleted_images == 1
    assert not _exists(invoker, "flaky.png")
    assert _exists(invoker, "new-since.png")
    with pytest.raises(IntermediatesUnavailableError):
        service.retry_operation(retried.operation_id, ALICE)


def test_a_purge_failure_counts_as_pending_disk_cleanup_not_reclaimed(
    invoker: Invoker, service: IntermediatesService, monkeypatch
) -> None:
    _seed_image(invoker, "stuck.png", size=500)
    monkeypatch.setattr(invoker.services.image_files, "commit_delete", MagicMock(side_effect=OSError("busy")))

    _, operation = _run(service, ALICE, _owner("alice"))

    assert operation.status == "completed"
    assert operation.progress.deleted_images == 1
    assert operation.progress.reclaimed_bytes == 0
    assert operation.progress.pending_disk_cleanup == 1
    assert not _exists(invoker, "stuck.png")
    # The journal survives for the next startup to finish the purge.
    assert len(list(invoker.services.image_files.image_root.glob(".delete_*"))) == 1


def test_failed_video_purge_is_recovered_after_restart(invoker: Invoker, monkeypatch: pytest.MonkeyPatch) -> None:
    _seed_video(invoker, "recover.mp4")
    files = invoker.services.video_files
    path = files.get_path("recover.mp4")
    original_unlink = Path.unlink
    failed_once = False

    def fail_once(candidate: Path, *args, **kwargs) -> None:
        nonlocal failed_once
        if candidate == path and not failed_once:
            failed_once = True
            raise OSError("video file temporarily locked")
        original_unlink(candidate, *args, **kwargs)

    monkeypatch.setattr(Path, "unlink", fail_once)
    result = invoker.services.videos.delete_intermediates_by_names(["recover.mp4"])

    assert result.deleted_names == ["recover.mp4"]
    assert result.purge_deferred == ["recover.mp4"]
    assert path.exists()
    DiskVideoFileStorage(path.parent).start(invoker)
    assert not path.exists()


def test_cleanup_refuses_to_start_or_continue_during_storage_maintenance(
    invoker: Invoker, service: IntermediatesService, monkeypatch
) -> None:
    monkeypatch.setattr(intermediates_default, "DELETE_BATCH_SIZE", 1)
    _seed_image(invoker, "one.png")
    _seed_image(invoker, "two.png")
    moves = MagicMock()
    moves.is_maintenance_active.return_value = True
    invoker.services.image_moves = moves
    preview = service.create_preview(IntermediatesPreviewRequest(mode="safe", scope=_owner("alice")), ALICE)
    with pytest.raises(IntermediatesUnavailableError):
        service.start_operation(
            IntermediatesOperationRequest(preview_id=preview.preview_id, idempotency_key="k"), ALICE
        )

    invoker.services.image_moves = None
    started = service.start_operation(
        IntermediatesOperationRequest(preview_id=preview.preview_id, idempotency_key="k"), ALICE
    )
    # Halt after the first batch: the second sees maintenance and stops with the rest unresolved.
    real_delete = invoker.services.images.delete_intermediates_by_names

    def delete_then_start_maintenance(names, guard=None):
        result = real_delete(names, guard)
        invoker.services.image_moves = moves
        return result

    monkeypatch.setattr(invoker.services.images, "delete_intermediates_by_names", delete_then_start_maintenance)
    operation = _wait(service, started.operation_id)
    assert operation.status == "failed"
    assert operation.progress.deleted_images == 1
    assert operation.progress.failed_images == 0
    invoker.services.image_moves = None
    retried = _wait(service, service.retry_operation(operation.operation_id, ALICE).operation_id)
    assert retried.target_images == 1 and retried.progress.deleted_images == 1


def test_operation_events_reach_the_bus(invoker: Invoker, service: IntermediatesService) -> None:
    from invokeai.app.services.events.events_common import IntermediatesOperationChangedEvent

    _seed_image(invoker, "a.png")
    _, operation = _run(service, ALICE, _owner("alice"))

    statuses = [
        e.operation.status
        for e in invoker.services.events.events  # type: ignore[attr-defined]
        if isinstance(e, IntermediatesOperationChangedEvent) and e.operation.operation_id == operation.operation_id
    ]
    assert statuses[0] == "pending" and statuses[-1] == "completed" and "running" in statuses
    assert all(
        e.user_id == "alice"
        for e in invoker.services.events.events
        if isinstance(e, IntermediatesOperationChangedEvent)
    )  # type: ignore[attr-defined]


# ── legacy ──


def test_legacy_clear_all_deletes_every_safe_image_and_nothing_else(
    invoker: Invoker, service: IntermediatesService
) -> None:
    _project(invoker, "alice", "P", {"imageName": "referenced.png"})
    _seed_image(invoker, "alice-safe.png", user_id="alice")
    _seed_image(invoker, "bob-safe.png", user_id="bob")
    _seed_image(invoker, "referenced.png")
    _seed_image(invoker, "active.png", session_id="s1")
    _seed_video(invoker, "video.mp4")
    _enqueue_row(invoker, session_id="s1", status="pending")

    with pytest.raises(IntermediatesScopeForbiddenError):
        service.clear_all_images_now(ALICE)
    assert service.clear_all_images_now(ADMIN) == 2

    assert not _exists(invoker, "alice-safe.png") and not _exists(invoker, "bob-safe.png")
    assert _exists(invoker, "referenced.png") and _exists(invoker, "active.png")
    assert invoker.services.video_records.get("video.mp4").is_intermediate is True


# ── review follow-ups ──


def test_single_user_mode_clears_everyone_without_an_admin_row(invoker: Invoker, service: IntermediatesService) -> None:
    """The default install: every request is the local administrator, but the `system` row is not an admin."""
    invoker.services.configuration.multiuser = False
    _seed_image(invoker, "one.png", user_id="system")
    _seed_image(invoker, "two.png", user_id="alice")

    _, operation = _run(
        service, IntermediatesCaller(user_id="system", is_admin=True), IntermediatesScope(kind="everyone")
    )

    assert operation.status == "completed", operation.error
    assert operation.progress.deleted_images == 2


def test_inputs_added_to_an_active_session_after_it_was_scanned_are_protected(
    invoker: Invoker, service: IntermediatesService
) -> None:
    """A workflow-call parent is rewritten with its child's outputs while it stays active."""
    _seed_image(invoker, "child-output.png")
    item_id = _enqueue_row(invoker, session_id="parent", status="waiting", session_json='{"graph": {}}')
    first = service.create_preview(IntermediatesPreviewRequest(mode="safe", scope=_owner("alice")), ALICE)
    assert first.impact.delete_images == 1

    with invoker.services.image_records._db.transaction() as cursor:
        cursor.execute(
            "UPDATE session_queue SET session = ?, status = 'pending' WHERE item_id = ?;",
            ('{"results": {"n": {"image": {"image_name": "child-output.png"}}}}', item_id),
        )

    second = service.create_preview(IntermediatesPreviewRequest(mode="safe", scope=_owner("alice")), ALICE)
    assert second.impact.delete_images == 0
    assert second.impact.keep_active_images == 1


def test_cleanup_rechecks_same_length_active_session_rewrites_with_an_unchanged_timestamp(
    invoker: Invoker, service: IntermediatesService
) -> None:
    _seed_image(invoker, "old.png")
    _seed_image(invoker, "new.png")
    item_id = _enqueue_row(invoker, session_id="parent", status="waiting", session_json='{"image_name":"old.png"}')
    preview = service.create_preview(IntermediatesPreviewRequest(mode="safe", scope=_owner("alice")), ALICE)
    assert preview.impact.delete_images == 1

    # The queue timestamp has millisecond precision. Suppress its trigger to make the
    # same-millisecond, same-length rewrite deterministic instead of timing dependent.
    with invoker.services.image_records._db.transaction() as cursor:
        cursor.execute("DROP TRIGGER tg_session_queue_updated_at;")
        cursor.execute("UPDATE session_queue SET session = ? WHERE item_id = ?;", ('{"image_name":"new.png"}', item_id))

    started = service.start_operation(
        IntermediatesOperationRequest(preview_id=preview.preview_id, idempotency_key="same-stamp"), ALICE
    )
    assert _wait(service, started.operation_id).progress.retained_images == 1
    assert _exists(invoker, "new.png")


def test_retries_are_authorized_as_the_retrying_caller(
    invoker: Invoker, service: IntermediatesService, monkeypatch
) -> None:
    monkeypatch.setattr(intermediates_default, "DELETE_BATCH_SIZE", 1)
    _seed_image(invoker, "bob-flaky.png", user_id="bob")
    real_delete = invoker.services.images.delete_intermediates_by_names

    def fail_once(names, guard=None):
        if not getattr(fail_once, "failed", False):
            fail_once.failed = True  # type: ignore[attr-defined]
            raise OSError("disk hiccup")
        return real_delete(names, guard)

    monkeypatch.setattr(invoker.services.images, "delete_intermediates_by_names", fail_once)
    _, operation = _run(service, ADMIN, _owner("bob"))
    assert operation.progress.unresolved_images == 1

    # Another account cannot even see it; the demoted confirmer may see it but not widen to Bob.
    with pytest.raises(IntermediatesOperationNotFoundError):
        service.retry_operation(operation.operation_id, ALICE)
    with pytest.raises(IntermediatesScopeForbiddenError):
        service.retry_operation(operation.operation_id, IntermediatesCaller(user_id="admin", is_admin=False))
    assert _exists(invoker, "bob-flaky.png")

    retry = service.retry_operation(operation.operation_id, ADMIN)
    assert _wait(service, retry.operation_id, ADMIN).progress.deleted_images == 1
    # A duplicated retry request returns the retry that already took the targets over.
    assert service.retry_operation(operation.operation_id, ADMIN).operation_id == retry.operation_id
    assert service.get_operation(operation.operation_id, ADMIN).retried_by_operation_id == retry.operation_id


def test_a_deactivated_caller_stops_at_the_next_batch(
    invoker: Invoker, service: IntermediatesService, monkeypatch
) -> None:
    monkeypatch.setattr(intermediates_default, "DELETE_BATCH_SIZE", 1)
    for index in range(2):
        _seed_image(invoker, f"a-{index}.png")
    preview = service.create_preview(IntermediatesPreviewRequest(mode="safe", scope=_owner("alice")), ALICE)
    real_get = invoker.services.users.get
    calls = {"n": 0}

    def deactivate_after_first_batch(user_id: str):
        user = real_get(user_id)
        calls["n"] += 1
        return user.model_copy(update={"is_active": False}) if user is not None and calls["n"] > 1 else user

    monkeypatch.setattr(invoker.services.users, "get", deactivate_after_first_batch)

    started = service.start_operation(
        IntermediatesOperationRequest(preview_id=preview.preview_id, idempotency_key="k"), ALICE
    )
    operation = _wait(service, started.operation_id)

    assert operation.status == "failed"
    assert operation.progress.deleted_images == 1
    assert operation.progress.unresolved_images == 1


def test_unmeasured_targets_are_reported_rather_than_counted_as_free(
    invoker: Invoker, service: IntermediatesService
) -> None:
    _seed_image(invoker, "measured.png", size=10)
    _seed_image(invoker, "unmeasured.png")
    invoker.services.image_records.set_file_size_bytes("unmeasured.png", None)

    preview, operation = _run(service, ALICE, _owner("alice"))

    assert preview.impact.unknown_size_count == 1
    assert operation.progress.reclaimed_bytes == 10
    assert operation.progress.unknown_size_count == 1


def test_a_replayed_start_is_answered_during_maintenance(invoker: Invoker, service: IntermediatesService) -> None:
    _seed_image(invoker, "a.png")
    preview = service.create_preview(IntermediatesPreviewRequest(mode="safe", scope=_owner("alice")), ALICE)
    first = service.start_operation(
        IntermediatesOperationRequest(preview_id=preview.preview_id, idempotency_key="k"), ALICE
    )
    _wait(service, first.operation_id)
    moves = MagicMock()
    moves.is_maintenance_active.return_value = True
    invoker.services.image_moves = moves

    replay = service.start_operation(
        IntermediatesOperationRequest(preview_id=preview.preview_id, idempotency_key="k"), ALICE
    )

    assert replay.operation_id == first.operation_id


def test_a_save_cannot_slip_between_the_final_check_and_the_delete(
    invoker: Invoker, service: IntermediatesService, monkeypatch
) -> None:
    """The guard and the DELETE share one transaction under the database lock, so a project save that
    would protect a target either lands before the check (target kept) or after the commit."""
    import threading

    project = _project(invoker, "alice", "P", {})
    _seed_image(invoker, "raced.png", project_id=project)
    records = service._records
    real_guard_factory = records.make_delete_guard
    guard_entered = threading.Event()
    guard_may_finish = threading.Event()
    delete_committed_at: list[float] = []

    def slow_guard_factory(kind, *, mode, allowed_user_ids, confirmed_references=None):
        guard = real_guard_factory(
            kind, mode=mode, allowed_user_ids=allowed_user_ids, confirmed_references=confirmed_references
        )

        def paused(cursor, names):
            guard_entered.set()
            assert guard_may_finish.wait(timeout=10)
            return guard(cursor, names)

        return paused

    monkeypatch.setattr(records, "make_delete_guard", slow_guard_factory)
    real_record_delete = invoker.services.image_records.delete_intermediates_by_names

    def timed_record_delete(names, guard=None):
        result = real_record_delete(names, guard=guard)
        delete_committed_at.append(time.monotonic())
        return result

    monkeypatch.setattr(invoker.services.image_records, "delete_intermediates_by_names", timed_record_delete)

    preview = service.create_preview(IntermediatesPreviewRequest(mode="safe", scope=_owner("alice")), ALICE)
    started = service.start_operation(
        IntermediatesOperationRequest(preview_id=preview.preview_id, idempotency_key="k"), ALICE
    )
    assert guard_entered.wait(timeout=10)

    save_finished_at: list[float] = []

    def save_reference() -> None:
        invoker.services.project_records.update(
            "alice", project, expected_revision=1, name="P", data={"imageName": "raced.png"}
        )
        save_finished_at.append(time.monotonic())

    saver = threading.Thread(target=save_reference)
    saver.start()
    saver.join(timeout=0.5)
    assert saver.is_alive(), "the save committed while the delete's final check was in progress"

    guard_may_finish.set()
    saver.join(timeout=10)
    operation = _wait(service, started.operation_id)

    assert operation.progress.deleted_images == 1
    assert save_finished_at[0] >= delete_committed_at[0]


def test_active_inputs_survive_a_rolled_back_batch(
    invoker: Invoker, service: IntermediatesService, monkeypatch
) -> None:
    """A failed batch rolls the temp table back; the next check must still see everything active."""
    monkeypatch.setattr(intermediates_default, "DELETE_BATCH_SIZE", 1)
    _seed_image(invoker, "first.png")
    _seed_image(invoker, "consumed.png")
    preview = service.create_preview(IntermediatesPreviewRequest(mode="safe", scope=_owner("alice")), ALICE)
    assert preview.impact.delete_images == 2
    # Enqueued after the preview: only the final check can protect it.
    _enqueue_row(invoker, session_id="s-late", status="pending", session_json='{"a": {"image_name": "consumed.png"}}')
    real_delete = invoker.services.image_records.delete_intermediates_by_names
    calls = {"n": 0}

    def fail_first_batch_after_the_guard(names, guard=None):
        calls["n"] += 1
        if calls["n"] == 1:
            with invoker.services.image_records._db.transaction() as cursor:
                if guard is not None:
                    guard(cursor, names)
                raise RuntimeError("simulated I/O failure after the guard rebuilt the temp table")
        return real_delete(names, guard=guard)

    monkeypatch.setattr(
        invoker.services.image_records, "delete_intermediates_by_names", fail_first_batch_after_the_guard
    )

    started = service.start_operation(
        IntermediatesOperationRequest(preview_id=preview.preview_id, idempotency_key="k"), ALICE
    )
    operation = _wait(service, started.operation_id)

    assert operation.progress.failed_images == 1
    assert _exists(invoker, "consumed.png"), "an input of pending work was deleted after a rolled-back batch"


def test_force_clear_keeps_a_newly_referenced_target(invoker: Invoker, service: IntermediatesService) -> None:
    _seed_image(invoker, "force-race.png")
    preview = service.create_preview(IntermediatesPreviewRequest(mode="force", scope=_owner("alice")), ALICE)
    assert preview.affected_documents == []
    _project(invoker, "alice", "Saved after preview", {"imageName": "force-race.png"})

    started = service.start_operation(
        IntermediatesOperationRequest(preview_id=preview.preview_id, idempotency_key="force-race"), ALICE
    )
    finished = _wait(service, started.operation_id)

    assert finished.progress.retained_images == 1
    assert _exists(invoker, "force-race.png")


def test_browser_hold_protects_unsaved_and_undo_references(invoker: Invoker, service: IntermediatesService) -> None:
    from invokeai.app.services.intermediates.intermediates_common import IntermediatesBrowserHoldRequest

    _seed_image(invoker, "browser-only.png")
    service.replace_browser_hold(ALICE, "tab-1", IntermediatesBrowserHoldRequest(images=["browser-only.png"]))
    preview = service.create_preview(IntermediatesPreviewRequest(mode="force", scope=_owner("alice")), ALICE)
    assert preview.impact.keep_active_images == 1
    assert preview.impact.delete_images == 0

    service.release_browser_hold(BOB, "tab-1")
    still_held = service.create_preview(IntermediatesPreviewRequest(mode="safe", scope=_owner("alice")), ALICE)
    assert still_held.impact.keep_active_images == 1
    service.release_browser_hold(ALICE, "tab-1")
    service.replace_browser_hold(BOB, "tab-2", IntermediatesBrowserHoldRequest(images=["browser-only.png"]))
    available = service.create_preview(IntermediatesPreviewRequest(mode="safe", scope=_owner("alice")), ALICE)
    assert available.impact.delete_images == 1


def test_operation_receipt_and_retry_survive_restart(
    invoker: Invoker, service: IntermediatesService, monkeypatch
) -> None:
    _seed_image(invoker, "restart-flaky.png")
    real_delete = invoker.services.images.delete_intermediates_by_names
    monkeypatch.setattr(
        invoker.services.images, "delete_intermediates_by_names", MagicMock(side_effect=OSError("busy"))
    )
    preview = service.create_preview(IntermediatesPreviewRequest(mode="safe", scope=_owner("alice")), ALICE)
    started = service.start_operation(
        IntermediatesOperationRequest(preview_id=preview.preview_id, idempotency_key="restart-key"), ALICE
    )
    finished = _wait(service, started.operation_id)
    assert finished.progress.unresolved_images == 1
    service.stop()

    restored = IntermediatesService(IntermediatesRecordsSqlite(invoker.services.image_records._db))
    invoker.services.intermediates = restored
    restored.start(invoker)
    try:
        assert restored.get_operation(finished.operation_id, ALICE).progress.unresolved_images == 1
        replay = restored.start_operation(
            IntermediatesOperationRequest(preview_id=preview.preview_id, idempotency_key="restart-key"), ALICE
        )
        assert replay.operation_id == finished.operation_id
        monkeypatch.setattr(invoker.services.images, "delete_intermediates_by_names", real_delete)
        retry = restored.retry_operation(finished.operation_id, ALICE)
        assert _wait(restored, retry.operation_id).progress.deleted_images == 1
        assert restored.retry_operation(finished.operation_id, ALICE).operation_id == retry.operation_id
        assert not _exists(invoker, "restart-flaky.png")
    finally:
        restored.stop()


def test_receipt_pruning_keeps_unresolved_targets_retryable(
    invoker: Invoker, service: IntermediatesService, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(intermediates_default, "MAX_RETAINED_OPERATIONS", 2)
    _seed_image(invoker, "flaky.png")
    real_delete = invoker.services.images.delete_intermediates_by_names
    monkeypatch.setattr(
        invoker.services.images, "delete_intermediates_by_names", MagicMock(side_effect=OSError("busy"))
    )
    _, failed = _run(service, ALICE, _owner("alice"))
    assert failed.progress.unresolved_images == 1
    monkeypatch.setattr(invoker.services.images, "delete_intermediates_by_names", real_delete)

    # New successful receipts may be pruned; the failed operation's exact target must not be.
    for _ in range(2):
        _run(service, ADMIN, _owner("bob"))

    assert service.get_operation(failed.operation_id, ALICE).progress.unresolved_images == 1
    retry = service.retry_operation(failed.operation_id, ALICE)
    assert _wait(service, retry.operation_id).progress.deleted_images == 1


def test_recovery_capacity_refuses_new_work_but_allows_the_unresolved_retry(
    invoker: Invoker, service: IntermediatesService, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(intermediates_default, "MAX_RETAINED_OPERATIONS", 1)
    _seed_image(invoker, "flaky.png")
    real_delete = invoker.services.images.delete_intermediates_by_names
    monkeypatch.setattr(
        invoker.services.images, "delete_intermediates_by_names", MagicMock(side_effect=OSError("busy"))
    )
    _, failed = _run(service, ALICE, _owner("alice"))
    assert failed.progress.unresolved_images == 1
    monkeypatch.setattr(invoker.services.images, "delete_intermediates_by_names", real_delete)

    preview = service.create_preview(IntermediatesPreviewRequest(mode="safe", scope=_owner("bob")), ADMIN)
    with pytest.raises(IntermediatesUnavailableError, match="Retry unresolved"):
        service.start_operation(
            IntermediatesOperationRequest(preview_id=preview.preview_id, idempotency_key="another"), ADMIN
        )
    assert service.get_operation(failed.operation_id, ALICE).progress.unresolved_images == 1
    retry = service.retry_operation(failed.operation_id, ALICE)
    assert _wait(service, retry.operation_id).progress.deleted_images == 1


def test_force_confirmation_guard_survives_failed_batch_and_restart(
    invoker: Invoker, service: IntermediatesService, monkeypatch: pytest.MonkeyPatch
) -> None:
    _seed_image(invoker, "force-retry.png")
    preview = service.create_preview(IntermediatesPreviewRequest(mode="force", scope=_owner("alice")), ALICE)
    real_delete = invoker.services.images.delete_intermediates_by_names
    monkeypatch.setattr(
        invoker.services.images, "delete_intermediates_by_names", MagicMock(side_effect=OSError("busy"))
    )
    started = service.start_operation(
        IntermediatesOperationRequest(preview_id=preview.preview_id, idempotency_key="force-retry"), ALICE
    )
    assert _wait(service, started.operation_id).progress.unresolved_images == 1
    service.stop()
    _project(invoker, "alice", "New reference", {"imageName": "force-retry.png"})

    restored = IntermediatesService(IntermediatesRecordsSqlite(invoker.services.image_records._db))
    invoker.services.intermediates = restored
    restored.start(invoker)
    monkeypatch.setattr(invoker.services.images, "delete_intermediates_by_names", real_delete)
    try:
        retry = restored.retry_operation(started.operation_id, ALICE)
        result = _wait(restored, retry.operation_id)
        assert result.progress.retained_images == 1
        assert _exists(invoker, "force-retry.png")
    finally:
        restored.stop()


def test_measurement_skip_set_does_not_starve_later_rows(invoker: Invoker, service: IntermediatesService) -> None:
    records = service._records
    for index in range(501):
        _seed_image(invoker, f"unmeasurable-{index}.png", with_file=False)
        invoker.services.image_records.set_file_size_bytes(f"unmeasurable-{index}.png", None)
    _seed_image(invoker, "later-measurable.png", with_file=False)
    invoker.services.image_records.set_file_size_bytes("later-measurable.png", None)

    records.mark_unmeasurable("image", [f"unmeasurable-{index}.png" for index in range(501)])

    assert records.next_unmeasured("image", 1) == [("later-measurable.png", "")]


def test_receipt_write_failure_does_not_strand_the_accepted_queue(
    invoker: Invoker, service: IntermediatesService, monkeypatch: pytest.MonkeyPatch
) -> None:
    original_ensure_worker = service._ensure_worker
    monkeypatch.setattr(service, "_ensure_worker", lambda: None)
    operation_ids = []
    for index in range(2):
        _seed_image(invoker, f"queued-{index}.png")
        preview = service.create_preview(IntermediatesPreviewRequest(mode="safe", scope=_owner("alice")), ALICE)
        started = service.start_operation(
            IntermediatesOperationRequest(preview_id=preview.preview_id, idempotency_key=f"queued-{index}"), ALICE
        )
        operation_ids.append(started.operation_id)

    real_save = service._records.save_operation
    failures = 0

    def fail_two_writes(*args, **kwargs):
        nonlocal failures
        if failures < 2:
            failures += 1
            raise OSError("storage temporarily unavailable")
        return real_save(*args, **kwargs)

    monkeypatch.setattr(service._records, "save_operation", fail_two_writes)
    monkeypatch.setattr(service, "_ensure_worker", original_ensure_worker)
    service._ensure_worker()

    assert _wait(service, operation_ids[0]).status == "failed"
    assert _wait(service, operation_ids[1]).status == "completed"


def test_large_single_row_clears_in_bounded_batches_past_protected_items(
    invoker: Invoker, service: IntermediatesService, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(intermediates_default, "MAX_OPERATION_TARGETS", 2)
    _seed_image(invoker, "protected-first.png")
    _project(invoker, "alice", "Uses image", {"imageName": "protected-first.png"})
    for index in range(3):
        _seed_image(invoker, f"eligible-{index}.png")

    first, first_result = _run(service, ALICE, _owner("alice"))
    assert first.has_more_eligible
    assert first.impact.delete_images == 2
    assert first.impact.keep_referenced_images == 1
    assert first_result.progress.deleted_images == 2

    second, second_result = _run(service, ALICE, _owner("alice"))
    assert not second.has_more_eligible
    assert second.impact.delete_images == 1
    assert second_result.progress.deleted_images == 1
    assert _exists(invoker, "protected-first.png")


@pytest.mark.parametrize("cleanup_wins_race", [False, True])
def test_running_graph_keeps_cached_media_or_recomputes_if_cleanup_won(
    invoker, service, monkeypatch, cleanup_wins_race
):
    from threading import Event

    from invokeai.app.invocations.image import BlankImageInvocation, ImageCropInvocation
    from invokeai.app.services.invocation_cache.invocation_cache_memory import MemoryInvocationCache
    from invokeai.app.services.names.names_default import SimpleNameService
    from invokeai.app.services.progress_previews.progress_previews_default import MemoryProgressPreviews
    from invokeai.app.services.session_processor.session_processor_default import DefaultSessionRunner
    from invokeai.app.services.shared.graph import Graph, GraphExecutionState
    from invokeai.app.services.urls.urls_default import LocalUrlService
    from tests.app.services.workflow_call_test_utils import _DummyStats
    from tests.test_nodes import create_edge

    services = invoker.services
    services.session_queue.start(invoker)
    services.configuration.node_cache_size = 512
    services.names = SimpleNameService()
    services.urls = LocalUrlService()
    services.performance_statistics = _DummyStats()
    services.progress_previews = MemoryProgressPreviews()
    services.tensors = MagicMock()
    services.conditioning = MagicMock()
    cache = services.invocation_cache = MemoryInvocationCache(max_cache_size=512)
    cache.start(invoker)
    runner = DefaultSessionRunner()
    runner.start(services, Event())
    graph = Graph()
    graph.add_node(BlankImageInvocation(id="blank", width=8, height=8, is_intermediate=True))
    graph.add_node(ImageCropInvocation(id="crop", x=0, y=0, width=4, height=4, use_cache=False))
    graph.add_edge(create_edge("blank", "image", "crop", "image"))

    def queued_session():
        session = GraphExecutionState(graph=graph.model_copy(deep=True))
        item_id = _enqueue_row(
            invoker, session_id=session.id, status="in_progress", session_json=session.model_dump_json()
        )
        return services.session_queue.get_queue_item(item_id)

    first = queued_session()
    first_blank = first.session.next()
    runner.run_node(first_blank, first)
    assert not first.session.has_error()
    image_name = first.session.results[first_blank.id].image.image_name
    runner.run_node(first.session.next(), first)
    assert first.session.is_complete() and not first.session.has_error()
    services.session_queue.save_queue_item_session(first.item_id, first.session)
    with services.image_records._db.transaction() as cursor:
        cursor.execute("UPDATE session_queue SET status = 'completed' WHERE item_id = ?", (first.item_id,))
        cursor.execute("UPDATE images SET created_at = '2020-01-01 00:00:00.000' WHERE image_name = ?", (image_name,))

    if cleanup_wins_race:
        real_get = cache.get

        def get_then_cleanup(key):
            output = real_get(key)
            if output is not None:
                _, completed = _run(service, ALICE, _owner("alice"))
                assert completed.progress.deleted_images == 1
            return output

        monkeypatch.setattr(cache, "get", get_then_cleanup)

    second = queued_session()
    second_blank = second.session.next()
    runner.run_node(second_blank, second)
    assert not second.session.has_error()
    assert cache.get_status().hits == 1
    second_image = second.session.results[second_blank.id].image.image_name
    if cleanup_wins_race:
        assert second_image != image_name
    else:
        assert second_image == image_name
        record = services.image_records.get(image_name)
        assert record.session_id == first.session_id
        stored_second = services.session_queue.get_queue_item(second.item_id)
        assert image_name not in stored_second.session.model_dump_json()
        for mode in ("safe", "force"):
            preview, completed = _run(service, ALICE, _owner("alice"), mode=mode)
            assert preview.impact.keep_active_images == 1
            assert completed.progress.deleted_images == 0
        assert services.image_files.get_path(image_name, image_subfolder=record.image_subfolder).exists()

    runner.run_node(second.session.next(), second)
    assert second.session.is_complete() and not second.session.has_error()
    services.session_queue.save_queue_item_session(second.item_id, second.session)
    with services.image_records._db.transaction() as cursor:
        cursor.execute("UPDATE session_queue SET status = 'completed' WHERE item_id = ?", (second.item_id,))
    if not cleanup_wins_race:
        _, completed = _run(service, ALICE, _owner("alice"))
        assert completed.progress.deleted_images == 1


@pytest.mark.parametrize("mode", ["safe", "force"])
def test_cached_media_holds_guard_frozen_targets_until_all_consuming_sessions_end(invoker, service, mode):
    from invokeai.app.services.shared.media_references import MediaReferences

    _seed_image(invoker, "cached.png")
    _seed_video(invoker, "cached.mp4")
    preview = service.create_preview(IntermediatesPreviewRequest(mode=mode, scope=_owner("alice")), ALICE)
    first = _enqueue_row(invoker, session_id="first-consumer", status="in_progress")
    second = _enqueue_row(invoker, session_id="second-consumer", status="waiting")
    references = MediaReferences(images={"cached.png"}, videos={"cached.mp4"})
    assert service.hold_cached_media("first-consumer", references)
    assert service.hold_cached_media("second-consumer", references)
    started = service.start_operation(
        IntermediatesOperationRequest(preview_id=preview.preview_id, idempotency_key="before-cache-hit"), ALICE
    )
    protected = _wait(service, started.operation_id)
    assert protected.progress.retained_images == protected.progress.retained_videos == 1

    with invoker.services.image_records._db.transaction() as cursor:
        cursor.execute("UPDATE session_queue SET status = 'completed' WHERE item_id = ?", (first,))
    preview, _ = _run(service, ALICE, _owner("alice"), mode=mode)
    assert preview.impact.keep_active_images == preview.impact.keep_active_videos == 1
    with invoker.services.image_records._db.transaction() as cursor:
        cursor.execute("UPDATE session_queue SET status = 'canceled' WHERE item_id = ?", (second,))
    _, completed = _run(service, ALICE, _owner("alice"), mode=mode)
    assert completed.progress.deleted_images == completed.progress.deleted_videos == 1


def test_missing_cached_media_does_not_leave_a_partial_hold(invoker, service):
    from invokeai.app.services.shared.media_references import MediaReferences

    _seed_image(invoker, "survivor.png")
    _enqueue_row(invoker, session_id="consumer", status="in_progress")
    assert not service.hold_cached_media(
        "consumer", MediaReferences(images={"survivor.png"}, videos={"already-deleted.mp4"})
    )
    _, completed = _run(service, ALICE, _owner("alice"))
    assert completed.progress.deleted_images == 1
