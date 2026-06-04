from collections.abc import AsyncIterator

from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine
from sqlalchemy.orm import DeclarativeBase

from .config import settings


class Base(DeclarativeBase):
    pass


engine = create_async_engine(settings.database_url, echo=False, future=True)
SessionLocal = async_sessionmaker(engine, expire_on_commit=False, class_=AsyncSession)


async def init_db() -> None:
    from sqlalchemy import text

    from . import models  # noqa: F401 - register tables
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
        # SQLite: switch to WAL so a long-running write (e.g. persisting
        # an in-flight assistant message after the user navigated to a
        # new chat) doesn't block fresh reads on other tabs/requests.
        if settings.database_url.startswith("sqlite"):
            await conn.exec_driver_sql("PRAGMA journal_mode=WAL")
            await conn.exec_driver_sql("PRAGMA synchronous=NORMAL")
            await conn.exec_driver_sql("PRAGMA busy_timeout=5000")
        # Lightweight, idempotent migration for pre-auth SQLite DBs that
        # already have a `sessions` table without a `user_id` column.
        # (Full migrations would need Alembic; this covers the only schema
        # change we've shipped that breaks existing dev DBs.)
        if settings.database_url.startswith("sqlite"):
            cols = await conn.exec_driver_sql("PRAGMA table_info(sessions)")
            existing = {row[1] for row in cols.fetchall()}
            if "user_id" not in existing:
                await conn.exec_driver_sql(
                    "ALTER TABLE sessions ADD COLUMN user_id VARCHAR(36)"
                )
                await conn.exec_driver_sql(
                    "CREATE INDEX IF NOT EXISTS ix_sessions_user_id "
                    "ON sessions(user_id)"
                )
            if "project_id" not in existing:
                # RAG link added in the Phase-1 RAG commit. Nullable, so
                # existing rows survive — the chat router just sees None
                # and skips retrieval.
                await conn.exec_driver_sql(
                    "ALTER TABLE sessions ADD COLUMN project_id VARCHAR(36)"
                )
                await conn.exec_driver_sql(
                    "CREATE INDEX IF NOT EXISTS ix_sessions_project_id "
                    "ON sessions(project_id)"
                )
            # Projects table may exist without corpus_type from the
            # original RAG ship — default existing rows to "code".
            pcols = await conn.exec_driver_sql("PRAGMA table_info(projects)")
            pexisting = {row[1] for row in pcols.fetchall()}
            if pexisting and "corpus_type" not in pexisting:
                await conn.exec_driver_sql(
                    "ALTER TABLE projects ADD COLUMN corpus_type "
                    "VARCHAR(20) NOT NULL DEFAULT 'code'"
                )
                await conn.exec_driver_sql(
                    "CREATE INDEX IF NOT EXISTS ix_projects_corpus_type "
                    "ON projects(corpus_type)"
                )
            if pexisting and "corpus_type" in pexisting:
                # The legal corpus type was retired; remap any existing
                # rows to "document" so the modal can still render them
                # (the chunker just runs the document path on the same
                # files until the user re-indexes).
                await conn.exec_driver_sql(
                    "UPDATE projects SET corpus_type = 'document' "
                    "WHERE corpus_type = 'legal'"
                )
            if pexisting and "current_snapshot_id" not in pexisting:
                # Snapshot/versioning support added later. The FK column
                # is nullable so existing rows survive; a small backfill
                # below creates a Snapshot row per existing ready
                # project so retrieval keeps working without re-index.
                await conn.exec_driver_sql(
                    "ALTER TABLE projects ADD COLUMN current_snapshot_id "
                    "VARCHAR(36)"
                )
                await conn.exec_driver_sql(
                    "CREATE INDEX IF NOT EXISTS ix_projects_current_snapshot_id "
                    "ON projects(current_snapshot_id)"
                )
                # Make sure the snapshots table exists before backfilling.
                await conn.exec_driver_sql(
                    """
                    CREATE TABLE IF NOT EXISTS project_snapshots (
                        id            VARCHAR(36) PRIMARY KEY,
                        project_id    VARCHAR(36) NOT NULL,
                        label         VARCHAR(120) DEFAULT '',
                        status        VARCHAR(20) DEFAULT 'pending',
                        progress_done INTEGER DEFAULT 0,
                        progress_total INTEGER DEFAULT 0,
                        file_count    INTEGER DEFAULT 0,
                        chunk_count   INTEGER DEFAULT 0,
                        error         TEXT,
                        created_at    DATETIME DEFAULT CURRENT_TIMESTAMP
                    )
                    """
                )
                # Backfill: every existing ready project gets one
                # synthetic snapshot so future retrieval routes through
                # the snapshot id instead of the project id.
                await conn.exec_driver_sql(
                    """
                    INSERT INTO project_snapshots
                        (id, project_id, label, status, progress_done,
                         progress_total, file_count, chunk_count, error,
                         created_at)
                    SELECT
                        lower(hex(randomblob(4))) || '-' ||
                        lower(hex(randomblob(2))) || '-4' ||
                        substr(lower(hex(randomblob(2))), 2) || '-' ||
                        substr('89ab', abs(random()) % 4 + 1, 1) ||
                        substr(lower(hex(randomblob(2))), 2) || '-' ||
                        lower(hex(randomblob(6))),
                        id, '초기 인덱스', status, progress_done,
                        progress_total, file_count, chunk_count, error,
                        created_at
                    FROM projects
                    WHERE id NOT IN (
                        SELECT project_id FROM project_snapshots
                    )
                    """
                )
                # Point each project at its newly-created snapshot.
                await conn.exec_driver_sql(
                    """
                    UPDATE projects
                       SET current_snapshot_id = (
                           SELECT id FROM project_snapshots s
                           WHERE s.project_id = projects.id
                           ORDER BY s.created_at DESC LIMIT 1
                       )
                     WHERE current_snapshot_id IS NULL
                    """
                )
            ucols = await conn.exec_driver_sql("PRAGMA table_info(users)")
            uexisting = {row[1] for row in ucols.fetchall()}
            if uexisting and "email_verified" not in uexisting:
                # Default existing accounts to verified so they don't get
                # locked out by the new column — only fresh signups go
                # through verification.
                await conn.exec_driver_sql(
                    "ALTER TABLE users ADD COLUMN email_verified BOOLEAN "
                    "NOT NULL DEFAULT 1"
                )
        # Quiet the unused-import + text linters in environments where
        # neither branch above runs.
        _ = text


async def get_db() -> AsyncIterator[AsyncSession]:
    async with SessionLocal() as session:
        yield session
