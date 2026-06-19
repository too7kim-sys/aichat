"""협업 (cowork) — 팀·코멘트·알림·액션아이템·워크플로 이력 (#89~94).

기존 prompts·projects·workflows 라우터는 그대로 두고, 새로 추가된
협업 기능만 여기 모음.  팀 스코프 적용은 각 라우터에 점진적으로
연결.
"""
from __future__ import annotations

import json as _json
from datetime import datetime
from typing import Literal

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, Field
from sqlalchemy import and_, func, or_, select, update
from sqlalchemy.ext.asyncio import AsyncSession

from ... import models
from ...auth import get_current_user
from ...database import get_db
from ._shared import _is_admin, _team_member_ids, _user_teams


# ── /api/teams (#89) ────────────────────────────────────────
teams_router = APIRouter(prefix="/api/teams", tags=["cowork"])




class TeamIn(BaseModel):
    name: str = Field(min_length=1, max_length=80)
    description: str = Field(default="", max_length=500)


class TeamOut(BaseModel):
    id: str
    name: str
    description: str
    member_count: int
    is_owner: bool






@teams_router.get("", response_model=list[TeamOut])
async def list_teams(
    db: AsyncSession = Depends(get_db),
    user: models.User = Depends(get_current_user),
):
    """내가 속한 팀 + (관리자면) 모든 팀."""
    my_team_ids = await _user_teams(db, user.id)
    stmt = select(models.Team)
    if not _is_admin(user) and my_team_ids:
        stmt = stmt.where(models.Team.id.in_(my_team_ids))
    elif not _is_admin(user):
        return []
    rows = (await db.execute(stmt.order_by(models.Team.name))).scalars().all()
    out: list[TeamOut] = []
    for t in rows:
        members = await _team_member_ids(db, t.id)
        is_owner_row = await db.scalar(
            select(models.TeamMember).where(
                models.TeamMember.team_id == t.id,
                models.TeamMember.user_id == user.id,
                models.TeamMember.role == "owner",
            )
        )
        out.append(
            TeamOut(
                id=t.id,
                name=t.name,
                description=t.description,
                member_count=len(members),
                is_owner=is_owner_row is not None or _is_admin(user),
            )
        )
    return out


@teams_router.post("", response_model=TeamOut)
async def create_team(
    payload: TeamIn,
    db: AsyncSession = Depends(get_db),
    user: models.User = Depends(get_current_user),
):
    if not _is_admin(user):
        raise HTTPException(403, "팀 생성은 관리자만 가능해요")
    dup = await db.scalar(
        select(models.Team.id).where(models.Team.name == payload.name.strip())
    )
    if dup:
        raise HTTPException(409, f"이미 같은 이름의 팀이 있어요: {payload.name}")
    row = models.Team(
        name=payload.name.strip(),
        description=payload.description.strip(),
        created_by_id=user.id,
    )
    db.add(row)
    await db.flush()
    # 생성자는 자동으로 owner.
    db.add(
        models.TeamMember(team_id=row.id, user_id=user.id, role="owner")
    )
    await db.commit()
    await db.refresh(row)
    return TeamOut(
        id=row.id,
        name=row.name,
        description=row.description,
        member_count=1,
        is_owner=True,
    )


class MemberIn(BaseModel):
    user_id: str
    role: Literal["owner", "member"] = "member"


@teams_router.get("/{team_id}/members")
async def list_members(
    team_id: str,
    db: AsyncSession = Depends(get_db),
    user: models.User = Depends(get_current_user),
):
    # 멤버이거나 관리자만.
    is_member = await db.scalar(
        select(models.TeamMember).where(
            models.TeamMember.team_id == team_id,
            models.TeamMember.user_id == user.id,
        )
    )
    if is_member is None and not _is_admin(user):
        raise HTTPException(403, "팀 멤버만 볼 수 있어요")
    rows = (
        await db.execute(
            select(models.TeamMember, models.User)
            .join(models.User, models.User.id == models.TeamMember.user_id)
            .where(models.TeamMember.team_id == team_id)
        )
    ).all()
    return {
        "members": [
            {
                "user_id": tm.user_id,
                "email": u.email,
                "name": u.name or u.email,
                "role": tm.role,
            }
            for (tm, u) in rows
        ]
    }


@teams_router.post("/{team_id}/members", status_code=204)
async def add_member(
    team_id: str,
    payload: MemberIn,
    db: AsyncSession = Depends(get_db),
    user: models.User = Depends(get_current_user),
):
    # owner 또는 관리자.
    is_owner = await db.scalar(
        select(models.TeamMember).where(
            models.TeamMember.team_id == team_id,
            models.TeamMember.user_id == user.id,
            models.TeamMember.role == "owner",
        )
    )
    if is_owner is None and not _is_admin(user):
        raise HTTPException(403, "owner / 관리자만 멤버 추가 가능")
    target = await db.scalar(
        select(models.User).where(models.User.id == payload.user_id)
    )
    if target is None:
        raise HTTPException(404, "사용자를 찾을 수 없어요")
    dup = await db.scalar(
        select(models.TeamMember).where(
            models.TeamMember.team_id == team_id,
            models.TeamMember.user_id == payload.user_id,
        )
    )
    if dup is not None:
        # 역할만 갱신.
        dup.role = payload.role
        await db.commit()
        return
    db.add(
        models.TeamMember(
            team_id=team_id, user_id=payload.user_id, role=payload.role
        )
    )
    await db.commit()


@teams_router.delete("/{team_id}/members/{member_id}", status_code=204)
async def remove_member(
    team_id: str,
    member_id: str,
    db: AsyncSession = Depends(get_db),
    user: models.User = Depends(get_current_user),
):
    is_owner = await db.scalar(
        select(models.TeamMember).where(
            models.TeamMember.team_id == team_id,
            models.TeamMember.user_id == user.id,
            models.TeamMember.role == "owner",
        )
    )
    if is_owner is None and not _is_admin(user):
        raise HTTPException(403, "owner / 관리자만 가능")
    row = await db.scalar(
        select(models.TeamMember).where(
            models.TeamMember.team_id == team_id,
            models.TeamMember.user_id == member_id,
        )
    )
    if row is None:
        return
    await db.delete(row)
    await db.commit()


@teams_router.delete("/{team_id}", status_code=204)
async def delete_team(
    team_id: str,
    db: AsyncSession = Depends(get_db),
    user: models.User = Depends(get_current_user),
):
    if not _is_admin(user):
        raise HTTPException(403, "팀 삭제는 관리자만 가능")
    row = await db.scalar(select(models.Team).where(models.Team.id == team_id))
    if row is None:
        raise HTTPException(404, "팀이 없어요")
    await db.delete(row)
    await db.commit()


# ── /api/comments (#93) ─────────────────────────────────────
