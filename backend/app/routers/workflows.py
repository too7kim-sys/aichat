"""Workflow CRUD + manual trigger. Each run materialises as a chat
Session owned by the workflow's user, so the result naturally shows
up in their session list — no separate run-history UI needed."""
from __future__ import annotations

import asyncio
import json

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from .. import models, schemas
from ..auth import get_current_user
from ..database import get_db
from ..rag.access import can_access_project, can_access_prompt
from ..workflows.runner import run_workflow

router = APIRouter(prefix="/api/workflows", tags=["workflows"])


_BACKGROUND_RUN_TASKS: set[asyncio.Task] = set()


async def _load(
    db: AsyncSession, workflow_id: str, user: models.User
) -> models.Workflow:
    wf = (
        await db.execute(
            select(models.Workflow).where(models.Workflow.id == workflow_id)
        )
    ).scalar_one_or_none()
    if wf is None:
        raise HTTPException(404, "workflow not found")
    if wf.user_id != user.id:
        raise HTTPException(403, "권한이 없습니다")
    return wf


async def _serialize(
    db: AsyncSession, wf: models.Workflow
) -> schemas.WorkflowOut:
    out = schemas.WorkflowOut.model_validate(wf)
    if wf.prompt_vars:
        try:
            out.prompt_vars = json.loads(wf.prompt_vars)
        except Exception:  # noqa: BLE001
            out.prompt_vars = None
    # Pull the prompt name + project name in one batch so the UI can
    # render labels without an extra fetch per row.
    p = (
        await db.execute(
            select(models.Prompt).where(models.Prompt.id == wf.prompt_id)
        )
    ).scalar_one_or_none()
    if p is not None:
        out.prompt_name = p.name
    if wf.project_id:
        proj = (
            await db.execute(
                select(models.Project).where(
                    models.Project.id == wf.project_id
                )
            )
        ).scalar_one_or_none()
        if proj is not None:
            out.project_name = proj.name
    return out


@router.get("", response_model=list[schemas.WorkflowOut])
async def list_workflows(
    db: AsyncSession = Depends(get_db),
    user: models.User = Depends(get_current_user),
):
    rows = (
        await db.execute(
            select(models.Workflow)
            .where(models.Workflow.user_id == user.id)
            .order_by(models.Workflow.updated_at.desc())
        )
    ).scalars().all()
    out: list[schemas.WorkflowOut] = []
    for wf in rows:
        out.append(await _serialize(db, wf))
    return out


async def _verify_refs(
    db: AsyncSession,
    user: models.User,
    prompt_id: str,
    project_id: str | None,
) -> None:
    """Block creating a workflow that references a prompt or project
    the user can't actually use."""
    p = (
        await db.execute(
            select(models.Prompt).where(models.Prompt.id == prompt_id)
        )
    ).scalar_one_or_none()
    if p is None:
        raise HTTPException(400, "prompt_id 가 잘못되었습니다")
    if not await can_access_prompt(db, user, p):
        raise HTTPException(403, "이 프롬프트에 접근 권한이 없습니다")
    if project_id:
        proj = (
            await db.execute(
                select(models.Project).where(
                    models.Project.id == project_id
                )
            )
        ).scalar_one_or_none()
        if proj is None:
            raise HTTPException(400, "project_id 가 잘못되었습니다")
        if not await can_access_project(db, user, proj):
            raise HTTPException(403, "이 지식베이스에 접근 권한이 없습니다")


@router.post("", response_model=schemas.WorkflowOut, status_code=201)
async def create_workflow(
    payload: schemas.WorkflowCreate,
    db: AsyncSession = Depends(get_db),
    user: models.User = Depends(get_current_user),
):
    await _verify_refs(db, user, payload.prompt_id, payload.project_id)
    wf = models.Workflow(
        user_id=user.id,
        name=payload.name.strip(),
        description=(payload.description or "").strip() or None,
        prompt_id=payload.prompt_id,
        prompt_vars=(
            json.dumps(payload.prompt_vars, ensure_ascii=False)
            if payload.prompt_vars
            else None
        ),
        project_id=payload.project_id,
        model=(payload.model or "").strip() or None,
        schedule_interval_minutes=max(0, payload.schedule_interval_minutes),
        enabled=payload.enabled,
    )
    db.add(wf)
    await db.commit()
    await db.refresh(wf)
    return await _serialize(db, wf)


@router.patch("/{workflow_id}", response_model=schemas.WorkflowOut)
async def update_workflow(
    workflow_id: str,
    payload: schemas.WorkflowUpdate,
    db: AsyncSession = Depends(get_db),
    user: models.User = Depends(get_current_user),
):
    wf = await _load(db, workflow_id, user)
    if payload.prompt_id is not None or payload.project_id is not None:
        await _verify_refs(
            db,
            user,
            payload.prompt_id or wf.prompt_id,
            payload.project_id if payload.project_id is not None else wf.project_id,
        )
    if payload.name is not None:
        wf.name = payload.name.strip()
    if payload.description is not None:
        wf.description = (payload.description or "").strip() or None
    if payload.prompt_id is not None:
        wf.prompt_id = payload.prompt_id
    if payload.prompt_vars is not None:
        wf.prompt_vars = json.dumps(payload.prompt_vars, ensure_ascii=False)
    if payload.project_id is not None:
        wf.project_id = payload.project_id or None
    if payload.model is not None:
        wf.model = (payload.model or "").strip() or None
    if payload.schedule_interval_minutes is not None:
        wf.schedule_interval_minutes = max(
            0, payload.schedule_interval_minutes
        )
    if payload.enabled is not None:
        wf.enabled = payload.enabled
    await db.commit()
    await db.refresh(wf)
    return await _serialize(db, wf)


@router.delete("/{workflow_id}", status_code=204)
async def delete_workflow(
    workflow_id: str,
    db: AsyncSession = Depends(get_db),
    user: models.User = Depends(get_current_user),
):
    wf = await _load(db, workflow_id, user)
    await db.delete(wf)
    await db.commit()


@router.post("/{workflow_id}/run", response_model=schemas.WorkflowOut)
async def manual_run(
    workflow_id: str,
    db: AsyncSession = Depends(get_db),
    user: models.User = Depends(get_current_user),
):
    """Fire the workflow right now (in the background). Returns the
    workflow row with last_run_status=running so the UI can show the
    spinner immediately; polling for the final status comes from the
    regular GET list."""
    wf = await _load(db, workflow_id, user)
    if wf.last_run_status == "running":
        raise HTTPException(409, "이미 실행 중입니다")
    wf.last_run_status = "running"
    wf.last_error = None
    await db.commit()
    task = asyncio.get_running_loop().create_task(run_workflow(wf.id))
    _BACKGROUND_RUN_TASKS.add(task)
    task.add_done_callback(_BACKGROUND_RUN_TASKS.discard)
    await db.refresh(wf)
    return await _serialize(db, wf)
