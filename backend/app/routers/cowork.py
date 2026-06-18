"""협업 (cowork) — 팀·코멘트·알림·액션아이템·워크플로 이력 (#89~94).

기존 prompts·projects·workflows 라우터는 그대로 두고, 새로 추가된
협업 기능만 여기 모음.  팀 스코프 적용은 각 라우터에 점진적으로
연결.
"""
from __future__ import annotations

import json as _json
from datetime import datetime
from typing import Literal

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy import and_, func, or_, select, update
from sqlalchemy.ext.asyncio import AsyncSession

from .. import models
from ..auth import get_current_user
from ..database import get_db


# ── /api/teams (#89) ────────────────────────────────────────
teams_router = APIRouter(prefix="/api/teams", tags=["cowork"])


def _is_admin(user: models.User) -> bool:
    return user.role in ("admin", "moderator")


class TeamIn(BaseModel):
    name: str = Field(min_length=1, max_length=80)
    description: str = Field(default="", max_length=500)


class TeamOut(BaseModel):
    id: str
    name: str
    description: str
    member_count: int
    is_owner: bool


async def _team_member_ids(db: AsyncSession, team_id: str) -> set[str]:
    rows = (
        await db.execute(
            select(models.TeamMember.user_id).where(
                models.TeamMember.team_id == team_id
            )
        )
    ).scalars().all()
    return set(rows)


async def _user_teams(db: AsyncSession, user_id: str) -> set[str]:
    rows = (
        await db.execute(
            select(models.TeamMember.team_id).where(
                models.TeamMember.user_id == user_id
            )
        )
    ).scalars().all()
    return set(rows)


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
notifications_router = APIRouter(
    prefix="/api/notifications", tags=["cowork"]
)


@notifications_router.get("")
async def list_notifications(
    unread_only: bool = False,
    limit: int = 50,
    db: AsyncSession = Depends(get_db),
    user: models.User = Depends(get_current_user),
):
    limit = max(1, min(int(limit or 50), 200))
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


@actions_router.patch("/{aid}", response_model=ActionItemOut)
async def update_action(
    aid: str,
    payload: dict,
    db: AsyncSession = Depends(get_db),
    user: models.User = Depends(get_current_user),
):
    row = await db.scalar(
        select(models.ActionItem).where(models.ActionItem.id == aid)
    )
    if row is None:
        raise HTTPException(404, "항목이 없어요")
    if "status" in payload and payload["status"] in (
        "todo", "doing", "done",
    ):
        row.status = payload["status"]
    if "title" in payload and payload["title"]:
        row.title = str(payload["title"])[:300]
    if "detail" in payload:
        row.detail = payload["detail"] or None
    if "assignee_user_id" in payload:
        row.assignee_user_id = payload["assignee_user_id"] or None
        # 담당자 지정 알림.
        if payload["assignee_user_id"]:
            db.add(
                models.Notification(
                    user_id=payload["assignee_user_id"],
                    kind="action_assigned",
                    title=f"새 액션아이템: {row.title}",
                    link="/?cowork=actions",
                )
            )
    if "due_at" in payload and payload["due_at"]:
        try:
            row.due_at = datetime.fromisoformat(payload["due_at"])
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


# ── 워크플로 실행 이력 + 승인 (#90, #91) ────────────────────
runs_router = APIRouter(prefix="/api/workflow-runs", tags=["cowork"])


@runs_router.get("")
async def list_runs(
    workflow_id: str,
    limit: int = 50,
    db: AsyncSession = Depends(get_db),
    user: models.User = Depends(get_current_user),
):
    wf = await db.scalar(
        select(models.Workflow).where(models.Workflow.id == workflow_id)
    )
    if wf is None:
        raise HTTPException(404, "워크플로가 없어요")
    if wf.user_id != user.id and wf.team_id not in await _user_teams(db, user.id) and not _is_admin(user):
        raise HTTPException(403, "조회 권한이 없어요")
    rows = (
        await db.execute(
            select(models.WorkflowRun)
            .where(models.WorkflowRun.workflow_id == workflow_id)
            .order_by(models.WorkflowRun.started_at.desc())
            .limit(max(1, min(int(limit or 50), 500)))
        )
    ).scalars().all()
    return {
        "items": [
            {
                "id": r.id,
                "status": r.status,
                "session_id": r.session_id,
                "triggered_by_id": r.triggered_by_id,
                "started_at": r.started_at.isoformat() if r.started_at else None,
                "finished_at": r.finished_at.isoformat() if r.finished_at else None,
                "error": (r.error or "")[:500],
            }
            for r in rows
        ]
    }


@runs_router.post("/{run_id}/approve", status_code=204)
async def approve_run(
    run_id: str,
    db: AsyncSession = Depends(get_db),
    user: models.User = Depends(get_current_user),
):
    """승인 게이트 (#91) — pending_approval → approved.  팀 owner /
    관리자만 가능.  approve 후 워크플로 러너가 백그라운드로 픽업해
    실행."""
    row = await db.scalar(
        select(models.WorkflowRun).where(models.WorkflowRun.id == run_id)
    )
    if row is None or row.status != "pending_approval":
        raise HTTPException(404, "승인 대기 중인 실행이 아니에요")
    wf = await db.scalar(
        select(models.Workflow).where(models.Workflow.id == row.workflow_id)
    )
    if wf is None:
        raise HTTPException(404, "워크플로가 없어요")
    is_owner = False
    if wf.team_id:
        owner_row = await db.scalar(
            select(models.TeamMember).where(
                models.TeamMember.team_id == wf.team_id,
                models.TeamMember.user_id == user.id,
                models.TeamMember.role == "owner",
            )
        )
        is_owner = owner_row is not None
    if not is_owner and not _is_admin(user):
        raise HTTPException(403, "owner / 관리자만 승인 가능")
    row.status = "approved"
    db.add(
        models.Notification(
            user_id=row.triggered_by_id or wf.user_id,
            kind="approval_approved",
            title=f"워크플로 '{wf.name}' 승인됨",
            link="/?cowork=workflows",
        )
    )
    await db.commit()


@runs_router.post("/{run_id}/reject", status_code=204)
async def reject_run(
    run_id: str,
    payload: dict | None = None,
    db: AsyncSession = Depends(get_db),
    user: models.User = Depends(get_current_user),
):
    row = await db.scalar(
        select(models.WorkflowRun).where(models.WorkflowRun.id == run_id)
    )
    if row is None or row.status != "pending_approval":
        raise HTTPException(404, "승인 대기 중이 아니에요")
    wf = await db.scalar(
        select(models.Workflow).where(models.Workflow.id == row.workflow_id)
    )
    if not _is_admin(user) and wf and wf.user_id != user.id:
        is_owner_row = await db.scalar(
            select(models.TeamMember).where(
                models.TeamMember.team_id == (wf.team_id or ""),
                models.TeamMember.user_id == user.id,
                models.TeamMember.role == "owner",
            )
        )
        if is_owner_row is None:
            raise HTTPException(403, "owner / 관리자만 거부 가능")
    row.status = "rejected"
    row.error = (payload or {}).get("reason") or "거부됨"
    row.finished_at = datetime.utcnow()
    if wf:
        db.add(
            models.Notification(
                user_id=row.triggered_by_id or wf.user_id,
                kind="approval_rejected",
                title=f"워크플로 '{wf.name}' 거부됨",
                body=row.error,
                link="/?cowork=workflows",
            )
        )
    await db.commit()
