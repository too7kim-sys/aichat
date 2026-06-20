"""챗봇 페르소나 (#125) — 세션에 적용할 system 메시지 템플릿.

CRUD + 사용자별 카탈로그 + 관리자 공유.  Prompt 와 분리한 이유는
Prompt 가 composer 본문을 채우는 1회성 텍스트라면, Persona 는 세션
전체에 prepend 되는 system 메시지라 라이프사이클이 다르기 때문.
"""
from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel, Field
from sqlalchemy import or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from .. import audit, models
from ..auth import get_current_user
from ..database import get_db

router = APIRouter(prefix="/api/personas", tags=["personas"])


class PersonaIn(BaseModel):
    name: str = Field(min_length=1, max_length=120)
    description: str = Field(default="", max_length=500)
    emoji: str = Field(default="", max_length=8)
    system_prompt: str = Field(min_length=1, max_length=10_000)
    is_shared: bool = False
    team_id: str | None = Field(default=None, max_length=36)


class PersonaOut(BaseModel):
    id: str
    name: str
    description: str | None = None
    emoji: str | None = None
    system_prompt: str
    is_shared: bool
    team_id: str | None = None
    owned: bool  # 호출자가 만든 것인지 (공유 페르소나는 read-only).
    created_at: str
    updated_at: str

    class Config:
        from_attributes = True


def _is_admin(user: models.User) -> bool:
    return user.role in ("admin", "moderator")


async def _to_out(p: models.Persona, user_id: str) -> PersonaOut:
    return PersonaOut(
        id=p.id,
        name=p.name,
        description=p.description,
        emoji=p.emoji,
        system_prompt=p.system_prompt,
        is_shared=p.is_shared,
        team_id=p.team_id,
        owned=(p.user_id == user_id),
        created_at=p.created_at.isoformat() if p.created_at else "",
        updated_at=p.updated_at.isoformat() if p.updated_at else "",
    )


@router.get("", response_model=list[PersonaOut])
async def list_personas(
    db: AsyncSession = Depends(get_db),
    user: models.User = Depends(get_current_user),
):
    """본인 + 공유 페르소나 + 같은 팀 페르소나."""
    # 팀 멤버십.
    team_ids = (
        await db.execute(
            select(models.TeamMember.team_id).where(
                models.TeamMember.user_id == user.id
            )
        )
    ).scalars().all()
    conditions = [models.Persona.user_id == user.id, models.Persona.is_shared.is_(True)]
    if team_ids:
        conditions.append(models.Persona.team_id.in_(team_ids))
    rows = (
        await db.execute(
            select(models.Persona)
            .where(or_(*conditions))
            .order_by(models.Persona.updated_at.desc())
        )
    ).scalars().all()
    return [await _to_out(p, user.id) for p in rows]


@router.post("", response_model=PersonaOut, status_code=201)
async def create_persona(
    payload: PersonaIn,
    request: Request,
    db: AsyncSession = Depends(get_db),
    user: models.User = Depends(get_current_user),
):
    """페르소나 생성.  is_shared=True 는 admin 만."""
    if payload.is_shared and not _is_admin(user):
        raise HTTPException(403, "공유 페르소나는 관리자만 만들 수 있어요.")
    p = models.Persona(
        user_id=user.id,
        name=payload.name.strip(),
        description=(payload.description or "").strip() or None,
        emoji=(payload.emoji or "").strip() or None,
        system_prompt=payload.system_prompt,
        is_shared=payload.is_shared,
        team_id=payload.team_id or None,
    )
    db.add(p)
    await db.commit()
    await db.refresh(p)
    await audit.record(
        db, request, "persona_created", user_id=user.id, detail=f"id={p.id} name={p.name}"
    )
    await db.commit()
    return await _to_out(p, user.id)


@router.get("/{persona_id}", response_model=PersonaOut)
async def get_persona(
    persona_id: str,
    db: AsyncSession = Depends(get_db),
    user: models.User = Depends(get_current_user),
):
    p = await db.scalar(select(models.Persona).where(models.Persona.id == persona_id))
    if p is None:
        raise HTTPException(404, "페르소나를 찾을 수 없어요.")
    # 공유 페르소나 / 본인 / 같은 팀이면 OK.
    if p.user_id != user.id and not p.is_shared:
        if p.team_id:
            in_team = await db.scalar(
                select(models.TeamMember).where(
                    models.TeamMember.team_id == p.team_id,
                    models.TeamMember.user_id == user.id,
                )
            )
            if in_team is None:
                raise HTTPException(403, "이 페르소나에 접근할 권한이 없어요.")
        else:
            raise HTTPException(403, "이 페르소나에 접근할 권한이 없어요.")
    return await _to_out(p, user.id)


@router.patch("/{persona_id}", response_model=PersonaOut)
async def update_persona(
    persona_id: str,
    payload: PersonaIn,
    db: AsyncSession = Depends(get_db),
    user: models.User = Depends(get_current_user),
):
    p = await db.scalar(select(models.Persona).where(models.Persona.id == persona_id))
    if p is None:
        raise HTTPException(404, "페르소나를 찾을 수 없어요.")
    if p.user_id != user.id and not _is_admin(user):
        raise HTTPException(403, "본인 페르소나만 수정 가능합니다.")
    if payload.is_shared != p.is_shared and not _is_admin(user):
        raise HTTPException(403, "공유 토글은 관리자만 변경 가능.")
    p.name = payload.name.strip()
    p.description = (payload.description or "").strip() or None
    p.emoji = (payload.emoji or "").strip() or None
    p.system_prompt = payload.system_prompt
    p.is_shared = payload.is_shared
    p.team_id = payload.team_id or None
    await db.commit()
    await db.refresh(p)
    return await _to_out(p, user.id)


@router.delete("/{persona_id}", status_code=204)
async def delete_persona(
    persona_id: str,
    request: Request,
    db: AsyncSession = Depends(get_db),
    user: models.User = Depends(get_current_user),
):
    p = await db.scalar(select(models.Persona).where(models.Persona.id == persona_id))
    if p is None:
        raise HTTPException(404, "페르소나를 찾을 수 없어요.")
    if p.user_id != user.id and not _is_admin(user):
        raise HTTPException(403, "본인 페르소나만 삭제 가능합니다.")
    await db.delete(p)
    await audit.record(
        db, request, "persona_deleted", user_id=user.id, detail=f"id={persona_id}"
    )
    await db.commit()
