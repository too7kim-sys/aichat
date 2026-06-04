"""CRUD + indexing trigger for RAG projects."""
from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from .. import models, schemas
from ..auth import get_current_user
from ..config import settings
from ..database import get_db
from ..rag.indexer import schedule_indexing
from ..rag.retriever import retrieve
from ..rag.vector import drop_collection

router = APIRouter(prefix="/api/projects", tags=["projects"])


@router.get("", response_model=list[schemas.ProjectOut])
async def list_projects(
    db: AsyncSession = Depends(get_db),
    user: models.User = Depends(get_current_user),
):
    result = await db.execute(
        select(models.Project)
        .where(models.Project.user_id == user.id)
        .order_by(models.Project.created_at.desc())
    )
    return list(result.scalars())


@router.post("", response_model=schemas.ProjectOut)
async def create_project(
    payload: schemas.ProjectCreate,
    db: AsyncSession = Depends(get_db),
    user: models.User = Depends(get_current_user),
):
    if not settings.rag_enabled:
        raise HTTPException(503, "RAG가 비활성화 상태입니다 (.env: RAG_ENABLED=true)")
    project = models.Project(
        user_id=user.id,
        name=payload.name,
        source_type=payload.source_type,
        source_ref=payload.source_ref,
        status="pending",
    )
    db.add(project)
    await db.commit()
    await db.refresh(project)
    # Fire indexing in the background — the response returns immediately
    # so the UI can start polling /status.
    schedule_indexing(project.id)
    return project


@router.get("/{project_id}", response_model=schemas.ProjectOut)
async def get_project(
    project_id: str,
    db: AsyncSession = Depends(get_db),
    user: models.User = Depends(get_current_user),
):
    project = await db.scalar(
        select(models.Project).where(
            models.Project.id == project_id,
            models.Project.user_id == user.id,
        )
    )
    if not project:
        raise HTTPException(404, "project not found")
    return project


@router.post("/{project_id}/reindex", response_model=schemas.ProjectOut)
async def reindex(
    project_id: str,
    db: AsyncSession = Depends(get_db),
    user: models.User = Depends(get_current_user),
):
    project = await db.scalar(
        select(models.Project).where(
            models.Project.id == project_id,
            models.Project.user_id == user.id,
        )
    )
    if not project:
        raise HTTPException(404, "project not found")
    if project.status == "indexing":
        raise HTTPException(409, "이미 인덱싱 진행 중입니다")
    project.status = "pending"
    project.progress_done = 0
    project.progress_total = 0
    project.error = None
    await db.commit()
    await db.refresh(project)
    schedule_indexing(project.id)
    return project


@router.delete("/{project_id}", status_code=204)
async def delete_project(
    project_id: str,
    db: AsyncSession = Depends(get_db),
    user: models.User = Depends(get_current_user),
):
    project = await db.scalar(
        select(models.Project).where(
            models.Project.id == project_id,
            models.Project.user_id == user.id,
        )
    )
    if not project:
        raise HTTPException(404, "project not found")
    drop_collection(project.id)
    await db.delete(project)
    await db.commit()


@router.get("/{project_id}/search")
async def search_project(
    project_id: str,
    q: str,
    db: AsyncSession = Depends(get_db),
    user: models.User = Depends(get_current_user),
):
    """Debug endpoint — runs retrieval without invoking the LLM."""
    project = await db.scalar(
        select(models.Project).where(
            models.Project.id == project_id,
            models.Project.user_id == user.id,
        )
    )
    if not project:
        raise HTTPException(404, "project not found")
    if project.status != "ready":
        raise HTTPException(409, f"인덱싱 상태: {project.status}")
    chunks = await retrieve(project_id, q)
    return [
        {
            "filename": c.filename,
            "start_line": c.start_line,
            "end_line": c.end_line,
            "score": c.score,
            "preview": c.text[:400],
        }
        for c in chunks
    ]
