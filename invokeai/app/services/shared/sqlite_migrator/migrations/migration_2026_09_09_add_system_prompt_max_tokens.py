"""Give each system prompt its own optional cap on the Expand Prompt LLM's output length.

Expand Prompt asks the text LLM for at most ``EXPAND_PROMPT_MAX_TOKENS_DEFAULT`` (300) new
tokens. That suits the one-paragraph rewrites the original seeded prompts produce, but truncates
prompts that are structurally longer by design -- the MiniMax H3 Ref2VA prompt emits six labelled
sections and routinely needs more.

The cap therefore becomes a property of the system prompt: ``max_tokens`` is NULL for every
existing row (meaning "use the default"), and is set to 500 for the Ref2VA prompt.
"""

import sqlite3

from invokeai.app.services.shared.sqlite_migrator.migrations.migration_2026_09_07_add_minimax_h3_ref2va_system_prompt import (
    MINIMAX_H3_REF2VA_PROMPT_ID,
)
from invokeai.app.services.shared.sqlite_migrator.sqlite_migrator_common import Migration

MINIMAX_H3_REF2VA_MAX_TOKENS = 500
"""Headroom for the six-section structured prompt, measured against the seeded example."""


class AddSystemPromptMaxTokensCallback:
    def __call__(self, cursor: sqlite3.Cursor) -> None:
        cursor.execute("PRAGMA table_info(system_prompts);")
        # SQLite has no ADD COLUMN IF NOT EXISTS. The migrator already guarantees this callback
        # runs at most once per database and rolls the whole thing back on failure, so this guard
        # is for a hand-modified database only -- not a sequence the app can produce.
        if "max_tokens" not in {row[1] for row in cursor.fetchall()}:
            cursor.execute("ALTER TABLE system_prompts ADD COLUMN max_tokens INTEGER;")

        # Every row is NULL immediately after the ALTER above, so the IS NULL scope only matters
        # if the column already existed -- see the guard above. Kept so that re-running the
        # callback by hand cannot overwrite a cap the user has since chosen.
        cursor.execute(
            """--sql
            UPDATE system_prompts SET max_tokens = ? WHERE id = ? AND max_tokens IS NULL;
            """,
            (MINIMAX_H3_REF2VA_MAX_TOKENS, MINIMAX_H3_REF2VA_PROMPT_ID),
        )


def build_migration() -> Migration:
    """Add ``system_prompts.max_tokens`` and give the Ref2VA prompt the room it needs.

    Depends on the Ref2VA seed rather than on the table creation: the row it raises the cap on
    must already exist.
    """
    return Migration(
        id="2026_09_09_add_system_prompt_max_tokens",
        depends_on="2026_09_07_add_minimax_h3_ref2va_system_prompt",
        callback=AddSystemPromptMaxTokensCallback(),
    )
