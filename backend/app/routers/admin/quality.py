"""Split-out admin endpoints — admin.py 가 2236줄로 커져 부분 분리.
이 파일의 모든 route 는 admin._core.router (prefix='/api/admin') 에
직접 등록된다.  main.py 의 include_router 는 admin 패키지의 단일
router 만 부르므로 새 파일을 추가해도 main 은 변경 없음."""
from __future__ import annotations

import os
from datetime import datetime, timezone
from pathlib import Path

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from pydantic import BaseModel, Field
from sqlalchemy import func, or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from ... import app_settings, audit, models, schemas
from ...auth import get_current_user, require_admin, require_staff
from ...config import settings
from ...database import get_db
from ._core import router

# 사용자가 👎 를 누른 어시스턴트 메시지를 한 화면에 모아 운영자가
# 어디서 답변이 부족했는지 점검.  feedback_note 가 있으면 함께,
# 없으면 메시지 본문 앞부분만.

@router.get("/disliked")
async def list_disliked(
    limit: int = Query(100, ge=1, le=500),
    _staff: models.User = Depends(require_staff),
    db: AsyncSession = Depends(get_db),
):
    rows = (
        await db.execute(
            select(models.Message, models.Session.title, models.Session.user_id)
            .join(models.Session, models.Session.id == models.Message.session_id)
            .where(models.Message.feedback == -1)
            .order_by(models.Message.created_at.desc())
            .limit(limit)
        )
    ).all()
    user_ids = {uid for _m, _t, uid in rows if uid}
    email_of: dict[str, str] = {}
    if user_ids:
        urows = (
            await db.execute(
                select(models.User.id, models.User.email).where(
                    models.User.id.in_(user_ids)
                )
            )
        ).all()
        email_of = {uid: em for (uid, em) in urows}
    return [
        {
            "message_id": m.id,
            "session_id": m.session_id,
            "session_title": title or "(제목 없음)",
            "user_email": email_of.get(uid or "", "(unknown)"),
            "provider": m.provider,
            "content": (m.content or "")[:600],
            "feedback_note": m.feedback_note,
            "feedback_category": m.feedback_category,
            "rating": m.rating,
            "created_at": m.created_at.isoformat() if m.created_at else None,
        }
        for (m, title, uid) in rows
    ]


@router.get("/escalations")
async def list_escalations(
    limit: int = Query(100, ge=1, le=500),
    only_open: bool = True,
    _staff: models.User = Depends(require_staff),
    db: AsyncSession = Depends(get_db),
):
    """사용자가 'AI 가 못 풀었어요' 를 누른 답변 목록 (#123).
    only_open=true 면 ack 안 된 것만."""
    q = (
        select(models.Message, models.Session.title, models.Session.user_id)
        .join(models.Session, models.Session.id == models.Message.session_id)
        .where(models.Message.escalated_at.is_not(None))
        .order_by(models.Message.escalated_at.desc())
        .limit(limit)
    )
    if only_open:
        q = q.where(models.Message.escalation_ack_at.is_(None))
    rows = (await db.execute(q)).all()
    user_ids = {uid for _m, _t, uid in rows if uid}
    email_of: dict[str, str] = {}
    if user_ids:
        urows = (
            await db.execute(
                select(models.User.id, models.User.email).where(
                    models.User.id.in_(user_ids)
                )
            )
        ).all()
        email_of = {uid: em for (uid, em) in urows}
    return [
        {
            "message_id": m.id,
            "session_id": m.session_id,
            "session_title": title or "(제목 없음)",
            "user_email": email_of.get(uid or "", "(unknown)"),
            "content": (m.content or "")[:600],
            "reason": m.escalated_reason,
            "escalated_at": m.escalated_at.isoformat() if m.escalated_at else None,
            "ack_at": m.escalation_ack_at.isoformat() if m.escalation_ack_at else None,
        }
        for (m, title, uid) in rows
    ]


@router.get("/feedback-stats")
async def feedback_stats(
    days: int = 30,
    _staff: models.User = Depends(require_staff),
    db: AsyncSession = Depends(get_db),
):
    """피드백 집계 (#124) — 카테고리/모델/별점/추세 분포.  최근 N일."""
    from datetime import datetime as _dt, timedelta as _td
    cutoff = _dt.utcnow() - _td(days=max(1, min(int(days), 365)))
    rows = (
        await db.execute(
            select(
                models.Message.feedback,
                models.Message.feedback_category,
                models.Message.rating,
                models.Message.provider,
                models.Message.escalated_at,
                models.Message.created_at,
            )
            .where(
                models.Message.created_at >= cutoff,
                models.Message.role == "assistant",
            )
        )
    ).all()
    total = len(rows)
    up = sum(1 for r in rows if r[0] == 1)
    down = sum(1 for r in rows if r[0] == -1)
    escalated = sum(1 for r in rows if r[4] is not None)

    by_category: dict[str, int] = {}
    for r in rows:
        if r[0] == -1 and r[1]:
            by_category[r[1]] = by_category.get(r[1], 0) + 1

    by_provider: dict[str, dict[str, int]] = {}
    for r in rows:
        prov = r[3] or "unknown"
        bucket = by_provider.setdefault(prov, {"up": 0, "down": 0, "n": 0})
        bucket["n"] += 1
        if r[0] == 1:
            bucket["up"] += 1
        elif r[0] == -1:
            bucket["down"] += 1

    by_rating: dict[int, int] = {1: 0, 2: 0, 3: 0, 4: 0, 5: 0}
    for r in rows:
        if r[2] and 1 <= r[2] <= 5:
            by_rating[r[2]] = by_rating.get(r[2], 0) + 1

    return {
        "days": days,
        "total_assistant_messages": total,
        "up": up,
        "down": down,
        "escalated": escalated,
        "down_by_category": by_category,
        "by_provider": by_provider,
        "by_rating": by_rating,
    }


