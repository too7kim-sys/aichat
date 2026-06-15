"""사용자 슬래시 매크로 (#33).

`/내인사`, `/공통서명` 같이 자주 쓰는 prompt 를 사용자가 직접 등록.
composer 의 SlashPromptPicker 가 시스템 prompts + 이 매크로를 함께
보여줌.
"""
from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from .. import models
from ..auth import get_current_user
from ..database import get_db


router = APIRouter(prefix="/api/macros", tags=["macros"])


class MacroIn(BaseModel):
    name: str = Field(min_length=1, max_length=80)
    body: str = Field(min_length=1, max_length=20_000)


class MacroOut(BaseModel):
    id: str
    name: str
    body: str
    created_at: str | None = None
    updated_at: str | None = None


@router.get("", response_model=list[MacroOut])
async def list_macros(
    db: AsyncSession = Depends(get_db),
    user: models.User = Depends(get_current_user),
):
    rows = (
        await db.execute(
            select(models.UserMacro)
            .where(models.UserMacro.user_id == user.id)
            .order_by(models.UserMacro.name.asc())
        )
    ).scalars().all()
    return [
        MacroOut(
            id=r.id,
            name=r.name,
            body=r.body,
            created_at=r.created_at.isoformat() if r.created_at else None,
            updated_at=r.updated_at.isoformat() if r.updated_at else None,
        )
        for r in rows
    ]


@router.post("", response_model=MacroOut)
async def create_macro(
    payload: MacroIn,
    db: AsyncSession = Depends(get_db),
    user: models.User = Depends(get_current_user),
):
    # 같은 이름 중복 방지 — 동일 사용자 안에서.
    dup = await db.scalar(
        select(models.UserMacro.id).where(
            models.UserMacro.user_id == user.id,
            models.UserMacro.name == payload.name.strip(),
        )
    )
    if dup:
        raise HTTPException(409, f"이미 같은 이름의 매크로가 있어요: {payload.name}")
    row = models.UserMacro(
        user_id=user.id,
        name=payload.name.strip(),
        body=payload.body,
    )
    db.add(row)
    await db.commit()
    await db.refresh(row)
    return MacroOut(
        id=row.id,
        name=row.name,
        body=row.body,
        created_at=row.created_at.isoformat() if row.created_at else None,
        updated_at=row.updated_at.isoformat() if row.updated_at else None,
    )


@router.patch("/{macro_id}", response_model=MacroOut)
async def update_macro(
    macro_id: str,
    payload: MacroIn,
    db: AsyncSession = Depends(get_db),
    user: models.User = Depends(get_current_user),
):
    row = await db.scalar(
        select(models.UserMacro).where(
            models.UserMacro.id == macro_id,
            models.UserMacro.user_id == user.id,
        )
    )
    if not row:
        raise HTTPException(404, "매크로를 찾을 수 없어요")
    row.name = payload.name.strip()
    row.body = payload.body
    await db.commit()
    await db.refresh(row)
    return MacroOut(
        id=row.id,
        name=row.name,
        body=row.body,
        created_at=row.created_at.isoformat() if row.created_at else None,
        updated_at=row.updated_at.isoformat() if row.updated_at else None,
    )


@router.delete("/{macro_id}", status_code=204)
async def delete_macro(
    macro_id: str,
    db: AsyncSession = Depends(get_db),
    user: models.User = Depends(get_current_user),
):
    row = await db.scalar(
        select(models.UserMacro).where(
            models.UserMacro.id == macro_id,
            models.UserMacro.user_id == user.id,
        )
    )
    if not row:
        raise HTTPException(404, "매크로를 찾을 수 없어요")
    await db.delete(row)
    await db.commit()


# ── 시스템 매크로 (#48) — 관리자만 편집, 모두 읽기 ─────────────
class SystemMacroIn(BaseModel):
    name: str = Field(min_length=1, max_length=80)
    body: str = Field(min_length=1, max_length=20_000)


class SystemMacroOut(BaseModel):
    id: str
    name: str
    body: str


sys_router = APIRouter(prefix="/api/system-macros", tags=["macros"])


@sys_router.get("", response_model=list[SystemMacroOut])
async def list_system_macros(
    db: AsyncSession = Depends(get_db),
    _user: models.User = Depends(get_current_user),
):
    rows = (
        await db.execute(
            select(models.SystemMacro).order_by(models.SystemMacro.name.asc())
        )
    ).scalars().all()
    return [SystemMacroOut(id=r.id, name=r.name, body=r.body) for r in rows]


def _require_admin(user: models.User) -> None:
    if user.role not in ("admin", "moderator"):
        raise HTTPException(403, "관리자 권한이 필요해요")


@sys_router.post("", response_model=SystemMacroOut)
async def create_system_macro(
    payload: SystemMacroIn,
    db: AsyncSession = Depends(get_db),
    user: models.User = Depends(get_current_user),
):
    _require_admin(user)
    dup = await db.scalar(
        select(models.SystemMacro.id).where(
            models.SystemMacro.name == payload.name.strip()
        )
    )
    if dup:
        raise HTTPException(409, f"이미 같은 이름이 있어요: {payload.name}")
    row = models.SystemMacro(
        name=payload.name.strip(),
        body=payload.body,
        updated_by_id=user.id,
    )
    db.add(row)
    await db.commit()
    await db.refresh(row)
    return SystemMacroOut(id=row.id, name=row.name, body=row.body)


@sys_router.patch("/{macro_id}", response_model=SystemMacroOut)
async def update_system_macro(
    macro_id: str,
    payload: SystemMacroIn,
    db: AsyncSession = Depends(get_db),
    user: models.User = Depends(get_current_user),
):
    _require_admin(user)
    row = await db.scalar(
        select(models.SystemMacro).where(models.SystemMacro.id == macro_id)
    )
    if not row:
        raise HTTPException(404, "매크로를 찾을 수 없어요")
    row.name = payload.name.strip()
    row.body = payload.body
    row.updated_by_id = user.id
    await db.commit()
    await db.refresh(row)
    return SystemMacroOut(id=row.id, name=row.name, body=row.body)


@sys_router.delete("/{macro_id}", status_code=204)
async def delete_system_macro(
    macro_id: str,
    db: AsyncSession = Depends(get_db),
    user: models.User = Depends(get_current_user),
):
    _require_admin(user)
    row = await db.scalar(
        select(models.SystemMacro).where(models.SystemMacro.id == macro_id)
    )
    if not row:
        raise HTTPException(404, "매크로를 찾을 수 없어요")
    await db.delete(row)
    await db.commit()
