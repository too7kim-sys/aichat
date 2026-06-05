"""Password hashing, JWT issuing/verifying, and the FastAPI dependency
that resolves the bearer token into the current User row."""
from __future__ import annotations

from datetime import datetime, timedelta, timezone

from fastapi import Depends, HTTPException, Request
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from jose import JWTError, jwt
from passlib.context import CryptContext
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from . import models
from .config import settings
from .database import get_db

_pwd = CryptContext(schemes=["bcrypt"], deprecated="auto")
_bearer = HTTPBearer(auto_error=False)

# A pre-computed bcrypt hash used to keep login work constant when the
# email doesn't exist. Without it an attacker can time the request to
# tell which emails are registered.
_DUMMY_HASH = _pwd.hash("not-a-real-password-just-for-timing-equalisation")


def dummy_verify() -> None:
    """Burn the same CPU cost as a real verify_password call."""
    _pwd.verify("placeholder", _DUMMY_HASH)


def hash_password(plain: str) -> str:
    return _pwd.hash(plain)


def verify_password(plain: str, hashed: str) -> bool:
    try:
        return _pwd.verify(plain, hashed)
    except Exception:  # noqa: BLE001 - corrupt hash, etc.
        return False


def create_access_token(user_id: str) -> tuple[str, datetime]:
    expires = datetime.now(timezone.utc) + timedelta(
        hours=settings.access_token_expire_hours
    )
    payload = {"sub": user_id, "exp": expires}
    token = jwt.encode(payload, settings.jwt_secret, algorithm=settings.jwt_algorithm)
    return token, expires


async def get_current_user(
    request: Request,
    credentials: HTTPAuthorizationCredentials | None = Depends(_bearer),
    db: AsyncSession = Depends(get_db),
) -> models.User:
    """Read the Authorization: Bearer <token> header (or the access_token
    cookie set by /login) and return the matching user."""
    token: str | None = None
    if credentials and credentials.scheme.lower() == "bearer":
        token = credentials.credentials
    elif "access_token" in request.cookies:
        token = request.cookies["access_token"]

    if not token:
        raise HTTPException(401, "Not authenticated")
    try:
        payload = jwt.decode(
            token, settings.jwt_secret, algorithms=[settings.jwt_algorithm]
        )
        user_id = payload.get("sub")
    except JWTError:
        raise HTTPException(401, "Invalid token")

    if not user_id:
        raise HTTPException(401, "Invalid token payload")
    user = (
        await db.execute(select(models.User).where(models.User.id == user_id))
    ).scalar_one_or_none()
    if user is None:
        raise HTTPException(401, "User no longer exists")
    # Approval gate — a token that was issued before status flipped
    # (e.g. moderator rejected after approval) shouldn't still grant
    # access. Login already gates new sign-ins; this catches stale
    # JWTs.
    if user.status != "approved":
        raise HTTPException(403, "계정이 활성 상태가 아닙니다")
    return user


def require_role(*roles: str):
    """Dependency factory: only let the request through if the
    authenticated user's role is one of `roles`. Use as:
        admin_only = require_role('admin')
        @router.get(...)
        async def x(user = Depends(admin_only)): ...
    """
    allowed = set(roles)

    async def _check(
        user: models.User = Depends(get_current_user),
    ) -> models.User:
        if user.role not in allowed:
            raise HTTPException(403, "권한이 없습니다")
        return user

    return _check


# Convenience handles — moderator-or-admin can act on the approval
# queue, but only admin can change roles.
require_admin = require_role("admin")
require_staff = require_role("admin", "moderator")
