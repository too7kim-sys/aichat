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


comments_router = APIRouter(prefix="/api/comments", tags=["cowork"])


class CommentIn(BaseModel):
    target_type: Literal[
        "message", "chunk", "workflow", "transcript", "action"
    ]
    target_id: str = Field(min_length=1, max_length=80)
    body: str = Field(min_length=1, max_length=10_000)
    parent_id: str | None = None
    mentions: list[str] | None = None


class CommentOut(BaseModel):
    id: str
    target_type: str
    target_id: str
    user_id: str | None
    user_name: str
    body: str
    parent_id: str | None
    mentions: list[str]
    resolved: bool
    created_at: str


async def _serialize_comment(
    db: AsyncSession, row: models.Comment
) -> CommentOut:
    u = None
    if row.user_id:
        u = await db.scalar(
            select(models.User).where(models.User.id == row.user_id)
        )
    name = (u.name or u.email) if u else "(삭제된 사용자)"
    mentions: list[str] = []
    if row.mentions:
        try:
            mentions = list(_json.loads(row.mentions))
        except Exception:
            mentions = []
    return CommentOut(
        id=row.id,
        target_type=row.target_type,
        target_id=row.target_id,
        user_id=row.user_id,
        user_name=name,
        body=row.body,
        parent_id=row.parent_id,
        mentions=mentions,
        resolved=row.resolved,
        created_at=row.created_at.isoformat() if row.created_at else "",
    )


@comments_router.get("")
async def list_comments(
    target_type: str,
    target_id: str,
    db: AsyncSession = Depends(get_db),
    user: models.User = Depends(get_current_user),
):
    rows = (
        await db.execute(
            select(models.Comment)
            .where(
                models.Comment.target_type == target_type,
                models.Comment.target_id == target_id,
            )
            .order_by(models.Comment.created_at.asc())
        )
    ).scalars().all()
    out = [await _serialize_comment(db, r) for r in rows]
    return {"items": out}


@comments_router.post("", response_model=CommentOut)
async def create_comment(
    payload: CommentIn,
    db: AsyncSession = Depends(get_db),
    user: models.User = Depends(get_current_user),
):
    mentions_json = (
        _json.dumps(payload.mentions[:10]) if payload.mentions else None
    )
    row = models.Comment(
        target_type=payload.target_type,
        target_id=payload.target_id,
        user_id=user.id,
        body=payload.body,
        parent_id=payload.parent_id,
        mentions=mentions_json,
    )
    db.add(row)
    await db.commit()
    await db.refresh(row)
    # 멘션 → 알림 fan-out.
    if payload.mentions:
        for uid in set(payload.mentions[:10]):
            if uid == user.id:
                continue
            db.add(
                models.Notification(
                    user_id=uid,
                    kind="mention",
                    title=f"{user.name or user.email} 님이 멘션했어요",
                    body=payload.body[:200],
                    link=f"/?target={payload.target_type}:{payload.target_id}",
                )
            )
        await db.commit()
    return await _serialize_comment(db, row)


@comments_router.patch("/{comment_id}", response_model=CommentOut)
async def update_comment(
    comment_id: str,
    payload: dict,
    db: AsyncSession = Depends(get_db),
    user: models.User = Depends(get_current_user),
):
    row = await db.scalar(
        select(models.Comment).where(models.Comment.id == comment_id)
    )
    if row is None:
        raise HTTPException(404, "코멘트가 없어요")
    if row.user_id != user.id and not _is_admin(user):
        raise HTTPException(403, "본인 코멘트만 수정 가능")
    if "body" in payload and payload["body"]:
        row.body = str(payload["body"])[:10_000]
    if "resolved" in payload:
        row.resolved = bool(payload["resolved"])
    await db.commit()
    await db.refresh(row)
    return await _serialize_comment(db, row)


@comments_router.delete("/{comment_id}", status_code=204)
async def delete_comment(
    comment_id: str,
    db: AsyncSession = Depends(get_db),
    user: models.User = Depends(get_current_user),
):
    row = await db.scalar(
        select(models.Comment).where(models.Comment.id == comment_id)
    )
    if row is None:
        return
    if row.user_id != user.id and not _is_admin(user):
        raise HTTPException(403, "본인 코멘트만 삭제 가능")
    await db.delete(row)
    await db.commit()


# ── /api/notifications (#94) ────────────────────────────────
