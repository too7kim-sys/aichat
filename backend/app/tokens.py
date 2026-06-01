"""Single-use email tokens (verify / reset).

Raw tokens are returned to the caller (and only ever sent to the user
by email); the database stores SHA-256 hashes so a DB leak doesn't
hand out live links."""
from __future__ import annotations

import hashlib
import secrets
from datetime import datetime, timedelta, timezone

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from . import models

KIND_VERIFY = "verify"
KIND_RESET = "reset"


def _hash(token: str) -> str:
    return hashlib.sha256(token.encode("utf-8")).hexdigest()


async def issue(
    db: AsyncSession, user: models.User, kind: str, hours: int
) -> str:
    """Invalidate prior unused tokens of this kind and return a new raw token."""
    # Mark any outstanding tokens of the same kind as used so a previous
    # link can't compete with the new one.
    prior = (
        await db.execute(
            select(models.EmailToken).where(
                models.EmailToken.user_id == user.id,
                models.EmailToken.kind == kind,
                models.EmailToken.used_at.is_(None),
            )
        )
    ).scalars().all()
    now = datetime.now(timezone.utc).replace(tzinfo=None)
    for p in prior:
        p.used_at = now

    raw = secrets.token_urlsafe(32)
    row = models.EmailToken(
        user_id=user.id,
        kind=kind,
        token_hash=_hash(raw),
        expires_at=now + timedelta(hours=hours),
    )
    db.add(row)
    await db.flush()
    return raw


async def consume(
    db: AsyncSession, raw_token: str, kind: str
) -> models.User | None:
    """Return the user iff the token is unused and unexpired; mark it used."""
    row = (
        await db.execute(
            select(models.EmailToken).where(
                models.EmailToken.token_hash == _hash(raw_token),
                models.EmailToken.kind == kind,
            )
        )
    ).scalar_one_or_none()
    if row is None or row.used_at is not None:
        return None
    now = datetime.now(timezone.utc).replace(tzinfo=None)
    if row.expires_at < now:
        return None
    row.used_at = now
    user = (
        await db.execute(select(models.User).where(models.User.id == row.user_id))
    ).scalar_one_or_none()
    return user
