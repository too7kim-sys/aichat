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


runs_router = APIRouter(prefix="/api/workflow-runs", tags=["cowork"])


@runs_router.get("/pending-approvals")
async def list_pending_approvals(
    db: AsyncSession = Depends(get_db),
    user: models.User = Depends(get_current_user),
):
    """승인 대기 큐 (#99) — 내가 owner 인 팀의 워크플로 + 내가 만든
    개인 워크플로의 pending_approval 실행을 모두 모아 한 화면에."""
    # 내가 owner 인 팀 id 들.
    owner_team_ids = (
        await db.execute(
            select(models.TeamMember.team_id).where(
                models.TeamMember.user_id == user.id,
                models.TeamMember.role == "owner",
            )
        )
    ).scalars().all()
    stmt = (
        select(models.WorkflowRun, models.Workflow)
        .join(
            models.Workflow,
            models.Workflow.id == models.WorkflowRun.workflow_id,
        )
        .where(models.WorkflowRun.status == "pending_approval")
    )
    if not _is_admin(user):
        # 관리자가 아니면 내가 owner 인 팀 or 내가 만든 워크플로만.
        clauses = [models.Workflow.user_id == user.id]
        if owner_team_ids:
            clauses.append(models.Workflow.team_id.in_(owner_team_ids))
        from sqlalchemy import or_
        stmt = stmt.where(or_(*clauses))
    stmt = stmt.order_by(models.WorkflowRun.started_at.desc()).limit(200)
    rows = (await db.execute(stmt)).all()
    return {
        "items": [
            {
                "id": r.id,
                "workflow_id": r.workflow_id,
                "workflow_name": wf.name,
                "triggered_by_id": r.triggered_by_id,
                "started_at": r.started_at.isoformat() if r.started_at else None,
                "team_id": wf.team_id,
            }
            for (r, wf) in rows
        ]
    }


@runs_router.get("")
async def list_runs(
    workflow_id: str,
    limit: int = Query(50, ge=1, le=500),
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
            .limit(limit)
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


class _RunReject(BaseModel):
    reason: str = Field(default="", max_length=500)


@runs_router.post("/{run_id}/reject", status_code=204)
async def reject_run(
    run_id: str,
    payload: _RunReject | None = None,
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
    row.error = (payload.reason if payload else "") or "거부됨"
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
