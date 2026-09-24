"""Storage queries of the intermediates manager.

One classification expression decides what every intermediate is under the cleanup policy, and it
is the same SQL whether it aggregates a summary, freezes a preview's targets or guards a delete:

- ``active``: produced or referenced by a pending, waiting or running queue item, or a
  completed child of an active root workflow.
- ``recent``: created inside the grace window, so an in-flight browser upload is never collected
  before it is promoted, referenced or enqueued; or a cached output whose consuming session ended
  inside that window, since a cache hit reuses an old row.
- ``referenced``: named by a saved document (`media_references`).
- ``safe``: none of the above.

Queue inputs are found by scanning each active item's stored session for media-name keys; the
scan is cached per item so a queue of a thousand pending items is parsed once, not per query.
"""

import json
import re
import sqlite3
from collections import defaultdict
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from typing import Collection, Iterable, Iterator, Literal, NamedTuple, Optional, Sequence, cast

from pydantic import BaseModel

from invokeai.app.services.intermediates.intermediates_common import (
    BROWSER_HOLD_TTL_SECONDS,
    MAX_BROWSER_HOLD_EDITORS_PER_USER,
    RECENT_GRACE_SECONDS,
    IntermediatesCleanupMode,
    IntermediatesKindCounts,
    IntermediatesOperation,
    IntermediatesScopeTarget,
)
from invokeai.app.services.shared.intermediate_delete import IntermediateDeleteGuard
from invokeai.app.services.shared.media_references import IMAGE_NAME_KEYS, VIDEO_NAME_KEYS, MediaReferences
from invokeai.app.services.shared.sqlite.sqlite_database import SqliteDatabase

MediaKind = Literal["image", "video"]
Classification = Literal["safe", "referenced", "active", "recent"]

ACTIVE_QUEUE_STATUSES = ("pending", "in_progress", "waiting")


def _protected_queue_items_sql() -> str:
    statuses = ", ".join(f"'{status}'" for status in ACTIVE_QUEUE_STATUSES)
    # A child becomes completed before its outputs reach its waiting parent. Keep the
    # whole completed subtree protected until the root finishes, including nested calls.
    # CROSS JOIN pins the active roots first, then indexed child lookups, rather than
    # scanning all completed history. Session JSON is fetched only for changed rows.
    return f"""
        SELECT item_id, session_id, status, session_revision FROM session_queue
        WHERE status IN ({statuses})
        UNION ALL
        SELECT child.item_id, child.session_id, child.status, child.session_revision
        FROM session_queue root
        CROSS JOIN session_queue child ON child.root_item_id = root.item_id
        WHERE root.status IN ({statuses}) AND child.status = 'completed'
    """


# Keeps the OR-chain of a selection scope, and every IN list, under SQLITE_MAX_VARIABLE_NUMBER.
_MAX_SQL_VARIABLES = 500
_TARGETS_PER_STATEMENT = 200


def _name_pattern(keys: frozenset[str]) -> re.Pattern[str]:
    alternatives = "|".join(sorted(re.escape(key) for key in keys))
    return re.compile(rf'"(?:{alternatives})"\s*:\s*"([^"\\]{{1,255}})"')


_IMAGE_NAME_RE = _name_pattern(IMAGE_NAME_KEYS)
_VIDEO_NAME_RE = _name_pattern(VIDEO_NAME_KEYS)

_TABLES: dict[MediaKind, tuple[str, str, str]] = {
    "image": ("images", "image_name", "image_subfolder"),
    "video": ("videos", "video_name", "video_subfolder"),
}


def _utc_now() -> datetime:
    return datetime.now(timezone.utc)


def _sql_timestamp(moment: datetime) -> str:
    """The text `STRFTIME('%Y-%m-%d %H:%M:%f', ...)` stores, so bound instants compare with stored ones as strings."""
    return moment.strftime("%Y-%m-%d %H:%M:%S.") + f"{moment.microsecond // 1000:03d}"


class _Clock(NamedTuple):
    """One instant for every statement of a classification: SQLite fixes `'NOW'` per statement, not per transaction."""

    now: str
    recent_cutoff: str


def _clock() -> _Clock:
    now = _utc_now()
    return _Clock(_sql_timestamp(now), _sql_timestamp(now - timedelta(seconds=RECENT_GRACE_SECONDS)))


def _lease_holder(lease_id: str) -> str:
    """The editor a lease belongs to: one tab holds several leases named `<holder>.<part>`."""
    return lease_id.split(".", 1)[0]


_HOLDER_SQL = "CASE WHEN INSTR(lease_id, '.') > 0 THEN SUBSTR(lease_id, 1, INSTR(lease_id, '.') - 1) ELSE lease_id END"


class ReferenceOwner(NamedTuple):
    """A saved document naming a media item, as `media_references` keys it."""

    owner_kind: str
    user_id: str
    owner_id: str


# Media name → the documents naming it.
ReferenceOwners = dict[str, set[ReferenceOwner]]


@dataclass(frozen=True)
class IntermediateCandidate:
    name: str
    classification: Classification
    file_size_bytes: Optional[int]


def _add_count(counts: IntermediatesKindCounts, classification: Classification, n: int) -> None:
    if classification == "safe":
        counts.safe += n
    elif classification == "referenced":
        counts.referenced += n
    elif classification == "active":
        counts.active += n
    else:
        counts.recent += n


@dataclass
class ScopeCounts:
    """Aggregated intermediates of one (owner, project) row for one media kind."""

    counts: IntermediatesKindCounts = field(default_factory=IntermediatesKindCounts)
    safe_bytes: int = 0
    referenced_bytes: int = 0
    unknown_size_count: int = 0


@dataclass
class ScopeClassification:
    """A preview's scope classified once, on one transaction, so its counts and targets agree."""

    # (owner, project) rows holding any intermediate in scope.
    rows: set[tuple[str, Optional[str]]] = field(default_factory=set)
    counts: dict[MediaKind, IntermediatesKindCounts] = field(
        default_factory=lambda: {"image": IntermediatesKindCounts(), "video": IntermediatesKindCounts()}
    )
    # Eligible intermediates, bounded; ``has_more`` says whether the bound cut any off.
    candidates: dict[MediaKind, list[IntermediateCandidate]] = field(default_factory=lambda: {"image": [], "video": []})
    has_more: bool = False
    # Documents naming each referenced candidate; only read for a force clear.
    reference_owners: dict[MediaKind, ReferenceOwners] = field(default_factory=lambda: {"image": {}, "video": {}})


class OperationReceipt(BaseModel):
    """The persisted receipt of an operation (`intermediates_operations.state_json`)."""

    dto: IntermediatesOperation
    caller_is_admin: bool
    allowed_user_ids: Optional[list[str]]


@dataclass
class StoredOperation:
    """An operation restored at startup: its receipt and the targets it left unresolved."""

    user_id: str
    preview_id: Optional[str]
    idempotency_key: Optional[str]
    receipt: OperationReceipt
    unresolved: dict[MediaKind, dict[str, Optional[int]]]
    confirmed_references: dict[MediaKind, ReferenceOwners]


# (kind, name, size, confirmed reference owners) of one unresolved operation target.
OperationTarget = tuple[MediaKind, str, Optional[int], set[ReferenceOwner]]


class IntermediatesRecordsSqlite:
    def __init__(self, db: SqliteDatabase) -> None:
        self._db = db
        # Media names an active queue item's session names, keyed by item id and stamped with the
        # row's session revision, which a trigger bumps on every session rewrite: a session
        # rewritten while the item stays active (a workflow-call parent resuming with its child's
        # outputs) is re-scanned, a status change alone is not. Entries live as long as the item is
        # active. This cache is derived from committed rows only, so it is safe across a
        # rolled-back transaction; the temp table is not, which is why it is rebuilt on every call
        # rather than skipped on an unchanged set.
        self._active_inputs: dict[int, tuple[int, set[str], set[str]]] = {}

    @staticmethod
    def _prepare_session_holds(cursor: sqlite3.Cursor, clock: _Clock) -> None:
        # These holds share the cache's process lifetime. After restart the cache is empty and
        # recovered queue sessions protect their serialized inputs through the normal scan.
        # A cache hit reuses an old row, so the recency grace a fresh output gets is counted from
        # when the consuming session is first seen finished instead.
        cursor.execute(
            "CREATE TEMP TABLE IF NOT EXISTS intermediates_session_media "
            "(session_id TEXT, kind TEXT, name TEXT, released_at TEXT, PRIMARY KEY(session_id, kind, name)) "
            "WITHOUT ROWID;"
        )
        cursor.execute(
            "UPDATE temp.intermediates_session_media SET released_at = ? "
            "WHERE released_at IS NULL AND session_id NOT IN "
            f"(SELECT session_id FROM ({_protected_queue_items_sql()}));",
            (clock.now,),
        )
        cursor.execute("DELETE FROM temp.intermediates_session_media WHERE released_at <= ?;", (clock.recent_cutoff,))

    def hold_cached_media(self, session_id: str, references: MediaReferences) -> bool:
        if references.is_empty():
            return True
        with self._db.transaction() as cursor:
            self._prepare_session_holds(cursor, _clock())
            statuses = ", ".join(f"'{status}'" for status in ACTIVE_QUEUE_STATUSES)
            cursor.execute(
                f"SELECT 1 FROM session_queue WHERE session_id = ? AND status IN ({statuses});", (session_id,)
            )
            if cursor.fetchone() is None:
                return False
            held: list[tuple[str, str, str]] = []
            for kind, names in (("image", references.images), ("video", references.videos)):
                table, name_column, _ = _TABLES[cast(MediaKind, kind)]
                ordered = sorted(names)
                for start in range(0, len(ordered), _MAX_SQL_VARIABLES):
                    chunk = ordered[start : start + _MAX_SQL_VARIABLES]
                    placeholders = ",".join("?" for _ in chunk)
                    cursor.execute(f"SELECT COUNT(*) FROM {table} WHERE {name_column} IN ({placeholders});", chunk)
                    if cursor.fetchone()[0] != len(chunk):
                        # Deletion won the race after the cache lookup. Do not return a stale
                        # output; invoking the node again will create fresh media instead.
                        return False
                held.extend((session_id, kind, name) for name in ordered)
            # The existence check and hold commit share the deleting transaction's lock. Cleanup
            # either deletes first (a cache miss), or observes this active session's hold.
            cursor.executemany("INSERT OR REPLACE INTO temp.intermediates_session_media VALUES (?, ?, ?, NULL);", held)
        return True

    def replace_browser_hold(self, user_id: str, lease_id: str, images: Sequence[str], videos: Sequence[str]) -> None:
        with self._db.transaction() as cursor:
            # Indexed on expires_at, so the sweep touches only what expired.
            cursor.execute(
                "DELETE FROM intermediates_browser_holds WHERE expires_at <= STRFTIME('%Y-%m-%d %H:%M:%f', 'NOW');"
            )
            cursor.execute(
                "DELETE FROM intermediates_browser_holds WHERE user_id = ? AND lease_id = ?;", (user_id, lease_id)
            )
            cursor.execute("CREATE TEMP TABLE IF NOT EXISTS intermediates_hold_names (name TEXT PRIMARY KEY);")
            for kind, names in (("image", images), ("video", videos)):
                cursor.execute("DELETE FROM temp.intermediates_hold_names;")
                cursor.executemany(
                    "INSERT OR IGNORE INTO temp.intermediates_hold_names(name) VALUES (?);",
                    [(name,) for name in names],
                )
                table, name_column, _ = _TABLES[cast(MediaKind, kind)]
                cursor.execute(
                    f"""--sql
                    INSERT INTO intermediates_browser_holds
                    (user_id, lease_id, media_kind, media_name, expires_at)
                    SELECT ?, ?, ?, m.{name_column},
                           STRFTIME('%Y-%m-%d %H:%M:%f', 'NOW', '+{BROWSER_HOLD_TTL_SECONDS} seconds')
                    FROM {table} m
                    JOIN temp.intermediates_hold_names h ON h.name = m.{name_column}
                    WHERE m.user_id = ? AND m.is_intermediate = TRUE;
                    """,
                    (user_id, lease_id, kind, user_id),
                )
            # Past the cap, every lease of the editors refreshed longest ago stops protecting its
            # media; an editor that is still open restores its leases on its next refresh. Leases
            # are grouped on the user's primary-key range first, so only their ids reach the holder
            # grouping.
            cursor.execute(
                f"""--sql
                WITH leases AS (
                    SELECT lease_id, {_HOLDER_SQL} AS holder, MAX(expires_at) AS refreshed
                    FROM intermediates_browser_holds
                    WHERE user_id = ?
                    GROUP BY lease_id
                ), lapsed AS (
                    SELECT holder FROM leases
                    WHERE holder != ?
                    GROUP BY holder
                    ORDER BY MAX(refreshed) DESC, holder
                    LIMIT -1 OFFSET ?
                )
                DELETE FROM intermediates_browser_holds
                WHERE user_id = ? AND lease_id IN (SELECT lease_id FROM leases WHERE holder IN lapsed);
                """,
                (user_id, _lease_holder(lease_id), MAX_BROWSER_HOLD_EDITORS_PER_USER - 1, user_id),
            )

    def release_browser_hold(self, user_id: str, lease_id: str) -> None:
        with self._db.transaction() as cursor:
            cursor.execute(
                "DELETE FROM intermediates_browser_holds WHERE user_id = ? AND lease_id = ?;", (user_id, lease_id)
            )

    def load_operations(self) -> tuple[list[StoredOperation], list[tuple[str, Exception]]]:
        """Every persisted operation, and the ids of rows that could not be read with why.

        An unreadable row is reported rather than raised, so one bad receipt cannot stop startup;
        its rows stay in place for inspection.
        """
        with self._db.transaction() as cursor:
            cursor.execute(
                "SELECT operation_id, caller_user_id, preview_id, idempotency_key, state_json "
                "FROM intermediates_operations ORDER BY created_at, operation_id;"
            )
            operations = cursor.fetchall()
            cursor.execute(
                "SELECT operation_id, media_kind, media_name, size_bytes, confirmed_refs_json "
                "FROM intermediates_operation_targets;"
            )
            targets: dict[str, list[tuple[str, str, Optional[int], str]]] = defaultdict(list)
            for operation_id, kind, name, size, refs in cursor.fetchall():
                targets[str(operation_id)].append((str(kind), str(name), size, str(refs)))
        loaded: list[StoredOperation] = []
        failures: list[tuple[str, Exception]] = []
        for operation_id, user, preview, key, state_json in operations:
            try:
                stored = StoredOperation(
                    user_id=str(user),
                    preview_id=preview,
                    idempotency_key=key,
                    receipt=OperationReceipt.model_validate_json(state_json),
                    unresolved={"image": {}, "video": {}},
                    confirmed_references={"image": {}, "video": {}},
                )
                for kind, name, size, refs_json in targets.get(str(operation_id), []):
                    if kind not in ("image", "video"):
                        raise ValueError(f"Unknown media kind {kind!r}")
                    media_kind = cast(MediaKind, kind)
                    stored.unresolved[media_kind][name] = size
                    refs = {ReferenceOwner(*ref) for ref in json.loads(refs_json)}
                    if refs:
                        stored.confirmed_references[media_kind][name] = refs
            except (ValueError, TypeError) as error:
                failures.append((str(operation_id), error))
                continue
            loaded.append(stored)
        return loaded, failures

    def save_operation(
        self,
        caller_user_id: str,
        receipt: OperationReceipt,
        *,
        preview_id: Optional[str] = None,
        idempotency_key: Optional[str] = None,
        linked_operation: Optional[OperationReceipt] = None,
        targets: Optional[Sequence[OperationTarget]] = None,
        resolved_targets: Optional[tuple[MediaKind, Sequence[str]]] = None,
    ) -> None:
        operation_id = receipt.dto.operation_id
        state = receipt.model_dump(mode="json")
        target_rows = (
            [(operation_id, kind, name, size, json.dumps(sorted(refs))) for kind, name, size, refs in targets]
            if targets is not None
            else None
        )
        linked = (
            (linked_operation.dto.operation_id, linked_operation.model_dump_json())
            if linked_operation is not None
            else None
        )
        with self._db.transaction() as cursor:
            cursor.execute(
                "INSERT INTO intermediates_operations "
                "(operation_id, caller_user_id, preview_id, idempotency_key, state_json, created_at) "
                "VALUES (?, ?, ?, ?, ?, ?) "
                "ON CONFLICT(operation_id) DO UPDATE SET state_json = excluded.state_json;",
                (
                    operation_id,
                    caller_user_id,
                    preview_id,
                    idempotency_key,
                    json.dumps(state),
                    state["dto"]["created_at"],
                ),
            )
            if target_rows is not None:
                cursor.executemany(
                    "INSERT INTO intermediates_operation_targets "
                    "(operation_id, media_kind, media_name, size_bytes, confirmed_refs_json) VALUES (?, ?, ?, ?, ?);",
                    target_rows,
                )
            if resolved_targets is not None:
                kind, names = resolved_targets
                cursor.executemany(
                    "DELETE FROM intermediates_operation_targets "
                    "WHERE operation_id = ? AND media_kind = ? AND media_name = ?;",
                    [(operation_id, kind, name) for name in names],
                )
            if linked is not None:
                linked_id, linked_state_json = linked
                cursor.execute(
                    "UPDATE intermediates_operations SET state_json = ? WHERE operation_id = ?;",
                    (linked_state_json, linked_id),
                )
                cursor.execute("DELETE FROM intermediates_operation_targets WHERE operation_id = ?;", (linked_id,))

    def delete_operations(self, operation_ids: Sequence[str]) -> None:
        if not operation_ids:
            return
        with self._db.transaction() as cursor:
            cursor.executemany(
                "DELETE FROM intermediates_operation_targets WHERE operation_id = ?;",
                [(name,) for name in operation_ids],
            )
            cursor.executemany(
                "DELETE FROM intermediates_operations WHERE operation_id = ?;", [(name,) for name in operation_ids]
            )

    # region policy expression

    @staticmethod
    def _classification_sql(kind: MediaKind) -> str:
        """Binds a `_Clock`'s two fields, in order, ahead of any later parameters of the statement."""
        table, name_column, _ = _TABLES[kind]
        return f"""
            CASE
                WHEN (
                    m.session_id IS NOT NULL
                    AND m.session_id IN (SELECT session_id FROM ({_protected_queue_items_sql()}))
                ) OR m.{name_column} IN (
                    SELECT name FROM temp.intermediates_active_media WHERE kind = '{kind}'
                ) OR EXISTS (
                    SELECT 1 FROM intermediates_browser_holds h
                    WHERE h.media_kind = '{kind}' AND h.media_name = m.{name_column}
                      AND h.expires_at > ?
                ) THEN 'active'
                WHEN m.created_at > ?
                    OR m.{name_column} IN (
                        SELECT name FROM temp.intermediates_session_media
                        WHERE kind = '{kind}' AND released_at IS NOT NULL
                    ) THEN 'recent'
                WHEN EXISTS (
                    SELECT 1 FROM media_references r WHERE r.media_kind = '{kind}' AND r.media_name = m.{name_column}
                ) THEN 'referenced'
                ELSE 'safe'
            END
        """

    def _prepare(self, cursor: sqlite3.Cursor) -> _Clock:
        """Makes the transaction's view of active work current, and returns the instant its classifications use.

        Runs on the caller's transaction so a classification and the enqueue it might race are
        ordered by the database lock, never by a stale cache.
        """
        clock = _clock()
        self._prepare_session_holds(cursor, clock)
        cursor.execute(
            """--sql
            CREATE TEMP TABLE IF NOT EXISTS intermediates_active_media (
                kind TEXT NOT NULL,
                name TEXT NOT NULL,
                PRIMARY KEY (kind, name)
            ) WITHOUT ROWID;
            """
        )
        cursor.execute(
            f"""--sql
            SELECT item_id, COALESCE(session_revision, 0)
            FROM ({_protected_queue_items_sql()});
            """
        )
        active = {cast(int, row[0]): cast(int, row[1]) for row in cursor.fetchall()}

        for stale in [item_id for item_id in self._active_inputs if item_id not in active]:
            del self._active_inputs[stale]
        changed = [
            item_id
            for item_id, stamp in active.items()
            if item_id not in self._active_inputs or self._active_inputs[item_id][0] != stamp
        ]
        for start in range(0, len(changed), _MAX_SQL_VARIABLES):
            chunk = changed[start : start + _MAX_SQL_VARIABLES]
            placeholders = ",".join("?" for _ in chunk)
            cursor.execute(
                f"""--sql
                SELECT item_id, COALESCE(session_revision, 0), session
                FROM session_queue WHERE item_id IN ({placeholders});
                """,
                chunk,
            )
            for item_id, stamp, session_json in cursor.fetchall():
                session_text = session_json if isinstance(session_json, str) else ""
                self._active_inputs[cast(int, item_id)] = (
                    cast(int, stamp),
                    set(_IMAGE_NAME_RE.findall(session_text)),
                    set(_VIDEO_NAME_RE.findall(session_text)),
                )

        cursor.execute("DELETE FROM temp.intermediates_active_media;")
        rows: set[tuple[str, str]] = set()
        for _, images, videos in self._active_inputs.values():
            rows.update(("image", name) for name in images)
            rows.update(("video", name) for name in videos)
        if rows:
            cursor.executemany(
                "INSERT OR IGNORE INTO temp.intermediates_active_media (kind, name) VALUES (?, ?);", sorted(rows)
            )
        cursor.execute(
            "INSERT OR IGNORE INTO temp.intermediates_active_media (kind, name) "
            "SELECT kind, name FROM temp.intermediates_session_media WHERE released_at IS NULL;"
        )
        return clock

    # endregion

    # region summary

    @classmethod
    def _scoped_sql(cls, kind: MediaKind) -> str:
        """Every intermediate of ``kind`` with its row and classification; callers append ``AND`` scope filters.

        Media whose project no longer exists, or that never had one, belong to the owner's
        unassigned row (``project_key`` NULL).
        """
        table, name_column, _ = _TABLES[kind]
        return f"""
            SELECT m.{name_column} AS name, m.user_id AS user_id,
                   CASE WHEN p.project_id IS NULL THEN NULL ELSE m.project_id END AS project_key,
                   m.file_size_bytes AS file_size_bytes,
                   {cls._classification_sql(kind)} AS cls
            FROM {table} m
            LEFT JOIN projects p ON p.user_id = m.user_id AND p.project_id = m.project_id
            WHERE m.is_intermediate = TRUE
        """

    @classmethod
    def _aggregate(
        cls, cursor: sqlite3.Cursor, clock: _Clock, kind: MediaKind, scope_clause: str, params: Sequence[object]
    ) -> Iterator[tuple[str, Optional[str], Classification, int, int, int]]:
        """(owner, project, classification, count, measured bytes, unmeasured count) groups within a scope."""
        cursor.execute(
            f"""--sql
            SELECT user_id, project_key, cls, COUNT(*),
                   SUM(COALESCE(file_size_bytes, 0)),
                   SUM(CASE WHEN file_size_bytes IS NULL THEN 1 ELSE 0 END)
            FROM ({cls._scoped_sql(kind)} {scope_clause})
            GROUP BY user_id, project_key, cls;
            """,
            [*clock, *params],
        )
        for owner, project_key, classification, n, total_bytes, unknown in cursor.fetchall():
            yield (
                cast(str, owner),
                cast(Optional[str], project_key),
                cast(Classification, classification),
                cast(int, n),
                cast(int, total_bytes),
                cast(int, unknown),
            )

    def summarize(
        self, user_ids: Optional[Collection[str]], kinds: Sequence[MediaKind] = ("image", "video")
    ) -> dict[tuple[str, Optional[str]], dict[MediaKind, ScopeCounts]]:
        """Aggregates the ``kinds`` intermediates of ``user_ids`` (None: everyone) by (owner, project) and classification."""
        rows: dict[tuple[str, Optional[str]], dict[MediaKind, ScopeCounts]] = defaultdict(
            lambda: {"image": ScopeCounts(), "video": ScopeCounts()}
        )
        owners = sorted(user_ids) if user_ids is not None else None
        # Owner chunks partition the GROUP BY, so their rows never need merging.
        clauses: list[tuple[str, list[object]]] = (
            [
                (f"AND m.user_id IN ({','.join('?' for _ in chunk)})", list(chunk))
                for chunk in (
                    owners[start : start + _MAX_SQL_VARIABLES] for start in range(0, len(owners), _MAX_SQL_VARIABLES)
                )
            ]
            if owners is not None
            else [("", [])]
        )
        with self._db.transaction() as cursor:
            clock = self._prepare(cursor)
            for kind in kinds:
                for clause, params in clauses:
                    for owner, project_key, cls, n, total_bytes, unknown in self._aggregate(
                        cursor, clock, kind, clause, params
                    ):
                        scope = rows[(owner, project_key)][kind]
                        _add_count(scope.counts, cls, n)
                        if cls == "safe":
                            scope.safe_bytes += total_bytes
                            scope.unknown_size_count += unknown
                        elif cls == "referenced":
                            scope.referenced_bytes += total_bytes
                            scope.unknown_size_count += unknown
        return dict(rows)

    def get_projects(self, user_id: Optional[str]) -> dict[tuple[str, str], tuple[str, Optional[str]]]:
        """Maps (owner, project) to (name, cover image): the newest durable image on the project's board."""
        owner_filter = "WHERE p.user_id = ?" if user_id is not None else ""
        params: list[object] = [user_id] if user_id is not None else []
        with self._db.transaction() as cursor:
            cursor.execute(
                f"""--sql
                SELECT p.user_id, p.project_id, p.name,
                    (
                        SELECT bi.image_name FROM board_images bi
                        INNER JOIN images i ON i.image_name = bi.image_name
                        WHERE bi.board_id = p.board_id AND i.is_intermediate = FALSE
                        ORDER BY bi.created_at DESC LIMIT 1
                    )
                FROM projects p {owner_filter};
                """,
                params,
            )
            return {
                (cast(str, r[0]), cast(str, r[1])): (cast(str, r[2]), cast(Optional[str], r[3]))
                for r in cursor.fetchall()
            }

    def has_unmeasured_intermediates(self) -> bool:
        with self._db.transaction() as cursor:
            cursor.execute(
                "CREATE TEMP TABLE IF NOT EXISTS intermediates_unmeasurable "
                "(kind TEXT, name TEXT, PRIMARY KEY(kind, name));"
            )
            for kind, (table, name_column, _) in _TABLES.items():
                cursor.execute(
                    f"SELECT 1 FROM {table} m WHERE m.is_intermediate = TRUE AND m.file_size_bytes IS NULL "
                    f"AND NOT EXISTS (SELECT 1 FROM temp.intermediates_unmeasurable u "
                    f"WHERE u.kind = ? AND u.name = m.{name_column}) LIMIT 1;",
                    (kind,),
                )
                if cursor.fetchone() is not None:
                    return True
        return False

    def next_unmeasured(self, kind: MediaKind, limit: int, *, min_age_seconds: int = 0) -> list[tuple[str, str]]:
        """Unmeasured intermediates in insertion order; rows younger than ``min_age_seconds`` are left for later.

        A row is written before its file, so a brand-new one would measure as missing. Failures
        are held in a temporary table instead of a bounded IN list, so later rows remain reachable.
        """
        table, name_column, subfolder_column = _TABLES[kind]
        with self._db.transaction() as cursor:
            cursor.execute(
                "CREATE TEMP TABLE IF NOT EXISTS intermediates_unmeasurable (kind TEXT, name TEXT, PRIMARY KEY(kind, name));"
            )
            cursor.execute(
                f"""--sql
                SELECT m.{name_column}, m.{subfolder_column} FROM {table} m
                WHERE m.is_intermediate = TRUE AND m.file_size_bytes IS NULL
                  AND m.created_at <= STRFTIME('%Y-%m-%d %H:%M:%f', 'NOW', ?)
                  AND NOT EXISTS (SELECT 1 FROM temp.intermediates_unmeasurable u
                                  WHERE u.kind = ? AND u.name = m.{name_column})
                ORDER BY m.rowid ASC
                LIMIT ?;
                """,
                [f"-{min_age_seconds} seconds", kind, limit],
            )
            return [(cast(str, r[0]), cast(str, r[1])) for r in cursor.fetchall()]

    def mark_unmeasurable(self, kind: MediaKind, names: Sequence[str]) -> None:
        if not names:
            return
        with self._db.transaction() as cursor:
            cursor.execute(
                "CREATE TEMP TABLE IF NOT EXISTS intermediates_unmeasurable (kind TEXT, name TEXT, PRIMARY KEY(kind, name));"
            )
            cursor.executemany(
                "INSERT OR IGNORE INTO temp.intermediates_unmeasurable(kind, name) VALUES (?, ?);",
                [(kind, name) for name in names],
            )

    # endregion

    # region candidates

    @classmethod
    def _scope_clauses(
        cls, *, user_id: Optional[str], targets: Optional[Sequence[IntermediatesScopeTarget]]
    ) -> list[tuple[str, list[object]]]:
        """``AND`` filters (with their parameters) that together cover a scope; each stays under the variable limit."""
        if targets is not None:
            clauses: list[tuple[str, list[object]]] = []
            for start in range(0, len(targets), _TARGETS_PER_STATEMENT):
                predicate, params = cls._scope_predicate(targets[start : start + _TARGETS_PER_STATEMENT])
                if predicate:
                    clauses.append((f"AND ({predicate})", params))
            return clauses
        if user_id is not None:
            return [("AND m.user_id = ?", [user_id])]
        return [("", [])]

    @staticmethod
    def _scope_predicate(targets: Sequence[IntermediatesScopeTarget]) -> tuple[str, list[object]]:
        clauses: list[str] = []
        params: list[object] = []
        for target in targets:
            if target.project_id is None:
                clauses.append("(m.user_id = ? AND p.project_id IS NULL)")
                params.append(target.user_id)
            else:
                clauses.append("(m.user_id = ? AND m.project_id = ? AND p.project_id IS NOT NULL)")
                params.extend((target.user_id, target.project_id))
        return " OR ".join(clauses), params

    def classify_scope(
        self,
        *,
        user_id: Optional[str],
        targets: Optional[Sequence[IntermediatesScopeTarget]],
        mode: IntermediatesCleanupMode,
        max_candidates: int,
    ) -> ScopeClassification:
        """Counts every intermediate in scope and freezes up to ``max_candidates`` eligible ones, images first.

        ``targets`` narrows to selected rows; otherwise ``user_id`` narrows to an owner, and None
        means everyone. One transaction, one instant and one view of active work serve every figure, so a
        preview's kept counts and its targets cannot disagree.
        """
        clauses = self._scope_clauses(user_id=user_id, targets=targets)
        eligible = "('safe', 'referenced')" if mode == "force" else "('safe')"
        result = ScopeClassification()
        remaining = max_candidates
        with self._db.transaction() as cursor:
            clock = self._prepare(cursor)
            for media_kind in _TABLES:
                candidates = result.candidates[media_kind]
                for clause, params in clauses:
                    for owner, project_key, cls, n, _, _ in self._aggregate(cursor, clock, media_kind, clause, params):
                        result.rows.add((owner, project_key))
                        _add_count(result.counts[media_kind], cls, n)
                    if len(candidates) > remaining:
                        continue
                    cursor.execute(
                        f"SELECT name, cls, file_size_bytes FROM ({self._scoped_sql(media_kind)} {clause}) "
                        f"WHERE cls IN {eligible} LIMIT ?;",
                        [*clock, *params, remaining + 1 - len(candidates)],
                    )
                    candidates.extend(self._to_candidates(cursor.fetchall()))
                if len(candidates) > remaining:
                    result.has_more = True
                    del candidates[remaining:]
                remaining -= len(candidates)
                if mode == "force":
                    result.reference_owners[media_kind] = self._reference_owners(
                        cursor, media_kind, [c.name for c in candidates if c.classification == "referenced"]
                    )
        return result

    def page_intermediates(
        self, kind: MediaKind, *, after_rowid: int, limit: int
    ) -> tuple[list[IntermediateCandidate], Optional[int]]:
        """One page of every intermediate in insertion order, classified, and the rowid to resume after.

        Paging by rowid classifies each row once however many are kept, where re-querying for the
        next safe batch would re-classify every kept row in front of it. None means no rows remain.
        """
        table, name_column, _ = _TABLES[kind]
        with self._db.transaction() as cursor:
            clock = self._prepare(cursor)
            cursor.execute(
                f"""--sql
                SELECT m.rowid, m.{name_column}, {self._classification_sql(kind)}, m.file_size_bytes
                FROM {table} m
                WHERE m.is_intermediate = TRUE AND m.rowid > ?
                ORDER BY m.rowid
                LIMIT ?;
                """,
                (*clock, after_rowid, limit),
            )
            rows = cursor.fetchall()
        if not rows:
            return [], None
        return self._to_candidates(row[1:] for row in rows), cast(int, rows[-1][0])

    @staticmethod
    def _to_candidates(rows: Iterable[Sequence[object]]) -> list[IntermediateCandidate]:
        return [
            IntermediateCandidate(
                name=cast(str, row[0]),
                classification=cast(Classification, row[1]),
                file_size_bytes=cast(Optional[int], row[2]),
            )
            for row in rows
        ]

    @staticmethod
    def _reference_owners(cursor: sqlite3.Cursor, kind: MediaKind, names: Sequence[str]) -> ReferenceOwners:
        owners: ReferenceOwners = {}
        for start in range(0, len(names), _MAX_SQL_VARIABLES - 1):
            chunk = list(names[start : start + _MAX_SQL_VARIABLES - 1])
            placeholders = ",".join("?" for _ in chunk)
            cursor.execute(
                f"SELECT media_name, owner_kind, user_id, owner_id FROM media_references "
                f"WHERE media_kind = ? AND media_name IN ({placeholders});",
                [kind, *chunk],
            )
            for name, owner_kind, user_id, owner_id in cursor.fetchall():
                owners.setdefault(str(name), set()).add(ReferenceOwner(str(owner_kind), str(user_id), str(owner_id)))
        return owners

    def get_document_names(self, owners: Iterable[ReferenceOwner]) -> dict[ReferenceOwner, str]:
        """Names of the referencing documents, one query per kind and chunk; client state has none."""
        queries = {
            "project": "SELECT user_id, project_id, name FROM projects WHERE project_id IN ({});",
            "quarantined_project": (
                "SELECT user_id, project_id, name FROM orphaned_projects_2026_08_06 WHERE project_id IN ({});"
            ),
            # Workflow ids are globally unique, so the owner is not part of the match.
            "workflow": "SELECT NULL, workflow_id, name FROM workflow_library WHERE workflow_id IN ({});",
        }
        wanted: dict[str, set[ReferenceOwner]] = defaultdict(set)
        for owner in owners:
            if owner.owner_kind in queries:
                wanted[owner.owner_kind].add(owner)
        names: dict[ReferenceOwner, str] = {}
        with self._db.transaction() as cursor:
            for owner_kind, kind_owners in wanted.items():
                ids = sorted({owner.owner_id for owner in kind_owners})
                found: dict[tuple[Optional[str], str], str] = {}
                for start in range(0, len(ids), _MAX_SQL_VARIABLES):
                    chunk = ids[start : start + _MAX_SQL_VARIABLES]
                    cursor.execute(queries[owner_kind].format(",".join("?" for _ in chunk)), chunk)
                    for user_id, owner_id, name in cursor.fetchall():
                        if name is not None:
                            found[(cast(Optional[str], user_id), cast(str, owner_id))] = cast(str, name)
                for owner in kind_owners:
                    name = found.get((None if owner_kind == "workflow" else owner.user_id, owner.owner_id))
                    if name is not None:
                        names[owner] = name
        return names

    # endregion

    # region delete guard

    def make_delete_guard(
        self,
        kind: MediaKind,
        *,
        mode: IntermediatesCleanupMode,
        allowed_user_ids: Optional[frozenset[str]],
        confirmed_references: Optional[ReferenceOwners] = None,
    ) -> IntermediateDeleteGuard:
        """The final check of a cleanup batch, run on the deleting transaction.

        Re-applies the policy to the frozen targets at the moment of deletion: anything that became
        active, referenced (safe mode) or non-intermediate since the preview is kept, as is anything
        that left the authorized accounts. ``allowed_user_ids`` None means every account.
        """
        table, name_column, _ = _TABLES[kind]
        deletable = "('safe')" if mode == "safe" else "('safe', 'referenced')"

        def guard(cursor: sqlite3.Cursor, names: Sequence[str]) -> list[str]:
            clock = self._prepare(cursor)
            kept: list[str] = []
            for start in range(0, len(names), _MAX_SQL_VARIABLES):
                chunk = list(names[start : start + _MAX_SQL_VARIABLES])
                placeholders = ",".join("?" for _ in chunk)
                current_references = self._reference_owners(cursor, kind, chunk) if mode == "force" else {}
                cursor.execute(
                    f"""--sql
                    SELECT name, user_id FROM (
                        SELECT m.{name_column} AS name, m.user_id AS user_id,
                               {self._classification_sql(kind)} AS cls
                        FROM {table} m
                        WHERE m.{name_column} IN ({placeholders}) AND m.is_intermediate = TRUE
                    ) WHERE cls IN {deletable};
                    """,
                    [*clock, *chunk],
                )
                # Ownership is re-read here rather than trusted from the preview.
                kept.extend(
                    cast(str, row[0])
                    for row in cursor.fetchall()
                    if allowed_user_ids is None or cast(str, row[1]) in allowed_user_ids
                    if mode != "force"
                    or current_references.get(cast(str, row[0]), set()).issubset(
                        (confirmed_references or {}).get(cast(str, row[0]), set())
                    )
                )
            return kept

        return guard

    # endregion
