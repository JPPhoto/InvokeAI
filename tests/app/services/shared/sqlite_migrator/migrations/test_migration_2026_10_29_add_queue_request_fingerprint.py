"""Enqueue receipts gain the request fingerprint without changing existing receipts."""

from logging import Logger

from alembic.migration import MigrationContext
from alembic.operations import Operations
from sqlalchemy import create_engine, inspect

from invokeai.app.services.shared.sqlite_migrator.migrations.migration_2026_10_29_add_session_queue_request_fingerprint import (
    build_migration,
)
from invokeai.app.services.shared.sqlite_migrator.sqlite_migrator_common import PortableMigrationContext


def test_existing_receipts_get_a_nullable_fingerprint_idempotently() -> None:
    engine = create_engine("sqlite:///:memory:")
    with engine.begin() as conn:
        conn.exec_driver_sql(
            """CREATE TABLE session_queue_enqueue_receipts (
                queue_id TEXT NOT NULL,
                user_id TEXT NOT NULL,
                idempotency_key TEXT NOT NULL,
                payload_hash TEXT NOT NULL,
                batch_id TEXT NOT NULL,
                requested INTEGER NOT NULL,
                enqueued INTEGER NOT NULL,
                priority INTEGER NOT NULL,
                item_ids TEXT NOT NULL,
                byte_size INTEGER NOT NULL,
                created_at TEXT NOT NULL,
                acknowledged_at TEXT,
                PRIMARY KEY (queue_id, user_id, idempotency_key)
            );"""
        )
        conn.exec_driver_sql(
            """INSERT INTO session_queue_enqueue_receipts VALUES (
                'queue', 'user', 'key', 'payload', 'batch', 2, 1, 0, '[1]', 10, 'created', NULL
            );"""
        )
        context = PortableMigrationContext(conn, Operations(MigrationContext.configure(conn)), Logger("test"))

        migration = build_migration()
        migration.callback(context)
        migration.callback(context)

        columns = {column["name"]: column for column in inspect(conn).get_columns("session_queue_enqueue_receipts")}
        receipt = conn.exec_driver_sql(
            "SELECT queue_id, user_id, idempotency_key, payload_hash, batch_id, requested, enqueued, "
            "priority, item_ids, byte_size, created_at, acknowledged_at, request_fingerprint "
            "FROM session_queue_enqueue_receipts;"
        ).one()

    assert columns["request_fingerprint"]["nullable"] is True
    assert receipt == ("queue", "user", "key", "payload", "batch", 2, 1, 0, "[1]", 10, "created", None, None)
    engine.dispose()
