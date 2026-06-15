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
    # iat 를 박아 둬야 강제 로그아웃 시 컷오프 비교가 가능. utcnow 로
    # 박지 말고 timezone-aware now 로 일관되게 — 비교 시 naive/aware
    # 충돌 방지.
    issued_at = datetime.now(timezone.utc)
    payload = {"sub": user_id, "iat": issued_at, "exp": expires}
    token = jwt.encode(payload, settings.jwt_secret, algorithm=settings.jwt_algorithm)
    return token, expires


async def get_current_user(
    request: Request,
    credentials: HTTPAuthorizationCredentials | None = Depends(_bearer),
    db: AsyncSession = Depends(get_db),
) -> models.User:
    """Read the Authorization: Bearer <token> header and return the
    matching user.

    Bearer-only. We intentionally don't read tokens from cookies — the
    app has no CSRF token and uses CORSMiddleware(allow_credentials=True),
    so accepting cookie auth would let a hostile origin issue
    `fetch(... credentials:'include')` and mutate user data. The SPA
    keeps the JWT in localStorage and attaches it explicitly.

    X-API-Key 헤더가 있으면 그쪽으로도 인증 시도 (#45) — 외부 시스템이
    Bearer JWT 없이 발급된 API 키로 호출할 수 있게.
    """
    # API 키 인증 — 사용자 발급 토큰을 X-API-Key 헤더로 받음.
    api_key = request.headers.get("x-api-key")
    if api_key:
        from .routers.api_keys import lookup_user_by_key
        user = await lookup_user_by_key(db, api_key)
        if user is not None:
            return user
        raise HTTPException(401, "Invalid API key")
    if not (credentials and credentials.scheme.lower() == "bearer"):
        raise HTTPException(401, "Not authenticated")
    token = credentials.credentials
    try:
        payload = jwt.decode(
            token, settings.jwt_secret, algorithms=[settings.jwt_algorithm]
        )
        user_id = payload.get("sub")
        token_iat = payload.get("iat")
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
    # 토큰 무효화 컷오프. 관리자가 "강제 로그아웃" 을 눌렀거나 사용자
    # 본인이 비번을 바꿨다면 그 이전에 발급된 토큰은 거부. iat 가 없는
    # 옛 토큰(이 칼럼이 들어가기 전 발급)은 같은 정책으로 즉시 만료.
    if user.tokens_invalidated_at is not None:
        if token_iat is None:
            raise HTTPException(401, "Token revoked")
        try:
            iat_dt = datetime.fromtimestamp(int(token_iat), tz=timezone.utc)
        except (TypeError, ValueError):
            raise HTTPException(401, "Token revoked")
        # DB 컬럼이 naive datetime 일 수 있어 UTC 로 통일.
        cutoff = user.tokens_invalidated_at
        if cutoff.tzinfo is None:
            cutoff = cutoff.replace(tzinfo=timezone.utc)
        if iat_dt < cutoff:
            raise HTTPException(401, "Token revoked")
    return user


def require_role(*roles: str):
    """Dependency factory: only let the request through if the
    authenticated user's role is one of `roles`. Use as:
        admin_only = require_role('admin')
        @router.get(...)
        async def x(user = Depends(admin_only)): ...

    Resolution: a custom role's effective permission tier comes from
    its `base_role` column in the `roles` table. So a user with role
    'editor' (base_role='moderator') passes require_role('moderator')
    just like a built-in moderator would. The exact role string also
    passes if it appears in `roles` literally — covers callers that
    name a custom code directly.
    """
    allowed = set(roles)

    async def _check(
        user: models.User = Depends(get_current_user),
        db: AsyncSession = Depends(get_db),
    ) -> models.User:
        if user.role in allowed:
            return user
        # Effective role set = primary + additional (user_roles join)
        # so a user assigned multiple roles passes if any one of them
        # — or its base_role tier — matches `allowed`.
        codes: set[str] = {user.role}
        extras = (
            await db.execute(
                select(models.UserRole.role_code).where(
                    models.UserRole.user_id == user.id,
                )
            )
        ).scalars().all()
        codes.update(extras)
        if codes & allowed:
            return user
        # Built-in roles match themselves; custom codes need a
        # base_role lookup to resolve their effective tier.
        custom = [c for c in codes if c not in {"admin", "moderator", "user"}]
        if custom:
            bases = (
                await db.execute(
                    select(models.Role.base_role).where(
                        models.Role.code.in_(custom),
                    )
                )
            ).scalars().all()
            if set(bases) & allowed:
                return user
        raise HTTPException(403, "권한이 없습니다")

    return _check


# Convenience handles — moderator-or-admin can act on the approval
# queue, but only admin can change roles.
require_admin = require_role("admin")
require_staff = require_role("admin", "moderator")
