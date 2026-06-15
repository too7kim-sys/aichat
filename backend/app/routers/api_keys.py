"""사용자 API 키 발급·관리 (#45).

발급 흐름:
  1. POST /api/keys {label} → 평문 token 반환 (한 번만!)
  2. 클라이언트는 그 토큰을 X-API-Key 헤더로 보내 인증
  3. backend 의 get_current_user dependency 가 Bearer 외에 X-API-Key
     도 받아들여 동일한 user 객체를 부착

X-API-Key 통합은 auth.py 의 get_current_user 를 수정하지 않고, 별도
의 미들웨어가 X-API-Key 를 검사해 Bearer 헤더로 변환하는 방식 — 그러
면 다운스트림 라우터는 어떤 인증 방식인지 신경 쓸 필요 없음.  여기서
는 키 CRUD 만 담당.
"""
from __future__ import annotations

import hashlib
import secrets
from datetime import datetime

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from .. import models
from ..auth import get_current_user
from ..database import get_db


router = APIRouter(prefix="/api/keys", tags=["api-keys"])


def _hash(token: str) -> str:
    return hashlib.sha256(token.encode("utf-8")).hexdigest()


class KeyCreate(BaseModel):
    label: str = Field(default="", max_length=80)
    expires_days: int | None = None


class KeyOut(BaseModel):
    id: str
    label: str
    token_prefix: str
    last_used_at: str | None = None
    expires_at: str | None = None
    created_at: str | None = None


class KeyCreateOut(KeyOut):
    """발급 직후에만 사용되는 응답.  평문 token 은 여기서만 노출."""
    token: str


@router.get("", response_model=list[KeyOut])
async def list_keys(
    db: AsyncSession = Depends(get_db),
    user: models.User = Depends(get_current_user),
):
    rows = (
        await db.execute(
            select(models.ApiKey)
            .where(models.ApiKey.user_id == user.id)
            .order_by(models.ApiKey.created_at.desc())
        )
    ).scalars().all()
    return [
        KeyOut(
            id=r.id,
            label=r.label,
            token_prefix=r.token_prefix,
            last_used_at=r.last_used_at.isoformat() if r.last_used_at else None,
            expires_at=r.expires_at.isoformat() if r.expires_at else None,
            created_at=r.created_at.isoformat() if r.created_at else None,
        )
        for r in rows
    ]


@router.post("", response_model=KeyCreateOut)
async def create_key(
    payload: KeyCreate,
    db: AsyncSession = Depends(get_db),
    user: models.User = Depends(get_current_user),
):
    """새 키 발급.  반환된 token 은 *이 한 번만* 평문으로 노출."""
    raw = "aichat_" + secrets.token_urlsafe(32)
    h = _hash(raw)
    expires_at = None
    if payload.expires_days and payload.expires_days > 0:
        from datetime import timedelta as _td

        expires_at = datetime.utcnow() + _td(days=payload.expires_days)
    row = models.ApiKey(
        user_id=user.id,
        label=payload.label.strip(),
        token_hash=h,
        token_prefix=raw[:12],
        expires_at=expires_at,
    )
    db.add(row)
    await db.commit()
    await db.refresh(row)
    return KeyCreateOut(
        id=row.id,
        label=row.label,
        token=raw,
        token_prefix=row.token_prefix,
        last_used_at=None,
        expires_at=row.expires_at.isoformat() if row.expires_at else None,
        created_at=row.created_at.isoformat() if row.created_at else None,
    )


@router.delete("/{key_id}", status_code=204)
async def revoke_key(
    key_id: str,
    db: AsyncSession = Depends(get_db),
    user: models.User = Depends(get_current_user),
):
    row = await db.scalar(
        select(models.ApiKey).where(
            models.ApiKey.id == key_id,
            models.ApiKey.user_id == user.id,
        )
    )
    if not row:
        raise HTTPException(404, "키를 찾을 수 없어요")
    await db.delete(row)
    await db.commit()


async def lookup_user_by_key(db: AsyncSession, token: str) -> models.User | None:
    """X-API-Key 헤더로 들어온 토큰을 사용자로 변환.  미들웨어에서 사용.
    유효한 키면 last_used_at 갱신.  만료/없음/유저 정지 시 None."""
    if not token or not token.startswith("aichat_"):
        return None
    h = _hash(token)
    row = await db.scalar(
        select(models.ApiKey).where(models.ApiKey.token_hash == h)
    )
    if not row:
        return None
    if row.expires_at and row.expires_at < datetime.utcnow():
        return None
    user = await db.scalar(
        select(models.User).where(models.User.id == row.user_id)
    )
    if user is None or user.status != "approved":
        return None
    row.last_used_at = datetime.utcnow()
    await db.commit()
    return user
