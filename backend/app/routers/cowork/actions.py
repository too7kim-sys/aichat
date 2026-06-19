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


actions_router = APIRouter(prefix="/api/action-items", tags=["cowork"])


class ActionItemIn(BaseModel):
    transcript_id: str | None = None
    session_id: str | None = None
    title: str = Field(min_length=1, max_length=300)
    detail: str | None = None
    assignee_text: str | None = None
    due_at: datetime | None = None


class ActionItemOut(BaseModel):
    id: str
    transcript_id: str | None
    session_id: str | None
    status: str
    title: str
    detail: str | None
    assignee_text: str | None
    assignee_user_id: str | None
    due_at: str | None
    created_at: str


def _to_out(row: models.ActionItem) -> ActionItemOut:
    return ActionItemOut(
        id=row.id,
        transcript_id=row.transcript_id,
        session_id=row.session_id,
        status=row.status,
        title=row.title,
        detail=row.detail,
        assignee_text=row.assignee_text,
        assignee_user_id=row.assignee_user_id,
        due_at=row.due_at.isoformat() if row.due_at else None,
        created_at=row.created_at.isoformat() if row.created_at else "",
    )


@actions_router.get("", response_model=list[ActionItemOut])
async def list_actions(
    transcript_id: str | None = None,
    status: str | None = None,
    db: AsyncSession = Depends(get_db),
    user: models.User = Depends(get_current_user),
):
    stmt = select(models.ActionItem)
    if transcript_id:
        stmt = stmt.where(models.ActionItem.transcript_id == transcript_id)
    if status:
        stmt = stmt.where(models.ActionItem.status == status)
    # 권한: 내가 만들었거나 내가 담당.
    if not _is_admin(user):
        stmt = stmt.where(
            or_(
                models.ActionItem.created_by_id == user.id,
                models.ActionItem.assignee_user_id == user.id,
            )
        )
    rows = (
        await db.execute(stmt.order_by(models.ActionItem.created_at.desc()))
    ).scalars().all()
    return [_to_out(r) for r in rows]


@actions_router.post("", response_model=ActionItemOut)
async def create_action(
    payload: ActionItemIn,
    db: AsyncSession = Depends(get_db),
    user: models.User = Depends(get_current_user),
):
    row = models.ActionItem(
        transcript_id=payload.transcript_id,
        session_id=payload.session_id,
        title=payload.title,
        detail=payload.detail,
        assignee_text=payload.assignee_text,
        due_at=payload.due_at,
        created_by_id=user.id,
    )
    db.add(row)
    await db.commit()
    await db.refresh(row)
    return _to_out(row)


class ActionItemPatch(BaseModel):
    """PATCH /action-items/{id} body — 모든 필드 optional."""
    status: str | None = Field(default=None, pattern=r"^(todo|doing|done)$")
    title: str | None = Field(default=None, max_length=300)
    detail: str | None = Field(default=None, max_length=10_000)
    assignee_user_id: str | None = Field(default=None, max_length=36)
    due_at: str | None = Field(default=None, max_length=40)


@actions_router.patch("/{aid}", response_model=ActionItemOut)
async def update_action(
    aid: str,
    payload: ActionItemPatch,
    db: AsyncSession = Depends(get_db),
    user: models.User = Depends(get_current_user),
):
    row = await db.scalar(
        select(models.ActionItem).where(models.ActionItem.id == aid)
    )
    if row is None:
        raise HTTPException(404, "항목이 없어요")
    if payload.status is not None:
        row.status = payload.status
    if payload.title is not None and payload.title:
        row.title = payload.title
    if payload.detail is not None:
        row.detail = payload.detail or None
    if payload.assignee_user_id is not None:
        row.assignee_user_id = payload.assignee_user_id or None
        # 담당자 지정 알림.
        if payload.assignee_user_id:
            db.add(
                models.Notification(
                    user_id=payload.assignee_user_id,
                    kind="action_assigned",
                    title=f"새 액션아이템: {row.title}",
                    link="/?cowork=actions",
                )
            )
    if payload.due_at:
        try:
            row.due_at = datetime.fromisoformat(payload.due_at)
        except Exception:
            pass
    await db.commit()
    await db.refresh(row)
    return _to_out(row)


@actions_router.delete("/{aid}", status_code=204)
async def delete_action(
    aid: str,
    db: AsyncSession = Depends(get_db),
    user: models.User = Depends(get_current_user),
):
    row = await db.scalar(
        select(models.ActionItem).where(models.ActionItem.id == aid)
    )
    if row is None:
        return
    if row.created_by_id != user.id and not _is_admin(user):
        raise HTTPException(403, "본인이 만든 항목만 삭제")
    await db.delete(row)
    await db.commit()


async def extract_actions_from_transcript(
    db: AsyncSession,
    transcript_id: str,
    session_id: str | None,
    transcript_text: str,
    model: str,
    base_url: str,
) -> int:
    """회의록 본문 → LLM 으로 액션아이템 추출 (#92).
    반환: 생성된 항목 수."""
    import httpx

    if not transcript_text.strip():
        return 0
    sys = (
        "당신은 회의록을 분석해 (1) 결정사항 (2) 할 일 (3) 누가 / "
        "언제까지 를 분리 추출하는 도구.  아래 회의록을 보고 액션 "
        "아이템을 JSON 배열로만 출력하세요.  형식: "
        '[{"title": "<짧은 한국어 제목>", "detail": "<선택, 상세>",'
        ' "assignee": "<선택, 담당자 이름>", "due": "<선택, YYYY-MM-DD>"}].  '
        "다른 텍스트나 마크다운 코드 펜스 없이 *순수 JSON* 배열만 출력. "
        "할 일이 없으면 빈 배열 [] 만."
    )
    body = transcript_text[:30_000]
    timeout = httpx.Timeout(120.0, connect=5.0)
    try:
        async with httpx.AsyncClient(timeout=timeout) as client:
            r = await client.post(
                f"{base_url.rstrip('/')}/api/chat",
                json={
                    "model": model,
                    "stream": False,
                    "messages": [
                        {"role": "system", "content": sys},
                        {"role": "user", "content": body},
                    ],
                },
            )
        if r.status_code >= 400:
            return 0
        text = ((r.json() or {}).get("message") or {}).get("content") or ""
    except Exception:
        return 0
    # JSON 파싱.  코드 펜스 제거 등 정리.
    cleaned = text.strip()
    if cleaned.startswith("```"):
        cleaned = cleaned.strip("`").lstrip("json").strip()
    try:
        data = _json.loads(cleaned)
    except Exception:
        return 0
    if not isinstance(data, list):
        return 0
    n = 0
    for it in data[:30]:
        if not isinstance(it, dict):
            continue
        title = str(it.get("title") or "").strip()[:300]
        if not title:
            continue
        due_at = None
        if it.get("due"):
            try:
                due_at = datetime.fromisoformat(str(it["due"]))
            except Exception:
                pass
        db.add(
            models.ActionItem(
                transcript_id=transcript_id,
                session_id=session_id,
                title=title,
                detail=str(it.get("detail") or "")[:5_000] or None,
                assignee_text=str(it.get("assignee") or "")[:80] or None,
                due_at=due_at,
                status="todo",
            )
        )
        n += 1
    await db.commit()
    return n


# ── 워크플로 실행 이력 + 승인 (#90, #91, #99) ────────────────────
