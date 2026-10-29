"""Store the original MCP request fingerprint separately from the compiled queue payload hash."""

from sqlalchemy import Column, inspect

from invokeai.app.services.shared.database.types import LongText
from invokeai.app.services.shared.sqlite_migrator.sqlite_migrator_common import (
    PortableMigration,
    PortableMigrationContext,
)


def _add_session_queue_request_fingerprint(context: PortableMigrationContext) -> None:
    existing = {column["name"] for column in inspect(context.conn).get_columns("session_queue_enqueue_receipts")}
    if "request_fingerprint" not in existing:
        context.op.add_column("session_queue_enqueue_receipts", Column("request_fingerprint", LongText()))


def build_migration() -> PortableMigration:
    return PortableMigration(
        id="2026_10_29_add_session_queue_request_fingerprint",
        depends_on="2026_10_13_add_session_queue_delivery",
        callback=_add_session_queue_request_fingerprint,
    )
