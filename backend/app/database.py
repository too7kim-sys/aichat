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
