"""Storage queries of the intermediates manager.

One classification expression decides what every intermediate is under the cleanup policy, and it
is the same SQL whether it aggregates a summary, freezes a preview's targets or guards a delete:

- ``active``: produced by, or named as an input of, a pending, waiting or running queue item.
- ``recent``: created inside the grace window, so an in-flight browser upload is never collected
  before it is promoted, referenced or enqueued.
- ``referenced``: named by a saved project document or library workflow (`media_references`).
- ``safe``: none of the above.

Queue inputs are found by scanning each active item's stored session for media-name keys; the
scan is cached per item so a queue of a thousand pending items is parsed once, not per query.
"""

import re
import sqlite3
from collections import defaultdict
from dataclasses import dataclass, field
from typing import Iterable, Literal, Optional, Sequence, cast

from invokeai.app.services.intermediates.intermediates_common import (
    RECENT_GRACE_SECONDS,
    IntermediatesCleanupMode,
    IntermediatesKindCounts,
    IntermediatesScopeTarget,
)
from invokeai.app.services.shared.sqlite.sqlite_database import SqliteDatabase

MediaKind = Literal["image", "video"]
Classification = Literal["safe", "referenced", "active", "recent"]

ACTIVE_QUEUE_STATUSES = ("pending", "in_progress", "waiting")

# Keeps the OR-chain of a selection scope, and every IN list, under SQLITE_MAX_VARIABLE_NUMBER.
_MAX_SQL_VARIABLES = 500
_TARGETS_PER_STATEMENT = 200

_IMAGE_NAME_RE = re.compile(r'"(?:image_name|imageName)"\s*:\s*"([^"\\]{1,255})"')
_VIDEO_NAME_RE = re.compile(r'"(?:video_name|videoName)"\s*:\s*"([^"\\]{1,255})"')

_TABLES: dict[MediaKind, tuple[str, str, str]] = {
    "image": ("images", "image_name", "image_subfolder"),
    "video": ("videos", "video_name", "video_subfolder"),
}


@dataclass(frozen=True)
class IntermediateCandidate:
    name: str
    classification: Classification
    file_size_bytes: Optional[int]
    user_id: str
    # The row the candidate belongs to; None for the owner's unassigned row.
    project_id: Optional[str]


@dataclass
class ScopeCounts:
    """Aggregated intermediates of one (owner, project) row for one media kind."""

    counts: IntermediatesKindCounts = field(default_factory=IntermediatesKindCounts)
    safe_bytes: int = 0
    referenced_bytes: int = 0
    unknown_size_count: int = 0


@dataclass(frozen=True)
class AffectedReference:
    owner_kind: str
    user_id: str
    owner_id: str
    references: int


class IntermediatesRecordsSqlite:
    def __init__(self, db: SqliteDatabase) -> None:
        self._db = db
        # Media names an active queue item's session names, keyed by item id and stamped with the
        # row's status, status sequence, session length and updated_at: a session rewritten while
        # the item stays active (a workflow-call parent resuming with its child's outputs) is
        # re-scanned. Entries live as long as the item is active. This cache is derived from committed
        # rows only, so it is safe across a rolled-back transaction; the temp table is not, which is
        # why it is rebuilt on every call rather than skipped on an unchanged set.
        self._active_inputs: dict[int, tuple[str, set[str], set[str]]] = {}

    # region policy expression

    @staticmethod
    def _classification_sql(kind: MediaKind) -> str:
        table, name_column, _ = _TABLES[kind]
        statuses = ", ".join(f"'{status}'" for status in ACTIVE_QUEUE_STATUSES)
        return f"""
            CASE
                WHEN (
                    m.session_id IS NOT NULL
                    AND m.session_id IN (SELECT session_id FROM session_queue WHERE status IN ({statuses}))
                ) OR m.{name_column} IN (
                    SELECT name FROM temp.intermediates_active_media WHERE kind = '{kind}'
                ) THEN 'active'
                WHEN m.created_at > STRFTIME('%Y-%m-%d %H:%M:%f', 'NOW', '-{RECENT_GRACE_SECONDS} seconds')
                    THEN 'recent'
                WHEN EXISTS (
                    SELECT 1 FROM media_references r WHERE r.media_kind = '{kind}' AND r.media_name = m.{name_column}
                ) THEN 'referenced'
                ELSE 'safe'
            END
        """

    def _prepare(self, cursor: sqlite3.Cursor) -> None:
        """Makes the transaction's view of active work current.

        Runs on the caller's transaction so a classification and the enqueue it might race are
        ordered by the database lock, never by a stale cache.
        """
        cursor.execute(
            """--sql
            CREATE TEMP TABLE IF NOT EXISTS intermediates_active_media (
                kind TEXT NOT NULL,
                name TEXT NOT NULL,
                PRIMARY KEY (kind, name)
            ) WITHOUT ROWID;
            """
        )
        statuses = ", ".join(f"'{status}'" for status in ACTIVE_QUEUE_STATUSES)
        cursor.execute(
            f"""--sql
            SELECT item_id, status || ':' || COALESCE(status_sequence, 0) || ':' || LENGTH(session) || ':' || updated_at
            FROM session_queue WHERE status IN ({statuses});
            """
        )
        active = {cast(int, row[0]): str(row[1]) for row in cursor.fetchall()}

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
                SELECT item_id,
                       status || ':' || COALESCE(status_sequence, 0) || ':' || LENGTH(session) || ':' || updated_at,
                       session
                FROM session_queue WHERE item_id IN ({placeholders});
                """,
                chunk,
            )
            for item_id, stamp, session_json in cursor.fetchall():
                session_text = session_json if isinstance(session_json, str) else ""
                self._active_inputs[cast(int, item_id)] = (
                    str(stamp),
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

    # endregion

    # region summary

    def summarize(self, user_id: Optional[str]) -> dict[tuple[str, Optional[str]], dict[MediaKind, ScopeCounts]]:
        """Aggregates every intermediate by (owner, project) and classification.

        Media whose project no longer exists, or that never had one, fold into the owner's
        unassigned row (``project_id`` None).
        """
        rows: dict[tuple[str, Optional[str]], dict[MediaKind, ScopeCounts]] = defaultdict(
            lambda: {"image": ScopeCounts(), "video": ScopeCounts()}
        )
        with self._db.transaction() as cursor:
            self._prepare(cursor)
            for kind in ("image", "video"):
                table, _, _ = _TABLES[cast(MediaKind, kind)]
                owner_filter = "AND m.user_id = ?" if user_id is not None else ""
                params: list[object] = [user_id] if user_id is not None else []
                cursor.execute(
                    f"""--sql
                    SELECT user_id, project_key, cls, COUNT(*) AS n,
                           SUM(COALESCE(file_size_bytes, 0)) AS bytes,
                           SUM(CASE WHEN file_size_bytes IS NULL THEN 1 ELSE 0 END) AS unknown
                    FROM (
                        SELECT m.user_id AS user_id,
                               CASE WHEN p.project_id IS NULL THEN NULL ELSE m.project_id END AS project_key,
                               m.file_size_bytes AS file_size_bytes,
                               {self._classification_sql(cast(MediaKind, kind))} AS cls
                        FROM {table} m
                        LEFT JOIN projects p ON p.user_id = m.user_id AND p.project_id = m.project_id
                        WHERE m.is_intermediate = TRUE {owner_filter}
                    )
                    GROUP BY user_id, project_key, cls;
                    """,
                    params,
                )
                for owner, project_key, cls, n, total_bytes, unknown in cursor.fetchall():
                    scope = rows[(cast(str, owner), cast(Optional[str], project_key))][cast(MediaKind, kind)]
                    setattr(scope.counts, cls, cast(int, n))
                    if cls == "safe":
                        scope.safe_bytes += cast(int, total_bytes)
                        scope.unknown_size_count += cast(int, unknown)
                    elif cls == "referenced":
                        scope.referenced_bytes += cast(int, total_bytes)
                        scope.unknown_size_count += cast(int, unknown)
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
            for table, _, _ in _TABLES.values():
                cursor.execute(
                    f"SELECT 1 FROM {table} WHERE is_intermediate = TRUE AND file_size_bytes IS NULL LIMIT 1;"
                )
                if cursor.fetchone() is not None:
                    return True
        return False

    def next_unmeasured(
        self, kind: MediaKind, limit: int, *, min_age_seconds: int = 0, exclude: Sequence[str] = ()
    ) -> list[tuple[str, str]]:
        """Unmeasured intermediates in insertion order; rows younger than ``min_age_seconds`` are left for later.

        A row is written before its file, so a brand-new one would measure as missing. ``exclude``
        skips names a measurement already failed on, so they cannot pin the batch window.
        """
        table, name_column, subfolder_column = _TABLES[kind]
        excluded = list(exclude[: _MAX_SQL_VARIABLES - 2])
        placeholders = ",".join("?" for _ in excluded)
        exclusion = f"AND {name_column} NOT IN ({placeholders})" if excluded else ""
        with self._db.transaction() as cursor:
            cursor.execute(
                f"""--sql
                SELECT {name_column}, {subfolder_column} FROM {table}
                WHERE is_intermediate = TRUE AND file_size_bytes IS NULL
                  AND created_at <= STRFTIME('%Y-%m-%d %H:%M:%f', 'NOW', ?)
                  {exclusion}
                ORDER BY rowid ASC
                LIMIT ?;
                """,
                [f"-{min_age_seconds} seconds", *excluded, limit],
            )
            return [(cast(str, r[0]), cast(str, r[1])) for r in cursor.fetchall()]

    # endregion

    # region candidates

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

    def list_candidates(
        self,
        kind: MediaKind,
        *,
        user_id: Optional[str],
        targets: Optional[Sequence[IntermediatesScopeTarget]],
    ) -> list[IntermediateCandidate]:
        """Every intermediate in scope with its classification, for freezing a preview.

        ``targets`` narrows to selected rows; otherwise ``user_id`` narrows to an owner, and None
        means everyone.
        """
        table, name_column, _ = _TABLES[kind]
        candidates: list[IntermediateCandidate] = []
        with self._db.transaction() as cursor:
            self._prepare(cursor)
            select = f"""--sql
                SELECT m.{name_column}, {self._classification_sql(kind)}, m.file_size_bytes, m.user_id,
                       CASE WHEN p.project_id IS NULL THEN NULL ELSE m.project_id END
                FROM {table} m
                LEFT JOIN projects p ON p.user_id = m.user_id AND p.project_id = m.project_id
                WHERE m.is_intermediate = TRUE
            """
            if targets is not None:
                for start in range(0, len(targets), _TARGETS_PER_STATEMENT):
                    predicate, params = self._scope_predicate(targets[start : start + _TARGETS_PER_STATEMENT])
                    if not predicate:
                        continue
                    cursor.execute(f"{select} AND ({predicate});", params)
                    candidates.extend(self._to_candidates(cursor.fetchall()))
            elif user_id is not None:
                cursor.execute(f"{select} AND m.user_id = ?;", (user_id,))
                candidates.extend(self._to_candidates(cursor.fetchall()))
            else:
                cursor.execute(f"{select};")
                candidates.extend(self._to_candidates(cursor.fetchall()))
        return candidates

    @staticmethod
    def _to_candidates(rows: Iterable[sqlite3.Row]) -> list[IntermediateCandidate]:
        return [
            IntermediateCandidate(
                name=cast(str, row[0]),
                classification=cast(Classification, row[1]),
                file_size_bytes=cast(Optional[int], row[2]),
                user_id=cast(str, row[3]),
                project_id=cast(Optional[str], row[4]),
            )
            for row in rows
        ]

    def affected_references(self, kind: MediaKind, names: Sequence[str]) -> list[AffectedReference]:
        """The saved documents naming any of ``names``, with how many they name."""
        counts: dict[tuple[str, str, str], int] = defaultdict(int)
        with self._db.transaction() as cursor:
            for start in range(0, len(names), _MAX_SQL_VARIABLES):
                chunk = list(names[start : start + _MAX_SQL_VARIABLES])
                placeholders = ",".join("?" for _ in chunk)
                cursor.execute(
                    f"""--sql
                    SELECT owner_kind, user_id, owner_id, COUNT(*)
                    FROM media_references
                    WHERE media_kind = ? AND media_name IN ({placeholders})
                    GROUP BY owner_kind, user_id, owner_id;
                    """,
                    [kind, *chunk],
                )
                for owner_kind, owner_user, owner_id, n in cursor.fetchall():
                    counts[(cast(str, owner_kind), cast(str, owner_user), cast(str, owner_id))] += cast(int, n)
        return [AffectedReference(owner_kind=k, user_id=u, owner_id=o, references=n) for (k, u, o), n in counts.items()]

    def get_document_names(self, refs: Sequence[AffectedReference]) -> dict[tuple[str, str, str], str]:
        names: dict[tuple[str, str, str], str] = {}
        with self._db.transaction() as cursor:
            for ref in refs:
                if ref.owner_kind == "project":
                    cursor.execute(
                        "SELECT name FROM projects WHERE user_id = ? AND project_id = ?;", (ref.user_id, ref.owner_id)
                    )
                else:
                    cursor.execute("SELECT name FROM workflow_library WHERE workflow_id = ?;", (ref.owner_id,))
                row = cursor.fetchone()
                if row is not None and row[0] is not None:
                    names[(ref.owner_kind, ref.user_id, ref.owner_id)] = cast(str, row[0])
        return names

    # endregion

    # region delete guard

    def make_delete_guard(
        self, kind: MediaKind, *, mode: IntermediatesCleanupMode, allowed_user_ids: Optional[frozenset[str]]
    ):
        """The final check of a cleanup batch, run on the deleting transaction.

        Re-applies the policy to the frozen targets at the moment of deletion: anything that became
        active, referenced (safe mode) or non-intermediate since the preview is kept, as is anything
        that left the authorized accounts. ``allowed_user_ids`` None means every account.
        """
        table, name_column, _ = _TABLES[kind]
        deletable = "('safe')" if mode == "safe" else "('safe', 'referenced')"

        def guard(cursor: sqlite3.Cursor, names: Sequence[str]) -> list[str]:
            self._prepare(cursor)
            kept: list[str] = []
            for start in range(0, len(names), _MAX_SQL_VARIABLES):
                chunk = list(names[start : start + _MAX_SQL_VARIABLES])
                placeholders = ",".join("?" for _ in chunk)
                cursor.execute(
                    f"""--sql
                    SELECT name, user_id FROM (
                        SELECT m.{name_column} AS name, m.user_id AS user_id, {self._classification_sql(kind)} AS cls
                        FROM {table} m
                        WHERE m.{name_column} IN ({placeholders}) AND m.is_intermediate = TRUE
                    )
                    WHERE cls IN {deletable};
                    """,
                    chunk,
                )
                # Ownership is re-read here rather than trusted from the preview.
                kept.extend(
                    cast(str, row[0])
                    for row in cursor.fetchall()
                    if allowed_user_ids is None or cast(str, row[1]) in allowed_user_ids
                )
            return kept

        return guard

    # endregion
