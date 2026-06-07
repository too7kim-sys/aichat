"""CRUD for "Chat projects" — sidebar folders that group related
chat sessions and carry optional per-folder instructions injected
on every turn for member sessions.

Distinct from the RAG `projects` table; the routes live under
`/api/chat-projects` so the namespace doesn't collide with the
existing `/api/projects` (RAG knowledge bases).
"""
from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from .. import models, schemas
from ..auth import get_current_user
from ..database import get_db

router = APIRouter(prefix="/api/chat-projects", tags=["chat-projects"])


async def _serialize(
    db: AsyncSession, project: models.ChatProject
) -> schemas.ChatProjectOut:
    """Pack the row + a live session count so the sidebar can show
    "프로젝트 (N)" without an extra round trip."""
    count = await db.scalar(
        select(func.count(models.Session.id)).where(
            models.Session.chat_project_id == project.id,
        )
    )
    out = schemas.ChatProjectOut.model_validate(project)
    out.session_count = int(count or 0)
    return out


@router.get("", response_model=list[schemas.ChatProjectOut])
async def list_chat_projects(
    db: AsyncSession = Depends(get_db),
    user: models.User = Depends(get_current_user),
):
    rows = (
        await db.execute(
            select(models.ChatProject)
            .where(models.ChatProject.user_id == user.id)
            .order_by(models.ChatProject.created_at.asc())
        )
    ).scalars().all()
    # Fan-out the session count in one query so we don't N+1 the
    # sidebar listing.
    counts: dict[str, int] = {}
    if rows:
        rc = (
            await db.execute(
                select(
                    models.Session.chat_project_id,
                    func.count(models.Session.id),
                ).where(
                    models.Session.chat_project_id.in_([r.id for r in rows])
                ).group_by(models.Session.chat_project_id)
            )
        ).all()
        for pid, n in rc:
            counts[pid] = int(n or 0)
    out: list[schemas.ChatProjectOut] = []
    for r in rows:
        item = schemas.ChatProjectOut.model_validate(r)
        item.session_count = counts.get(r.id, 0)
        out.append(item)
    return out


@router.post("", response_model=schemas.ChatProjectOut)
async def create_chat_project(
    payload: schemas.ChatProjectCreate,
    db: AsyncSession = Depends(get_db),
    user: models.User = Depends(get_current_user),
):
    project = models.ChatProject(
        user_id=user.id,
        name=payload.name.strip(),
        description=payload.description.strip(),
        instructions=payload.instructions,
    )
    db.add(project)
    await db.commit()
    await db.refresh(project)
    return await _serialize(db, project)


async def _owned(
    db: AsyncSession, project_id: str, user: models.User
) -> models.ChatProject:
    project = await db.scalar(
        select(models.ChatProject).where(
            models.ChatProject.id == project_id,
            models.ChatProject.user_id == user.id,
        )
    )
    if not project:
        raise HTTPException(404, "chat project not found")
    return project


@router.get("/{project_id}", response_model=schemas.ChatProjectOut)
async def get_chat_project(
    project_id: str,
    db: AsyncSession = Depends(get_db),
    user: models.User = Depends(get_current_user),
):
    project = await _owned(db, project_id, user)
    return await _serialize(db, project)


@router.patch("/{project_id}", response_model=schemas.ChatProjectOut)
async def update_chat_project(
    project_id: str,
    payload: schemas.ChatProjectUpdate,
    db: AsyncSession = Depends(get_db),
    user: models.User = Depends(get_current_user),
):
    project = await _owned(db, project_id, user)
    if payload.name is not None:
        project.name = payload.name.strip()
    if payload.description is not None:
        project.description = payload.description.strip()
    if payload.instructions is not None:
        project.instructions = payload.instructions
    await db.commit()
    await db.refresh(project)
    return await _serialize(db, project)


@router.delete("/{project_id}")
async def delete_chat_project(
    project_id: str,
    db: AsyncSession = Depends(get_db),
    user: models.User = Depends(get_current_user),
):
    """Drop the chat project. Member sessions survive — their
    `chat_project_id` FK uses ON DELETE SET NULL so they fall back to
    the ungrouped bucket instead of being deleted along with the
    folder. Lets the user reorganise without losing any chat history."""
    project = await _owned(db, project_id, user)
    await db.delete(project)
    await db.commit()
    return {"ok": True}
