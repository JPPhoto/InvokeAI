"""The intermediates cleanup engine.

Previews freeze the exact targets a confirmation will act on; nothing created afterwards can join
an operation. Operations run on one background worker in bounded batches, and every batch
re-applies the policy on the deleting transaction, so a target that became active, referenced or
durable since the preview is kept. Operation receipts and unresolved targets persist; a restart
makes interrupted work retryable.

Lock order, for anyone adding a caller: image mutation lock (image service) → database lock. The
queue and document writers take only the database lock, so no cycle is possible.
"""

import json
import logging
import queue
import threading
import time
import uuid
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from typing import Callable, Optional, Sequence, cast

from invokeai.app.services.intermediates.intermediates_base import IntermediatesCaller, IntermediatesServiceBase
from invokeai.app.services.intermediates.intermediates_common import (
    PREVIEW_TTL_SECONDS,
    RECENT_GRACE_SECONDS,
    IntermediatesAffectedDocument,
    IntermediatesBrowserHoldRequest,
    IntermediatesCleanupMode,
    IntermediatesIdempotencyConflictError,
    IntermediatesImpact,
    IntermediatesOperation,
    IntermediatesOperationNotFoundError,
    IntermediatesOperationProgress,
    IntermediatesOperationRequest,
    IntermediatesPreview,
    IntermediatesPreviewNotFoundError,
    IntermediatesPreviewRequest,
    IntermediatesRow,
    IntermediatesScope,
    IntermediatesScopeForbiddenError,
    IntermediatesScopeInvalidError,
    IntermediatesScopeTarget,
    IntermediatesSummary,
    IntermediatesSummarySort,
    IntermediatesSummaryTotals,
    IntermediatesUnavailableError,
)
from invokeai.app.services.intermediates.intermediates_records_sqlite import (
    AffectedReference,
    IntermediateCandidate,
    IntermediatesRecordsSqlite,
    MediaKind,
    ScopeCounts,
)
from invokeai.app.services.invoker import Invoker
from invokeai.app.services.shared.intermediate_delete import IntermediateDeleteGuard, IntermediateDeleteResult
from invokeai.app.services.shared.media_references import MediaReferences

DELETE_BATCH_SIZE = 200
MEASURE_BATCH_SIZE = 200
# A row is written before its file; measuring it a moment later would record a missing file.
MEASURE_MIN_AGE_SECONDS = 10
MAX_RETAINED_OPERATIONS = 100
MAX_RETAINED_TARGETS = 500_000
MAX_ACTIVE_OPERATIONS = 8
MAX_OPERATION_TARGETS = 50_000
MAX_PREVIEWS = 200
# Frozen (name, size) pairs held across every live preview; the oldest previews expire first.
MAX_FROZEN_PREVIEW_TARGETS = 500_000
PROGRESS_EVENT_INTERVAL_SECONDS = 1.0
WORKER_STOP_TIMEOUT_SECONDS = 10.0


def _now() -> datetime:
    return datetime.now(timezone.utc)


@dataclass
class _Preview:
    dto: IntermediatesPreview
    caller_user_id: str
    # Frozen targets with the size known at preview time; sizes are what an operation reclaims.
    targets: dict[MediaKind, list[tuple[str, Optional[int]]]]
    allowed_user_ids: Optional[frozenset[str]]
    confirmed_references: dict[MediaKind, dict[str, set[tuple[str, str, str]]]]


@dataclass
class _Operation:
    dto: IntermediatesOperation
    caller: IntermediatesCaller
    targets: dict[MediaKind, list[tuple[str, Optional[int]]]]
    allowed_user_ids: Optional[frozenset[str]]
    confirmed_references: dict[MediaKind, dict[str, set[tuple[str, str, str]]]] = field(
        default_factory=lambda: {"image": {}, "video": {}}
    )
    # Names whose deletion raised, or that were never attempted; a retry takes exactly these.
    unresolved: dict[MediaKind, dict[str, Optional[int]]] = field(default_factory=lambda: {"image": {}, "video": {}})
    last_progress_event_at: float = 0.0


class IntermediatesService(IntermediatesServiceBase):
    def __init__(self, records: IntermediatesRecordsSqlite, logger: Optional[logging.Logger] = None) -> None:
        self._records = records
        self._logger = logger or logging.getLogger(__name__)
        self._invoker: Optional[Invoker] = None
        self._lock = threading.Lock()
        self._previews: dict[str, _Preview] = {}
        self._operations: dict[str, _Operation] = {}
        self._operation_order: list[str] = []
        self._idempotency: dict[tuple[str, str], tuple[str, str]] = {}
        self._pending: "queue.Queue[str]" = queue.Queue()
        self._measure_requested = threading.Event()
        self._stop = threading.Event()
        self._worker: Optional[threading.Thread] = None

    # region lifecycle

    def start(self, invoker: Invoker) -> None:
        self._invoker = invoker
        self._stop.clear()
        with self._lock:
            for user_id, preview_id, key, state in self._records.load_operations():
                dto = IntermediatesOperation.model_validate(state["dto"])
                unresolved = {cast(MediaKind, kind): dict(state["unresolved"][kind]) for kind in ("image", "video")}
                operation = _Operation(
                    dto=dto,
                    caller=IntermediatesCaller(user_id=user_id, is_admin=bool(state["caller_is_admin"])),
                    targets={"image": [], "video": []},
                    allowed_user_ids=(
                        frozenset(state["allowed_user_ids"]) if state["allowed_user_ids"] is not None else None
                    ),
                    confirmed_references={
                        cast(MediaKind, kind): {
                            name: {tuple(ref) for ref in refs}
                            for name, refs in state.get("confirmed_references", {}).get(kind, {}).items()
                        }
                        for kind in ("image", "video")
                    },
                    unresolved=unresolved,
                )
                if dto.status in ("pending", "running"):
                    dto.status = "failed"
                    dto.error = "Server restarted before cleanup finished; retry the remaining targets"
                    dto.completed_at = _now()
                    self._records.save_operation(dto.operation_id, user_id, self._operation_state(operation))
                self._operations[dto.operation_id] = operation
                self._operation_order.append(dto.operation_id)
                if key is not None and preview_id is not None:
                    self._idempotency[(user_id, key)] = (preview_id, dto.operation_id)
            self._prune_operations_locked()

    def stop(self, invoker: Optional[Invoker] = None) -> None:
        self._stop.set()
        worker = self._worker
        if worker is not None:
            self._pending.put("")
            worker.join(timeout=WORKER_STOP_TIMEOUT_SECONDS)
            if worker.is_alive():
                self._logger.warning("Intermediates worker did not stop in time")
            else:
                self._worker = None

    def _ensure_worker(self) -> None:
        """Spawned on first use: a process that never cleans up never pays for a polling thread."""
        with self._lock:
            if self._worker is not None and self._worker.is_alive():
                return
            if self._stop.is_set():
                return
            self._worker = threading.Thread(target=self._worker_loop, name="intermediates_worker", daemon=True)
            self._worker.start()

    @property
    def _services(self):
        assert self._invoker is not None, "IntermediatesService has not been started"
        return self._invoker.services

    # endregion

    # region summary

    def hold_cached_media(self, session_id: str, references: MediaReferences) -> bool:
        return self._records.hold_cached_media(session_id, references)

    def replace_browser_hold(
        self, caller: IntermediatesCaller, lease_id: str, request: IntermediatesBrowserHoldRequest
    ) -> None:
        self._records.replace_browser_hold(caller.user_id, lease_id, request.images, request.videos)

    def release_browser_hold(self, caller: IntermediatesCaller, lease_id: str) -> None:
        self._records.release_browser_hold(caller.user_id, lease_id)

    def get_summary(
        self,
        caller: IntermediatesCaller,
        *,
        owner_id: Optional[str],
        search: Optional[str],
        sort: IntermediatesSummarySort,
        descending: bool,
        offset: int,
        limit: int,
        project_id: Optional[str] = None,
    ) -> IntermediatesSummary:
        owner_filter = self._resolve_owner_filter(caller, owner_id)
        aggregated = self._records.summarize(owner_filter)
        projects = self._records.get_projects(owner_filter)
        users = self._services.users.get_many([user_id for user_id, _ in aggregated])

        rows: list[IntermediatesRow] = []
        for (user_id, row_project_id), kinds in aggregated.items():
            user = users.get(user_id)
            project = projects.get((user_id, row_project_id)) if row_project_id is not None else None
            rows.append(
                IntermediatesRow(
                    user_id=user_id,
                    project_id=row_project_id,
                    user_display_name=user.display_name if user is not None else None,
                    user_email=user.email if user is not None else None,
                    project_name=project[0] if project is not None else None,
                    cover_image_name=project[1] if project is not None else None,
                    images=kinds["image"].counts,
                    videos=kinds["video"].counts,
                    reclaimable_bytes=kinds["image"].safe_bytes + kinds["video"].safe_bytes,
                    referenced_bytes=kinds["image"].referenced_bytes + kinds["video"].referenced_bytes,
                    unknown_size_count=kinds["image"].unknown_size_count + kinds["video"].unknown_size_count,
                )
            )

        if project_id is not None:
            rows = [row for row in rows if row.project_id == project_id]
        if search:
            needle = search.casefold()
            rows = [row for row in rows if self._matches(row, needle, include_owner=caller.is_admin)]

        rows.sort(key=lambda row: (row.project_name or "").casefold())
        if sort == "reclaimable_bytes":
            rows.sort(key=lambda row: row.reclaimable_bytes, reverse=descending)
        elif descending:
            rows.reverse()

        totals = IntermediatesSummaryTotals(rows=len(rows))
        for row in rows:
            totals.safe_images += row.images.safe
            totals.safe_videos += row.videos.safe
            totals.in_use_images += row.images.total - row.images.safe
            totals.in_use_videos += row.videos.total - row.videos.safe
            totals.reclaimable_bytes += row.reclaimable_bytes
            totals.unknown_size_count += row.unknown_size_count

        measuring = self._records.has_unmeasured_intermediates()
        if measuring:
            self._measure_requested.set()
            self._ensure_worker()

        return IntermediatesSummary(
            items=rows[offset : offset + limit],
            total=len(rows),
            offset=offset,
            limit=limit,
            totals=totals,
            recent_grace_seconds=RECENT_GRACE_SECONDS,
            measuring=measuring,
            can_manage_everyone=caller.is_admin,
        )

    @staticmethod
    def _matches(row: IntermediatesRow, needle: str, *, include_owner: bool) -> bool:
        haystacks = [row.project_name or ""]
        if include_owner:
            haystacks.extend([row.user_display_name or "", row.user_email or ""])
        return any(needle in value.casefold() for value in haystacks)

    @staticmethod
    def _resolve_owner_filter(caller: IntermediatesCaller, owner_id: Optional[str]) -> Optional[str]:
        if not caller.is_admin:
            if owner_id is not None and owner_id != caller.user_id:
                raise IntermediatesScopeForbiddenError("Only administrators can inspect other accounts")
            return caller.user_id
        return owner_id

    # endregion

    # region previews

    def create_preview(self, request: IntermediatesPreviewRequest, caller: IntermediatesCaller) -> IntermediatesPreview:
        scope = request.scope
        allowed = self._authorize_scope(scope, caller)
        candidates, has_more_eligible = self._collect_candidates(scope, request.mode)
        counts = self._records.summarize(scope.user_id if scope.kind == "owner" else None)
        if scope.kind == "selection":
            selected_rows = {(target.user_id, target.project_id) for target in scope.targets}
            counts = {row: kinds for row, kinds in counts.items() if row in selected_rows}

        impact = IntermediatesImpact()
        for kinds in counts.values():
            for kind in ("image", "video"):
                suffix = "images" if kind == "image" else "videos"
                scope_counts = kinds[cast(MediaKind, kind)].counts
                setattr(impact, f"keep_active_{suffix}", getattr(impact, f"keep_active_{suffix}") + scope_counts.active)
                setattr(impact, f"keep_recent_{suffix}", getattr(impact, f"keep_recent_{suffix}") + scope_counts.recent)
                if request.mode == "safe":
                    setattr(
                        impact,
                        f"keep_referenced_{suffix}",
                        getattr(impact, f"keep_referenced_{suffix}") + scope_counts.referenced,
                    )
        targets: dict[MediaKind, list[tuple[str, Optional[int]]]] = {"image": [], "video": []}
        for kind in ("image", "video"):
            media_kind = cast(MediaKind, kind)
            for candidate in candidates[media_kind]:
                self._tally(impact, media_kind, candidate, request.mode, targets)

        confirmed_references: dict[MediaKind, dict[str, set[tuple[str, str, str]]]] = {"image": {}, "video": {}}
        affected: list[IntermediatesAffectedDocument] = []
        hidden = 0
        if request.mode == "force":
            for kind in ("image", "video"):
                media_kind = cast(MediaKind, kind)
                confirmed_references[media_kind] = self._records.reference_owners(
                    media_kind, [name for name, _ in targets[media_kind]]
                )
            affected, hidden = self._describe_affected(confirmed_references, caller)

        created = _now()
        dto = IntermediatesPreview(
            preview_id=uuid.uuid4().hex,
            mode=request.mode,
            scope=scope,
            created_at=created,
            expires_at=created + timedelta(seconds=PREVIEW_TTL_SECONDS),
            target_rows=self._count_target_rows(scope, counts),
            impact=impact,
            has_more_eligible=has_more_eligible,
            affected_documents=affected,
            affected_documents_hidden=hidden,
        )
        with self._lock:
            self._previews[dto.preview_id] = _Preview(
                dto=dto,
                caller_user_id=caller.user_id,
                targets=targets,
                allowed_user_ids=allowed,
                confirmed_references=confirmed_references,
            )
            self._expire_previews_locked(created)
        return dto

    def _authorize_scope(self, scope: IntermediatesScope, caller: IntermediatesCaller) -> Optional[frozenset[str]]:
        """Returns the accounts the scope may touch, or None for every account."""
        if scope.kind == "everyone":
            if not caller.is_admin:
                raise IntermediatesScopeForbiddenError("Only administrators can clear everyone's intermediates")
            return None
        if scope.kind == "owner":
            if scope.user_id is None:
                raise IntermediatesScopeInvalidError("An owner scope names the account to clear")
            if scope.user_id != caller.user_id and not caller.is_admin:
                raise IntermediatesScopeForbiddenError("Only administrators can clear another account's intermediates")
            return frozenset({scope.user_id})
        if not scope.targets:
            raise IntermediatesScopeInvalidError("A selection scope names at least one row")
        owners = frozenset(target.user_id for target in scope.targets)
        if not caller.is_admin and owners != frozenset({caller.user_id}):
            raise IntermediatesScopeForbiddenError("Only administrators can clear another account's intermediates")
        return owners

    def _collect_candidates(
        self, scope: IntermediatesScope, mode: IntermediatesCleanupMode
    ) -> tuple[dict[MediaKind, list[IntermediateCandidate]], bool]:
        targets: Optional[Sequence[IntermediatesScopeTarget]] = None
        user_id: Optional[str] = None
        if scope.kind == "selection":
            # Duplicate rows would double-count; the order is irrelevant to the SQL.
            targets = list({(t.user_id, t.project_id): t for t in scope.targets}.values())
        elif scope.kind == "owner":
            user_id = scope.user_id
        images = self._records.list_candidates(
            "image", user_id=user_id, targets=targets, max_results=MAX_OPERATION_TARGETS, eligible_mode=mode
        )
        if len(images) > MAX_OPERATION_TARGETS:
            return {"image": images[:MAX_OPERATION_TARGETS], "video": []}, True
        remaining = MAX_OPERATION_TARGETS - len(images)
        videos = self._records.list_candidates(
            "video", user_id=user_id, targets=targets, max_results=remaining, eligible_mode=mode
        )
        has_more = len(videos) > remaining
        return {"image": images, "video": videos[:remaining]}, has_more

    @staticmethod
    def _count_target_rows(
        scope: IntermediatesScope, counts: dict[tuple[str, Optional[str]], dict[MediaKind, ScopeCounts]]
    ) -> int:
        """Rows (owner, project) the scope resolved to, counted the same way for every scope kind."""
        if scope.kind == "selection":
            return len({(t.user_id, t.project_id) for t in scope.targets})
        return len(counts)

    @staticmethod
    def _tally(
        impact: IntermediatesImpact,
        kind: MediaKind,
        candidate: IntermediateCandidate,
        mode: IntermediatesCleanupMode,
        targets: dict[MediaKind, list[tuple[str, Optional[int]]]],
    ) -> None:
        suffix = "images" if kind == "image" else "videos"
        deletable = candidate.classification == "safe" or (mode == "force" and candidate.classification == "referenced")
        if deletable:
            setattr(impact, f"delete_{suffix}", getattr(impact, f"delete_{suffix}") + 1)
            if candidate.file_size_bytes is None:
                impact.unknown_size_count += 1
            else:
                impact.reclaimable_bytes += candidate.file_size_bytes
            targets[kind].append((candidate.name, candidate.file_size_bytes))
        else:
            attribute = f"keep_{candidate.classification}_{suffix}"
            setattr(impact, attribute, getattr(impact, attribute) + 1)

    def _describe_affected(
        self,
        confirmed_references: dict[MediaKind, dict[str, set[tuple[str, str, str]]]],
        caller: IntermediatesCaller,
    ) -> tuple[list[IntermediatesAffectedDocument], int]:
        counts: dict[tuple[str, str, str], int] = {}
        for owners in confirmed_references.values():
            for refs_for_name in owners.values():
                for owner in refs_for_name:
                    counts[owner] = counts.get(owner, 0) + 1
        refs = [
            AffectedReference(kind, user_id, owner_id, count) for (kind, user_id, owner_id), count in counts.items()
        ]
        names = self._records.get_document_names(refs)
        visible: list[IntermediatesAffectedDocument] = []
        hidden = 0
        for ref in refs:
            if not caller.is_admin and ref.user_id != caller.user_id:
                hidden += 1
                continue
            visible.append(
                IntermediatesAffectedDocument(
                    kind=cast(str, ref.owner_kind),  # type: ignore[arg-type]
                    user_id=ref.user_id,
                    owner_id=ref.owner_id,
                    name=names.get((ref.owner_kind, ref.user_id, ref.owner_id)),
                    references=ref.references,
                )
            )
        visible.sort(key=lambda doc: (doc.kind, (doc.name or "").casefold(), doc.owner_id))
        return visible, hidden

    def _expire_previews_locked(self, now: datetime) -> None:
        expired = [pid for pid, preview in self._previews.items() if preview.dto.expires_at <= now]
        for pid in expired:
            del self._previews[pid]
        frozen = sum(len(p.targets["image"]) + len(p.targets["video"]) for p in self._previews.values())
        # Oldest first; the newest preview always survives so the caller who just asked can confirm.
        while len(self._previews) > 1 and (len(self._previews) > MAX_PREVIEWS or frozen > MAX_FROZEN_PREVIEW_TARGETS):
            oldest = next(iter(self._previews))
            frozen -= len(self._previews[oldest].targets["image"]) + len(self._previews[oldest].targets["video"])
            del self._previews[oldest]

    # endregion

    # region operations

    def start_operation(
        self, request: IntermediatesOperationRequest, caller: IntermediatesCaller
    ) -> IntermediatesOperation:
        with self._lock:
            key = (caller.user_id, request.idempotency_key)
            settled = self._idempotency.get(key)
            if settled is not None:
                # A replay creates no work, so it is answered even while cleanup is unavailable.
                settled_preview_id, operation_id = settled
                if settled_preview_id != request.preview_id:
                    raise IntermediatesIdempotencyConflictError("Idempotency key was used for a different preview")
                return self._operations[operation_id].dto.model_copy(deep=True)

            self._require_cleanup_available()
            if (
                sum(op.dto.status in ("pending", "running") for op in self._operations.values())
                >= MAX_ACTIVE_OPERATIONS
            ):
                raise IntermediatesUnavailableError("Too many cleanup operations are already running")
            self._expire_previews_locked(_now())
            preview = self._previews.get(request.preview_id)
            if preview is None or preview.caller_user_id != caller.user_id:
                raise IntermediatesPreviewNotFoundError("Preview expired or unknown; request a new one")
            # Single use: a second confirmation of the same preview must go through a new preview.
            del self._previews[request.preview_id]

            operation = self._register_operation_locked(
                caller=caller,
                mode=preview.dto.mode,
                scope=preview.dto.scope,
                targets=preview.targets,
                allowed_user_ids=preview.allowed_user_ids,
                confirmed_references=preview.confirmed_references,
                retried_from=None,
            )
            try:
                self._records.save_operation(
                    operation.dto.operation_id,
                    caller.user_id,
                    self._operation_state(operation),
                    preview_id=request.preview_id,
                    idempotency_key=request.idempotency_key,
                    targets=self._operation_target_rows(operation),
                )
            except Exception:
                self._operations.pop(operation.dto.operation_id)
                self._operation_order.remove(operation.dto.operation_id)
                self._previews[request.preview_id] = preview
                raise
            self._idempotency[key] = (request.preview_id, operation.dto.operation_id)
            self._prune_operations_locked()
        self._enqueue(operation)
        return operation.dto.model_copy(deep=True)

    def get_operation(self, operation_id: str, caller: IntermediatesCaller) -> IntermediatesOperation:
        with self._lock:
            operation = self._operations.get(operation_id)
            if operation is None or (operation.caller.user_id != caller.user_id and not caller.is_admin):
                raise IntermediatesOperationNotFoundError(operation_id)
            return operation.dto.model_copy(deep=True)

    def retry_operation(self, operation_id: str, caller: IntermediatesCaller) -> IntermediatesOperation:
        with self._lock:
            original = self._operations.get(operation_id)
            if original is None or (original.caller.user_id != caller.user_id and not caller.is_admin):
                raise IntermediatesOperationNotFoundError(operation_id)
            if original.dto.status not in ("completed", "failed"):
                raise IntermediatesUnavailableError("The operation is still running")
            if original.dto.retried_by_operation_id is not None:
                # A duplicated retry request (lost response, double click) must not run the same
                # targets twice; the retry that already took them over is the answer.
                existing_retry = self._operations[original.dto.retried_by_operation_id]
                if existing_retry.caller.user_id != caller.user_id and not caller.is_admin:
                    raise IntermediatesUnavailableError("Another account already retried this operation")
                return existing_retry.dto.model_copy(deep=True)
            self._require_cleanup_available()
            if (
                sum(op.dto.status in ("pending", "running") for op in self._operations.values())
                >= MAX_ACTIVE_OPERATIONS
            ):
                raise IntermediatesUnavailableError("Too many cleanup operations are already running")
            unresolved = {kind: list(names.items()) for kind, names in original.unresolved.items()}
            if not unresolved["image"] and not unresolved["video"]:
                raise IntermediatesUnavailableError("The operation has nothing left to retry")
            # A retry is authorized as the retrying caller, never as the original one.
            self._authorize_scope(original.dto.scope, caller)
            operation = self._register_operation_locked(
                caller=caller,
                mode=original.dto.mode,
                scope=original.dto.scope,
                targets=unresolved,
                allowed_user_ids=original.allowed_user_ids,
                confirmed_references=original.confirmed_references,
                retried_from=operation_id,
            )
            original.dto.retried_by_operation_id = operation.dto.operation_id
            try:
                self._records.save_operation(
                    operation.dto.operation_id,
                    caller.user_id,
                    self._operation_state(operation),
                    linked_operation=(operation_id, self._operation_state(original)),
                    targets=self._operation_target_rows(operation),
                )
            except Exception:
                self._operations.pop(operation.dto.operation_id)
                self._operation_order.remove(operation.dto.operation_id)
                original.dto.retried_by_operation_id = None
                raise
            original.unresolved = {"image": {}, "video": {}}
            original.confirmed_references = {"image": {}, "video": {}}
            self._prune_operations_locked()
        self._enqueue(operation)
        return operation.dto.model_copy(deep=True)

    def _register_operation_locked(
        self,
        *,
        caller: IntermediatesCaller,
        mode: IntermediatesCleanupMode,
        scope: IntermediatesScope,
        targets: dict[MediaKind, list[tuple[str, Optional[int]]]],
        allowed_user_ids: Optional[frozenset[str]],
        confirmed_references: dict[MediaKind, dict[str, set[tuple[str, str, str]]]],
        retried_from: Optional[str],
    ) -> _Operation:
        dto = IntermediatesOperation(
            operation_id=uuid.uuid4().hex,
            user_id=caller.user_id,
            mode=mode,
            scope=scope,
            status="pending",
            created_at=_now(),
            target_images=len(targets["image"]),
            target_videos=len(targets["video"]),
            progress=IntermediatesOperationProgress(
                unresolved_images=len(targets["image"]), unresolved_videos=len(targets["video"])
            ),
            retried_from_operation_id=retried_from,
        )
        operation = _Operation(
            dto=dto,
            caller=caller,
            targets={"image": list(targets["image"]), "video": list(targets["video"])},
            allowed_user_ids=allowed_user_ids,
            confirmed_references={kind: dict(owners) for kind, owners in confirmed_references.items()},
            unresolved={"image": dict(targets["image"]), "video": dict(targets["video"])},
        )
        self._operations[dto.operation_id] = operation
        self._operation_order.append(dto.operation_id)
        return operation

    @staticmethod
    def _operation_state(operation: _Operation) -> dict:
        return {
            "dto": operation.dto.model_dump(mode="json"),
            "caller_is_admin": operation.caller.is_admin,
            "allowed_user_ids": sorted(operation.allowed_user_ids) if operation.allowed_user_ids is not None else None,
        }

    @staticmethod
    def _operation_target_rows(operation: _Operation) -> list[tuple[str, str, Optional[int], str]]:
        return [
            (kind, name, size, json.dumps(sorted(operation.confirmed_references[kind].get(name, set()))))
            for kind, names in operation.unresolved.items()
            for name, size in names.items()
        ]

    def _prune_operations_locked(self) -> None:
        evicted: list[str] = []
        retained_order = list(self._operation_order)
        unresolved_count = sum(
            len(operation.unresolved["image"]) + len(operation.unresolved["video"])
            for operation in self._operations.values()
        )
        while len(retained_order) > MAX_RETAINED_OPERATIONS or unresolved_count > MAX_RETAINED_TARGETS:
            oldest = None
            for operation_id in retained_order:
                candidate = self._operations[operation_id]
                retry_id = candidate.dto.retried_by_operation_id
                retry = self._operations.get(retry_id) if retry_id is not None else None
                if candidate.dto.status in ("completed", "failed") and (
                    retry is None or retry.dto.status not in ("pending", "running")
                ):
                    oldest = operation_id
                    break
            if oldest is None:
                break
            retained_order.remove(oldest)
            removed = self._operations[oldest]
            unresolved_count -= len(removed.unresolved["image"]) + len(removed.unresolved["video"])
            evicted.append(oldest)
        try:
            self._records.delete_operations(evicted)
        except Exception as error:
            self._logger.warning(f"Could not prune old intermediates operations: {error}")
            return
        self._operation_order = retained_order
        for operation_id in evicted:
            self._operations.pop(operation_id)
        evicted_set = set(evicted)
        self._idempotency = {k: v for k, v in self._idempotency.items() if v[1] not in evicted_set}

    def _enqueue(self, operation: _Operation) -> None:
        self._ensure_worker()
        self._pending.put(operation.dto.operation_id)
        # Events carry snapshots: the worker mutates the live DTO as soon as it dequeues the id.
        self._services.events.emit_intermediates_operation_changed(operation.dto.model_copy(deep=True))

    def _require_cleanup_available(self) -> None:
        image_moves = getattr(self._services, "image_moves", None)
        if image_moves is not None and image_moves.is_maintenance_active():
            raise IntermediatesUnavailableError("Image storage maintenance is active")

    # endregion

    # region legacy

    def clear_all_images_now(self, caller: IntermediatesCaller) -> int:
        if not caller.is_admin:
            raise IntermediatesScopeForbiddenError("Only admins can clear all intermediates")
        candidates = self._records.list_candidates("image", user_id=None, targets=None)
        names = [c.name for c in candidates if c.classification == "safe"]
        guard = self._records.make_delete_guard("image", mode="safe", allowed_user_ids=None)
        deleted = 0
        for start in range(0, len(names), DELETE_BATCH_SIZE):
            result = self._services.images.delete_intermediates_by_names(
                names[start : start + DELETE_BATCH_SIZE], guard
            )
            deleted += len(result.deleted_names)
        return deleted

    # endregion

    # region worker

    def _worker_loop(self) -> None:
        while not self._stop.is_set():
            try:
                operation_id = self._pending.get(timeout=0.5)
            except queue.Empty:
                if self._measure_requested.is_set():
                    self._measure_once()
                continue
            if not operation_id:
                continue
            with self._lock:
                operation = self._operations.get(operation_id)
            if operation is not None:
                try:
                    self._run(operation)
                except Exception as error:  # pragma: no cover - defensive: the worker must survive
                    self._logger.error(f"Intermediates operation {operation_id} crashed: {error}", exc_info=True)
                    try:
                        self._finish(operation, error=str(error))
                    except Exception as finish_error:
                        # A failed receipt write must not strand the rest of the accepted queue.
                        # The target rows remain durable and are retryable after a restart.
                        self._logger.error(
                            f"Could not persist failure for intermediates operation {operation_id}: {finish_error}",
                            exc_info=True,
                        )

    def _run(self, operation: _Operation) -> None:
        with self._lock:
            operation.dto.status = "running"
            operation.dto.started_at = _now()
            self._records.save_operation(
                operation.dto.operation_id, operation.caller.user_id, self._operation_state(operation)
            )
        self._services.events.emit_intermediates_operation_changed(operation.dto.model_copy(deep=True))

        deleters: dict[MediaKind, Callable[[list[str], IntermediateDeleteGuard], IntermediateDeleteResult]] = {
            "image": self._services.images.delete_intermediates_by_names,
            "video": self._services.videos.delete_intermediates_by_names,
        }
        for kind in ("image", "video"):
            media_kind = cast(MediaKind, kind)
            targets = operation.targets[media_kind]
            guard = self._records.make_delete_guard(
                media_kind,
                mode=operation.dto.mode,
                allowed_user_ids=operation.allowed_user_ids,
                confirmed_references=operation.confirmed_references[media_kind],
            )
            for start in range(0, len(targets), DELETE_BATCH_SIZE):
                batch = targets[start : start + DELETE_BATCH_SIZE]
                halt = self._halt_reason(operation)
                if halt is not None:
                    self._finish(operation, error=halt)
                    return
                sizes = dict(batch)
                names = [name for name, _ in batch]
                try:
                    result = deleters[media_kind](names, guard)
                except Exception as error:
                    self._logger.error(f"Intermediates cleanup batch failed ({kind}): {error}", exc_info=True)
                    self._record_batch(operation, media_kind, batch, deleted=[], deferred=[], failed=names, sizes=sizes)
                    continue
                self._record_batch(
                    operation,
                    media_kind,
                    batch,
                    deleted=result.deleted_names,
                    deferred=result.purge_deferred,
                    failed=[],
                    sizes=sizes,
                )
        self._finish(operation, error=None)

    def _halt_reason(self, operation: _Operation) -> Optional[str]:
        if self._stop.is_set():
            return "The server is shutting down"
        image_moves = getattr(self._services, "image_moves", None)
        if image_moves is not None and image_moves.is_maintenance_active():
            return "Image storage maintenance started"
        # Single-user mode has no accounts to re-check: every request is the local administrator,
        # and the `system` row that names it is deliberately not an admin.
        if not self._services.configuration.multiuser:
            return None
        # Authorization is re-read per batch: an account demoted, deactivated or deleted
        # mid-operation stops deleting at the next batch boundary.
        user = self._services.users.get(operation.caller.user_id)
        if user is None or not user.is_active:
            return "The confirming account is no longer active"
        if operation.allowed_user_ids != frozenset({operation.caller.user_id}) and not user.is_admin:
            return "The confirming account no longer administers this instance"
        return None

    def _record_batch(
        self,
        operation: _Operation,
        kind: MediaKind,
        batch: list[tuple[str, Optional[int]]],
        *,
        deleted: Sequence[str],
        deferred: Sequence[str],
        failed: Sequence[str],
        sizes: dict[str, Optional[int]],
    ) -> None:
        suffix = "images" if kind == "image" else "videos"
        deleted_set = set(deleted)
        deferred_set = set(deferred)
        failed_set = set(failed)
        with self._lock:
            progress = operation.dto.progress
            names = [name for name, _ in batch]
            setattr(progress, f"processed_{suffix}", getattr(progress, f"processed_{suffix}") + len(names))
            setattr(progress, f"deleted_{suffix}", getattr(progress, f"deleted_{suffix}") + len(deleted_set))
            setattr(progress, f"failed_{suffix}", getattr(progress, f"failed_{suffix}") + len(failed_set))
            retained = len(names) - len(deleted_set) - len(failed_set)
            setattr(progress, f"retained_{suffix}", getattr(progress, f"retained_{suffix}") + retained)
            for name in deleted_set:
                if name in deferred_set:
                    progress.pending_disk_cleanup += 1
                    continue
                size = sizes.get(name)
                if size is None:
                    progress.unknown_size_count += 1
                else:
                    progress.reclaimed_bytes += size
            unresolved = operation.unresolved[kind]
            for name in names:
                if name not in failed_set:
                    unresolved.pop(name, None)
                    operation.confirmed_references[kind].pop(name, None)
            setattr(progress, f"unresolved_{suffix}", len(unresolved))
            self._records.save_operation(
                operation.dto.operation_id,
                operation.caller.user_id,
                self._operation_state(operation),
                resolved_targets=(kind, [name for name in names if name not in failed_set]),
            )
            # Progress events are coalesced; the final state always goes out from `_finish`.
            now = time.monotonic()
            if now - operation.last_progress_event_at < PROGRESS_EVENT_INTERVAL_SECONDS:
                return
            operation.last_progress_event_at = now
            snapshot = operation.dto.model_copy(deep=True)
        self._services.events.emit_intermediates_operation_changed(snapshot)

    def _finish(self, operation: _Operation, *, error: Optional[str]) -> None:
        with self._lock:
            operation.dto.status = "failed" if error is not None else "completed"
            operation.dto.error = error
            operation.dto.completed_at = _now()
            # Only the unresolved names matter after this point; the frozen list is the bulk of an
            # operation's memory and would otherwise live for as long as the operation is retained.
            operation.targets = {"image": [], "video": []}
            self._records.save_operation(
                operation.dto.operation_id, operation.caller.user_id, self._operation_state(operation)
            )
            self._prune_operations_locked()
            snapshot = operation.dto.model_copy(deep=True)
        self._services.events.emit_intermediates_operation_changed(snapshot)

    def _measure_once(self) -> None:
        """Measures a bounded batch of unmeasured intermediates; clears the request when none remain."""
        self._measure_requested.clear()
        image_moves = getattr(self._services, "image_moves", None)
        if image_moves is not None and image_moves.is_maintenance_active():
            # Files are being relocated; a measurement now could record a missing file as empty.
            return
        try:
            remaining = False
            for kind, files, records in (
                ("image", self._services.image_files, self._services.image_records),
                ("video", self._services.video_files, self._services.video_records),
            ):
                pending = self._records.next_unmeasured(
                    cast(MediaKind, kind),
                    MEASURE_BATCH_SIZE,
                    min_age_seconds=MEASURE_MIN_AGE_SECONDS,
                )
                sizes: dict[str, int] = {}
                unmeasurable: list[str] = []
                for name, subfolder in pending:
                    if self._stop.is_set():
                        return
                    try:
                        size = files.get_file_size_bytes(name, subfolder)
                    except Exception as error:
                        self._logger.warning(f"Could not measure {kind} {name}; skipping it until restart: {error}")
                        unmeasurable.append(name)
                        continue
                    # A missing file occupies nothing; recording 0 is a measurement, not a guess, and
                    # keeps the row from being re-measured forever.
                    sizes[name] = size if size is not None else 0
                self._records.mark_unmeasurable(cast(MediaKind, kind), unmeasurable)
                # One transaction per batch: a library of hundreds of thousands of intermediates is
                # measured in a few thousand commits rather than one per file.
                records.set_file_sizes_bytes(sizes)
                if len(pending) == MEASURE_BATCH_SIZE:
                    remaining = True
            if remaining:
                self._measure_requested.set()
                # Yield the database lock between batches so generation and saves keep flowing.
                time.sleep(0.05)
        except Exception as error:
            self._logger.warning(f"Measuring intermediate file sizes failed; will retry on demand: {error}")

    # endregion
