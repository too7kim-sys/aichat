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


notifications_router = APIRouter(
    prefix="/api/notifications", tags=["cowork"]
)


@notifications_router.get("")
async def list_notifications(
    unread_only: bool = False,
    limit: int = Query(50, ge=1, le=500),
    db: AsyncSession = Depends(get_db),
    user: models.User = Depends(get_current_user),
):
    stmt = select(models.Notification).where(
        models.Notification.user_id == user.id
    )
    if unread_only:
        stmt = stmt.where(models.Notification.read_at.is_(None))
    rows = (
        await db.execute(
            stmt.order_by(models.Notification.created_at.desc()).limit(limit)
        )
    ).scalars().all()
    unread_count = await db.scalar(
        select(func.count(models.Notification.id)).where(
            models.Notification.user_id == user.id,
            models.Notification.read_at.is_(None),
        )
    )
    return {
        "unread_count": int(unread_count or 0),
        "items": [
            {
                "id": r.id,
                "kind": r.kind,
                "title": r.title,
                "body": r.body,
                "link": r.link,
                "read_at": r.read_at.isoformat() if r.read_at else None,
                "created_at": r.created_at.isoformat() if r.created_at else None,
            }
            for r in rows
        ],
    }


@notifications_router.post("/{nid}/read", status_code=204)
async def mark_read(
    nid: str,
    db: AsyncSession = Depends(get_db),
    user: models.User = Depends(get_current_user),
):
    await db.execute(
        update(models.Notification)
        .where(
            models.Notification.id == nid,
            models.Notification.user_id == user.id,
        )
        .values(read_at=datetime.utcnow())
    )
    await db.commit()


@notifications_router.post("/read-all", status_code=204)
async def mark_all_read(
    db: AsyncSession = Depends(get_db),
    user: models.User = Depends(get_current_user),
):
    await db.execute(
        update(models.Notification)
        .where(
            models.Notification.user_id == user.id,
            models.Notification.read_at.is_(None),
        )
        .values(read_at=datetime.utcnow())
    )
    await db.commit()


# ── /api/action-items (#92) ─────────────────────────────────
