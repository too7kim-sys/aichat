"""Runtime-toggleable app settings stored in the app_settings table.

The schema is a flat key/value store; this module wraps it with typed
getters/setters and an explicit registry of well-known keys so callers
don't sprinkle stringly-typed lookups across the codebase.

Default values live here rather than in the DB so a fresh install
boots with sensible behavior even when no rows are present yet — the
config.py env-var defaults still take precedence when explicitly set
on first init (handled by `seed_defaults`), but day-to-day reads come
from this module.
"""
from __future__ import annotations

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from . import models
from .config import settings as env_settings

# Registry of well-known keys + their typed defaults. Keep this short —
# anything bigger probably wants its own table.
KEY_AUTO_APPROVE_SIGNUPS = "auto_approve_signups"

_BOOL_DEFAULTS: dict[str, bool] = {
    # Default ON — operators have to opt into the approval queue.
    KEY_AUTO_APPROVE_SIGNUPS: True,
}


def _parse_bool(s: str | None, default: bool) -> bool:
    if s is None:
        return default
    return s.strip().lower() in {"1", "true", "yes", "on"}


async def get_bool(db: AsyncSession, key: str) -> bool:
    """Read a typed boolean. Falls back to the registered default
    when the row is missing or unparseable."""
    if key not in _BOOL_DEFAULTS:
        raise KeyError(f"unknown setting: {key}")
    row = (
        await db.execute(
            select(models.AppSetting).where(models.AppSetting.key == key)
        )
    ).scalar_one_or_none()
    return _parse_bool(row.value if row else None, _BOOL_DEFAULTS[key])


async def set_bool(
    db: AsyncSession,
    key: str,
    value: bool,
    *,
    actor_id: str | None,
) -> None:
    if key not in _BOOL_DEFAULTS:
        raise KeyError(f"unknown setting: {key}")
    row = (
        await db.execute(
            select(models.AppSetting).where(models.AppSetting.key == key)
        )
    ).scalar_one_or_none()
    stored = "true" if value else "false"
    if row is None:
        db.add(models.AppSetting(key=key, value=stored, updated_by_id=actor_id))
    else:
        row.value = stored
        row.updated_by_id = actor_id


async def seed_defaults(db: AsyncSession) -> None:
    """Seed env-var-derived initial values into the table on first
    init. After this runs, the DB is the source of truth — flipping
    the env var won't unset an operator's later choice.

    `require_approval` is the inverse of `auto_approve_signups`, so a
    legacy operator who set REQUIRE_APPROVAL=true gets a sensible
    initial row (auto_approve=false) without a code change."""
    # When the operator explicitly opted into approval via the env
    # var, seed the DB so the dashboard reflects that on first boot.
    # The default (require_approval=False) leaves no row, falling
    # back to the registered default of True (auto-approve ON).
    if env_settings.require_approval is True:
        existing = (
            await db.execute(
                select(models.AppSetting).where(
                    models.AppSetting.key == KEY_AUTO_APPROVE_SIGNUPS
                )
            )
        ).scalar_one_or_none()
        if existing is None:
            db.add(
                models.AppSetting(
                    key=KEY_AUTO_APPROVE_SIGNUPS,
                    value="false",
                    updated_by_id=None,
                )
            )
            await db.commit()
