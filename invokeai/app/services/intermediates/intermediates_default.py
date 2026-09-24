"""The intermediates cleanup engine.

Previews freeze the exact targets a confirmation will act on; nothing created afterwards can join
an operation. Operations run on one background worker in bounded batches, and every batch
re-applies the policy on the deleting transaction, so a target that became active, referenced or
durable since the preview is kept. Operation receipts and unresolved targets persist; a restart
makes interrupted work retryable.

Lock order, for anyone adding a caller: image mutation lock or video deletion lock → database
lock. Image and video deletion never hold each other's locks; queue and document writers take
only the database lock.
"""

import logging
import queue
import threading
import time
import uuid
from collections import defaultdict
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from typing import Callable, Optional, Sequence, cast

from invokeai.app.services.intermediates.intermediates_base import IntermediatesCaller, IntermediatesServiceBase
from invokeai.app.services.intermediates.intermediates_common import (
    MAX_AFFECTED_DOCUMENTS,
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
from invokeai.app.services.intermediates.intermediates_measurement import IntermediatesSizeMeasurer
from invokeai.app.services.intermediates.intermediates_records_sqlite import (
    IntermediatesRecordsSqlite,
    MediaKind,
    OperationReceipt,
    OperationTarget,
    ReferenceOwner,
    ReferenceOwners,
)
from invokeai.app.services.invoker import Invoker
from invokeai.app.services.shared.intermediate_delete import IntermediateDeleteGuard, IntermediateDeleteResult
from invokeai.app.services.shared.media_references import MediaReferenceOwnerKind, MediaReferences

DELETE_BATCH_SIZE = 200
# Receipts and unresolved targets are budgeted per confirming account. Up to the global ceiling,
# which bounds memory, one account's interrupted cleanups never block another's; past it, ten
# accounts at their full budget refuse new cleanup for everyone until they retry.
MAX_RETAINED_OPERATIONS_PER_CALLER = 50
MAX_RETAINED_TARGETS_PER_CALLER = 100_000
MAX_RETAINED_TARGETS = 1_000_000
# Operations run one at a time; the per-account share keeps one account from filling the queue.
MAX_ACTIVE_OPERATIONS = 8
MAX_ACTIVE_OPERATIONS_PER_CALLER = 2
MAX_OPERATION_TARGETS = 50_000
MAX_PREVIEWS = 200
MAX_PREVIEWS_PER_CALLER = 4
# Frozen (name, size) pairs held across every live preview; the heaviest caller gives up previews first.
MAX_FROZEN_PREVIEW_TARGETS = 500_000
PROGRESS_EVENT_INTERVAL_SECONDS = 1.0
WORKER_STOP_TIMEOUT_SECONDS = 10.0


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _own_references(references: ReferenceOwners, user_id: str) -> ReferenceOwners:
    """Drops the confirmations of other accounts' documents, so the delete guard keeps their media."""
    return {name: {owner for owner in owners if owner.user_id == user_id} for name, owners in references.items()}


@dataclass
class _KindImpact:
    delete: int = 0
    keep_referenced: int = 0
    keep_active: int = 0
    keep_recent: int = 0


@dataclass
class _Preview:
    dto: IntermediatesPreview
    caller_user_id: str
    # Frozen targets with the size known at preview time; sizes are what an operation reclaims.
    targets: dict[MediaKind, list[tuple[str, Optional[int]]]]
    allowed_user_ids: Optional[frozenset[str]]
    confirmed_references: dict[MediaKind, ReferenceOwners]


@dataclass
class _Operation:
    dto: IntermediatesOperation
    caller: IntermediatesCaller
    targets: dict[MediaKind, list[tuple[str, Optional[int]]]]
    allowed_user_ids: Optional[frozenset[str]]
    confirmed_references: dict[MediaKind, ReferenceOwners] = field(default_factory=lambda: {"image": {}, "video": {}})
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
        self._stop = threading.Event()
        self._measurer = IntermediatesSizeMeasurer(records, lambda: self._services, self._stop, self._logger)
        self._worker: Optional[threading.Thread] = None

    # region lifecycle

    def start(self, invoker: Invoker) -> None:
        self._invoker = invoker
        self._stop.clear()
        self._measurer.reset()
        stored_operations, failures = self._records.load_operations()
        for operation_id, error in failures:
            self._logger.warning(f"Skipping unreadable intermediates operation {operation_id}: {error}")
        with self._lock:
            for stored in stored_operations:
                receipt = stored.receipt
                dto = receipt.dto
                operation = _Operation(
                    dto=dto,
                    caller=IntermediatesCaller(user_id=stored.user_id, is_admin=receipt.caller_is_admin),
                    targets={"image": [], "video": []},
                    allowed_user_ids=(
                        frozenset(receipt.allowed_user_ids) if receipt.allowed_user_ids is not None else None
                    ),
                    confirmed_references=stored.confirmed_references,
                    unresolved=stored.unresolved,
                )
                if dto.status in ("pending", "running"):
                    dto.status = "failed"
                    dto.error = "Server restarted before cleanup finished; retry the remaining targets"
                    dto.completed_at = _now()
                    self._records.save_operation(stored.user_id, self._receipt(operation))
                self._operations[dto.operation_id] = operation
                self._operation_order.append(dto.operation_id)
                if stored.idempotency_key is not None and stored.preview_id is not None:
                    self._idempotency[(stored.user_id, stored.idempotency_key)] = (stored.preview_id, dto.operation_id)
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
        aggregated = self._records.summarize([owner_filter] if owner_filter is not None else None)
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
            self._measurer.request()
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
        selection: Optional[list[IntermediatesScopeTarget]] = None
        if scope.kind == "selection":
            # Duplicate rows would double-count; the order is irrelevant to the SQL.
            selection = list({(t.user_id, t.project_id): t for t in scope.targets}.values())
        classified = self._records.classify_scope(
            user_id=scope.user_id if scope.kind == "owner" else None,
            targets=selection,
            mode=request.mode,
            max_candidates=MAX_OPERATION_TARGETS,
        )

        impact = IntermediatesImpact()
        kind_impacts: dict[MediaKind, _KindImpact] = {"image": _KindImpact(), "video": _KindImpact()}
        # Force mode confirms the documents it breaks. Another account's document is never the
        # caller's to break unless the caller administers the instance, so its media is kept.
        confirmed_references: dict[MediaKind, ReferenceOwners] = {"image": {}, "video": {}}
        targets: dict[MediaKind, list[tuple[str, Optional[int]]]] = {"image": [], "video": []}
        for media_kind, kind_impact in kind_impacts.items():
            counts = classified.counts[media_kind]
            kind_impact.keep_active = counts.active
            kind_impact.keep_recent = counts.recent
            if request.mode == "safe":
                kind_impact.keep_referenced = counts.referenced
            owners = classified.reference_owners[media_kind]
            for candidate in classified.candidates[media_kind]:
                references = owners.get(candidate.name, set())
                if candidate.classification == "referenced" and not (
                    caller.is_admin or all(owner.user_id == caller.user_id for owner in references)
                ):
                    kind_impact.keep_referenced += 1
                    continue
                kind_impact.delete += 1
                if candidate.file_size_bytes is None:
                    impact.unknown_size_count += 1
                else:
                    impact.reclaimable_bytes += candidate.file_size_bytes
                targets[media_kind].append((candidate.name, candidate.file_size_bytes))
                if references:
                    confirmed_references[media_kind][candidate.name] = references
        images, videos = kind_impacts["image"], kind_impacts["video"]
        impact.delete_images, impact.delete_videos = images.delete, videos.delete
        impact.keep_referenced_images, impact.keep_referenced_videos = images.keep_referenced, videos.keep_referenced
        impact.keep_active_images, impact.keep_active_videos = images.keep_active, videos.keep_active
        impact.keep_recent_images, impact.keep_recent_videos = images.keep_recent, videos.keep_recent
        affected, affected_total = self._describe_affected(confirmed_references) if request.mode == "force" else ([], 0)

        created = _now()
        dto = IntermediatesPreview(
            preview_id=uuid.uuid4().hex,
            mode=request.mode,
            scope=scope,
            created_at=created,
            expires_at=created + timedelta(seconds=PREVIEW_TTL_SECONDS),
            target_rows=len(selection) if selection is not None else len(classified.rows),
            impact=impact,
            has_more_eligible=classified.has_more,
            affected_documents=affected,
            affected_documents_total=affected_total,
        )
        with self._lock:
            self._previews[dto.preview_id] = _Preview(
                dto=dto,
                caller_user_id=caller.user_id,
                targets=targets,
                allowed_user_ids=allowed,
                confirmed_references=confirmed_references,
            )
            self._expire_previews_locked(created, keep=dto.preview_id)
        return dto

    def _authorize_scope(self, scope: IntermediatesScope, caller: IntermediatesCaller) -> Optional[frozenset[str]]:
        """Returns the accounts the scope may touch, or None for every account."""
        if scope.kind == "everyone":
            if not caller.is_admin:
                raise IntermediatesScopeForbiddenError("Only administrators can delete everyone's intermediates")
            return None
        if scope.kind == "owner":
            if scope.user_id is None:
                raise IntermediatesScopeInvalidError("An owner scope names the account whose intermediates to delete")
            if scope.user_id != caller.user_id and not caller.is_admin:
                raise IntermediatesScopeForbiddenError("Only administrators can delete another account's intermediates")
            return frozenset({scope.user_id})
        if not scope.targets:
            raise IntermediatesScopeInvalidError("A selection scope names at least one row")
        owners = frozenset(target.user_id for target in scope.targets)
        if not caller.is_admin and owners != frozenset({caller.user_id}):
            raise IntermediatesScopeForbiddenError("Only administrators can delete another account's intermediates")
        return owners

    def _describe_affected(
        self, confirmed_references: dict[MediaKind, ReferenceOwners]
    ) -> tuple[list[IntermediatesAffectedDocument], int]:
        """The documents a force clear breaks, bounded to the first few by kind and name, and how many there are."""
        counts: dict[ReferenceOwner, int] = defaultdict(int)
        for owners in confirmed_references.values():
            for refs_for_name in owners.values():
                for owner in refs_for_name:
                    counts[owner] += 1
        names = self._records.get_document_names(counts)
        ordered = sorted(
            counts, key=lambda owner: (owner.owner_kind, (names.get(owner) or "").casefold(), owner.owner_id)
        )[:MAX_AFFECTED_DOCUMENTS]
        users = self._services.users.get_many(sorted({owner.user_id for owner in ordered}))
        documents = [
            IntermediatesAffectedDocument(
                kind=cast(MediaReferenceOwnerKind, owner.owner_kind),
                user_id=owner.user_id,
                user_display_name=users[owner.user_id].display_name if owner.user_id in users else None,
                user_email=users[owner.user_id].email if owner.user_id in users else None,
                owner_id=owner.owner_id,
                name=names.get(owner),
                references=counts[owner],
            )
            for owner in ordered
        ]
        return documents, len(counts)

    def _expire_previews_locked(self, now: datetime, *, keep: Optional[str] = None) -> None:
        """Drops expired previews, then enforces the caps; ``keep`` (the one just created) always survives."""
        for pid in [pid for pid, preview in self._previews.items() if preview.dto.expires_at <= now]:
            del self._previews[pid]
        by_caller: dict[str, list[str]] = defaultdict(list)
        for pid, preview in self._previews.items():
            by_caller[preview.caller_user_id].append(pid)
        for pids in by_caller.values():
            for pid in [pid for pid in pids if pid != keep][: max(0, len(pids) - MAX_PREVIEWS_PER_CALLER)]:
                del self._previews[pid]

        # Past the global caps, the caller holding the most frozen targets gives up its oldest
        # preview first, so no account can evict another's pending confirmation by previewing.
        frozen: dict[str, int] = defaultdict(int)
        for preview in self._previews.values():
            frozen[preview.caller_user_id] += len(preview.targets["image"]) + len(preview.targets["video"])
        keep_caller = self._previews[keep].caller_user_id if keep in self._previews else None
        while len(self._previews) > MAX_PREVIEWS or sum(frozen.values()) > MAX_FROZEN_PREVIEW_TARGETS:
            evictable = [pid for pid in self._previews if pid != keep]
            if not evictable:
                break
            victim = max(
                evictable,
                key=lambda pid: (
                    frozen[self._previews[pid].caller_user_id],
                    # On a tie, the caller whose request overflowed the cap pays for it.
                    self._previews[pid].caller_user_id == keep_caller,
                ),
            )
            preview = self._previews.pop(victim)
            frozen[preview.caller_user_id] -= len(preview.targets["image"]) + len(preview.targets["video"])

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
            self._require_active_capacity_locked(caller.user_id)
            self._expire_previews_locked(_now())
            preview = self._previews.get(request.preview_id)
            if preview is None or preview.caller_user_id != caller.user_id:
                raise IntermediatesPreviewNotFoundError("Preview expired or unknown; request a new one")
            self._require_operation_capacity(
                caller.user_id, len(preview.targets["image"]) + len(preview.targets["video"])
            )
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
                    caller.user_id,
                    self._receipt(operation),
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
            existing_retry = (
                self._operations.get(original.dto.retried_by_operation_id)
                if original.dto.retried_by_operation_id is not None
                else None
            )
            if existing_retry is not None:
                # A duplicated retry request (lost response, double click) must not run the same
                # targets twice; the retry that already took them over is the answer.
                if existing_retry.caller.user_id != caller.user_id and not caller.is_admin:
                    raise IntermediatesUnavailableError("Another account already retried this operation")
                return existing_retry.dto.model_copy(deep=True)
            self._require_cleanup_available()
            self._require_active_capacity_locked(caller.user_id)
            unresolved = {kind: list(names.items()) for kind, names in original.unresolved.items()}
            if not unresolved["image"] and not unresolved["video"]:
                raise IntermediatesUnavailableError("The operation has nothing left to retry")
            # A retry is authorized as the retrying caller, never as the original one.
            self._authorize_scope(original.dto.scope, caller)
            self._require_operation_capacity(
                caller.user_id, len(unresolved["image"]) + len(unresolved["video"]), replacing=original
            )
            confirmed_references = original.confirmed_references
            if not caller.is_admin:
                confirmed_references = {
                    kind: _own_references(references, caller.user_id)
                    for kind, references in confirmed_references.items()
                }
            operation = self._register_operation_locked(
                caller=caller,
                mode=original.dto.mode,
                scope=original.dto.scope,
                targets=unresolved,
                allowed_user_ids=original.allowed_user_ids,
                confirmed_references=confirmed_references,
                retried_from=operation_id,
            )
            original.dto.retried_by_operation_id = operation.dto.operation_id
            try:
                self._records.save_operation(
                    caller.user_id,
                    self._receipt(operation),
                    linked_operation=self._receipt(original),
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
        confirmed_references: dict[MediaKind, ReferenceOwners],
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
    def _receipt(operation: _Operation) -> OperationReceipt:
        return OperationReceipt(
            dto=operation.dto,
            caller_is_admin=operation.caller.is_admin,
            allowed_user_ids=sorted(operation.allowed_user_ids) if operation.allowed_user_ids is not None else None,
        )

    @staticmethod
    def _operation_target_rows(operation: _Operation) -> list[OperationTarget]:
        return [
            (kind, name, size, operation.confirmed_references[kind].get(name, set()))
            for kind, names in operation.unresolved.items()
            for name, size in names.items()
        ]

    def _can_prune_operation_locked(self, operation: _Operation) -> bool:
        if operation.dto.status not in ("completed", "failed") or any(operation.unresolved.values()):
            return False
        retry_id = operation.dto.retried_by_operation_id
        retry = self._operations.get(retry_id) if retry_id is not None else None
        return retry is None or retry.dto.status not in ("pending", "running")

    def _require_active_capacity_locked(self, caller_user_id: str) -> None:
        active = [op for op in self._operations.values() if op.dto.status in ("pending", "running")]
        if sum(op.caller.user_id == caller_user_id for op in active) >= MAX_ACTIVE_OPERATIONS_PER_CALLER:
            raise IntermediatesUnavailableError("Wait for your running deletions to finish before starting another")
        if len(active) >= MAX_ACTIVE_OPERATIONS:
            raise IntermediatesUnavailableError("Too many cleanup operations are already running")

    def _require_operation_capacity(
        self, caller_user_id: str, incoming_targets: int, *, replacing: Optional[_Operation] = None
    ) -> None:
        """Refuses new work past the confirming account's budget; a retry hands its targets over rather than adding."""
        outstanding = 0
        caller_outstanding = 0
        caller_operations: list[_Operation] = []
        for operation in self._operations.values():
            if operation is replacing:
                continue
            unresolved = len(operation.unresolved["image"]) + len(operation.unresolved["video"])
            outstanding += unresolved
            if operation.caller.user_id == caller_user_id:
                caller_outstanding += unresolved
                caller_operations.append(operation)
        if (
            caller_outstanding + incoming_targets > MAX_RETAINED_TARGETS_PER_CALLER
            or outstanding + incoming_targets > MAX_RETAINED_TARGETS
        ):
            raise IntermediatesUnavailableError("Retry unresolved cleanup targets before starting more cleanup")
        if (
            replacing is None
            and len(caller_operations) >= MAX_RETAINED_OPERATIONS_PER_CALLER
            and not any(self._can_prune_operation_locked(operation) for operation in caller_operations)
        ):
            raise IntermediatesUnavailableError("Retry unresolved cleanup operations before starting more cleanup")

    def _prune_operations_locked(self) -> None:
        """Drops each account's oldest settled receipts past its budget; unresolved ones stay retryable.

        A retry takes the operations it retried with it, even another account's: they point at it
        and handed it everything they had left.
        """
        retained: dict[str, int] = defaultdict(int)
        for operation in self._operations.values():
            retained[operation.caller.user_id] += 1
        evicted: list[str] = []
        evicted_set: set[str] = set()
        for operation_id in self._operation_order:
            operation = self._operations[operation_id]
            if (
                operation_id in evicted_set
                or retained[operation.caller.user_id] <= MAX_RETAINED_OPERATIONS_PER_CALLER
                or not self._can_prune_operation_locked(operation)
            ):
                continue
            chain = [operation]
            previous_id = operation.dto.retried_from_operation_id
            while previous_id is not None and previous_id not in evicted_set:
                previous = self._operations.get(previous_id)
                if previous is None:
                    break
                chain.append(previous)
                previous_id = previous.dto.retried_from_operation_id
            if not all(self._can_prune_operation_locked(link) for link in chain):
                continue
            for link in chain:
                retained[link.caller.user_id] -= 1
                evicted.append(link.dto.operation_id)
                evicted_set.add(link.dto.operation_id)
        if not evicted:
            return
        try:
            self._records.delete_operations(evicted)
        except Exception as error:
            self._logger.warning(f"Could not prune old intermediates operations: {error}")
            return
        self._operation_order = [
            operation_id for operation_id in self._operation_order if operation_id not in evicted_set
        ]
        for operation_id in evicted:
            self._operations.pop(operation_id)
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
        guard = self._records.make_delete_guard("image", mode="safe", allowed_user_ids=None)
        deleted = 0
        after_rowid: Optional[int] = 0
        # Bounded pages keep memory flat however many intermediates exist; the guard re-checks each
        # batch on the deleting transaction.
        while after_rowid is not None:
            page, after_rowid = self._records.page_intermediates(
                "image", after_rowid=after_rowid, limit=DELETE_BATCH_SIZE
            )
            names = [candidate.name for candidate in page if candidate.classification == "safe"]
            if names:
                deleted += len(self._services.images.delete_intermediates_by_names(names, guard).deleted_names)
        return deleted

    def count_safe_images(self, caller: IntermediatesCaller) -> int:
        counts = self._records.summarize(None if caller.is_admin else [caller.user_id], kinds=("image",))
        return sum(kinds["image"].counts.safe for kinds in counts.values())

    # endregion

    # region worker

    def _worker_loop(self) -> None:
        while not self._stop.is_set():
            try:
                # Due measurement only takes the turns operations leave free, so it polls the queue
                # instead of waiting on it.
                if self._measurer.is_due():
                    operation_id = self._pending.get_nowait()
                else:
                    operation_id = self._pending.get(timeout=0.5)
            except queue.Empty:
                if self._measurer.is_due():
                    self._measurer.measure_once()
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
            self._records.save_operation(operation.caller.user_id, self._receipt(operation))
        self._services.events.emit_intermediates_operation_changed(operation.dto.model_copy(deep=True))

        deleters: dict[MediaKind, Callable[[list[str], IntermediateDeleteGuard], IntermediateDeleteResult]] = {
            "image": self._services.images.delete_intermediates_by_names,
            "video": self._services.videos.delete_intermediates_by_names,
        }
        for media_kind, deleter in deleters.items():
            targets = operation.targets[media_kind]
            for start in range(0, len(targets), DELETE_BATCH_SIZE):
                batch = targets[start : start + DELETE_BATCH_SIZE]
                halt, is_admin = self._batch_authority(operation)
                if halt is not None:
                    self._finish(operation, error=halt)
                    return
                sizes = dict(batch)
                names = [name for name, _ in batch]
                confirmed = operation.confirmed_references[media_kind]
                batch_references = {name: confirmed[name] for name in names if name in confirmed}
                if not is_admin:
                    batch_references = _own_references(batch_references, operation.caller.user_id)
                guard = self._records.make_delete_guard(
                    media_kind,
                    mode=operation.dto.mode,
                    allowed_user_ids=operation.allowed_user_ids,
                    confirmed_references=batch_references,
                )
                try:
                    result = deleter(names, guard)
                except Exception as error:
                    self._logger.error(f"Intermediates cleanup batch failed ({media_kind}): {error}", exc_info=True)
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

    def _batch_authority(self, operation: _Operation) -> tuple[Optional[str], bool]:
        """Why the next batch must not run, if it must not, and whether the confirmer administers the instance now."""
        if self._stop.is_set():
            return "The server is shutting down", False
        image_moves = getattr(self._services, "image_moves", None)
        if image_moves is not None and image_moves.is_maintenance_active():
            return "Image storage maintenance started", False
        # Single-user mode has no accounts to re-check: every request is the local administrator,
        # and the `system` row that names it is deliberately not an admin.
        if not self._services.configuration.multiuser:
            return None, operation.caller.is_admin
        # Authorization is re-read per batch: an account demoted, deactivated or deleted
        # mid-operation stops deleting at the next batch boundary, and a demoted one no longer
        # breaks other accounts' documents even inside its own scope.
        user = self._services.users.get(operation.caller.user_id)
        if user is None or not user.is_active:
            return "The confirming account is no longer active", False
        if operation.allowed_user_ids != frozenset({operation.caller.user_id}) and not user.is_admin:
            return "The confirming account no longer administers this instance", False
        return None, operation.caller.is_admin and user.is_admin

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
        deleted_set = set(deleted)
        deferred_set = set(deferred)
        failed_set = set(failed)
        with self._lock:
            progress = operation.dto.progress
            names = [name for name, _ in batch]
            retained = len(names) - len(deleted_set) - len(failed_set)
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
            if kind == "image":
                progress.processed_images += len(names)
                progress.deleted_images += len(deleted_set)
                progress.failed_images += len(failed_set)
                progress.retained_images += retained
                progress.unresolved_images = len(unresolved)
            else:
                progress.processed_videos += len(names)
                progress.deleted_videos += len(deleted_set)
                progress.failed_videos += len(failed_set)
                progress.retained_videos += retained
                progress.unresolved_videos = len(unresolved)
            self._records.save_operation(
                operation.caller.user_id,
                self._receipt(operation),
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
            self._records.save_operation(operation.caller.user_id, self._receipt(operation))
            self._prune_operations_locked()
            snapshot = operation.dto.model_copy(deep=True)
        self._services.events.emit_intermediates_operation_changed(snapshot)

    # endregion
