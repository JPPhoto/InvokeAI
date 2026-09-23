"""Contracts of a conditional intermediate delete shared by the image and video services.

A guard runs on the deleting transaction's cursor, immediately before the `DELETE`, and returns
the subset of the candidate names that may still go. Because the database serializes writers
through one connection and lock, nothing — a project save, an enqueue, a promotion — can make a
name protected between the guard's answer and the record's removal.
"""

import sqlite3
from dataclasses import dataclass, field
from typing import Protocol, Sequence


class IntermediateDeleteGuard(Protocol):
    def __call__(self, cursor: sqlite3.Cursor, names: Sequence[str]) -> list[str]: ...


@dataclass
class IntermediateDeleteResult:
    """What a batch delete removed.

    ``deleted_names`` are records that are committed as gone. ``purge_deferred`` names the subset
    whose files could not be removed yet: the record deletion still stands, and the journal (images)
    or a later recovery (videos) finishes the purge, so their bytes are not reclaimed yet.
    """

    deleted_names: list[str] = field(default_factory=list)
    purge_deferred: list[str] = field(default_factory=list)
