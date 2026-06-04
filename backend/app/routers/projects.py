"""CRUD + indexing trigger for RAG projects."""
from __future__ import annotations

from datetime import datetime

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from .. import models, schemas
from ..auth import get_current_user
from ..config import settings
from ..database import get_db
from ..rag.indexer import schedule_indexing
from ..rag.retriever import retrieve
from ..rag.vector import drop_collection, storage_usage_bytes

router = APIRouter(prefix="/api/projects", tags=["projects"])


async def _project_with_snapshots(
    db: AsyncSession, project_id: str, user_id: str
) -> models.Project | None:
    return await db.scalar(
        select(models.Project)
        .where(
            models.Project.id == project_id,
            models.Project.user_id == user_id,
        )
        .options(selectinload(models.Project.snapshots))
    )


def _new_snapshot_label() -> str:
    return datetime.now().strftime("%Y-%m-%d %H:%M")


async def _create_snapshot_and_schedule(
    db: AsyncSession, project: models.Project
) -> models.ProjectSnapshot:
    """Make a new snapshot row, mark it pending, hand its id to the
    background indexer, and make it the project's current snapshot."""
    snap = models.ProjectSnapshot(
        project_id=project.id,
        label=_new_snapshot_label(),
        status="pending",
    )
    db.add(snap)
    await db.flush()
    project.current_snapshot_id = snap.id
    project.status = "pending"
    project.progress_done = 0
    project.progress_total = 0
    project.error = None
    await db.commit()
    await db.refresh(snap)
    schedule_indexing(snap.id)
    return snap


@router.get("", response_model=list[schemas.ProjectOut])
async def list_projects(
    db: AsyncSession = Depends(get_db),
    user: models.User = Depends(get_current_user),
):
    result = await db.execute(
        select(models.Project)
        .where(models.Project.user_id == user.id)
        .options(selectinload(models.Project.snapshots))
        .order_by(models.Project.created_at.desc())
    )
    return list(result.scalars())


_ALLOWED_SOURCE_BY_CORPUS = {
    "code": {"git", "folder"},
    "document": {"sftp", "folder"},
    "api": {"url", "folder", "git"},
    "db": {"connection"},
}


@router.post("", response_model=schemas.ProjectOut)
async def create_project(
    payload: schemas.ProjectCreate,
    db: AsyncSession = Depends(get_db),
    user: models.User = Depends(get_current_user),
):
    if not settings.rag_enabled:
        raise HTTPException(503, "RAG가 비활성화 상태입니다 (.env: RAG_ENABLED=true)")
    allowed = _ALLOWED_SOURCE_BY_CORPUS.get(payload.corpus_type, set())
    if payload.source_type not in allowed:
        raise HTTPException(
            400,
            f"'{payload.corpus_type}' 코퍼스에는 '{payload.source_type}' 연결을 "
            f"사용할 수 없습니다. 허용: {', '.join(sorted(allowed))}",
        )
    project = models.Project(
        user_id=user.id,
        name=payload.name,
        source_type=payload.source_type,
        source_ref=payload.source_ref,
        corpus_type=payload.corpus_type,
        status="pending",
    )
    db.add(project)
    await db.flush()
    await _create_snapshot_and_schedule(db, project)
    # Reload with snapshots populated for the response.
    return await _project_with_snapshots(db, project.id, user.id)


@router.get("/{project_id}", response_model=schemas.ProjectOut)
async def get_project(
    project_id: str,
    db: AsyncSession = Depends(get_db),
    user: models.User = Depends(get_current_user),
):
    project = await _project_with_snapshots(db, project_id, user.id)
    if not project:
        raise HTTPException(404, "project not found")
    return project


@router.post("/{project_id}/reindex", response_model=schemas.ProjectOut)
async def reindex(
    project_id: str,
    db: AsyncSession = Depends(get_db),
    user: models.User = Depends(get_current_user),
):
    project = await _project_with_snapshots(db, project_id, user.id)
    if not project:
        raise HTTPException(404, "project not found")
    if project.status == "indexing":
        raise HTTPException(409, "이미 인덱싱 진행 중입니다")
    await _create_snapshot_and_schedule(db, project)
    return await _project_with_snapshots(db, project.id, user.id)


@router.post(
    "/{project_id}/snapshots/{snapshot_id}/activate",
    response_model=schemas.ProjectOut,
)
async def activate_snapshot(
    project_id: str,
    snapshot_id: str,
    db: AsyncSession = Depends(get_db),
    user: models.User = Depends(get_current_user),
):
    project = await _project_with_snapshots(db, project_id, user.id)
    if not project:
        raise HTTPException(404, "project not found")
    target = next((s for s in project.snapshots if s.id == snapshot_id), None)
    if not target:
        raise HTTPException(404, "snapshot not found")
    if target.status != "ready":
        raise HTTPException(409, f"활성화할 수 없는 상태: {target.status}")
    project.current_snapshot_id = target.id
    # Mirror counters so the project card reflects the active version.
    project.status = target.status
    project.progress_done = target.progress_done
    project.progress_total = target.progress_total
    project.file_count = target.file_count
    project.chunk_count = target.chunk_count
    project.error = target.error
    await db.commit()
    return await _project_with_snapshots(db, project.id, user.id)


@router.delete("/{project_id}/snapshots/{snapshot_id}")
async def delete_snapshot(
    project_id: str,
    snapshot_id: str,
    db: AsyncSession = Depends(get_db),
    user: models.User = Depends(get_current_user),
):
    project = await _project_with_snapshots(db, project_id, user.id)
    if not project:
        raise HTTPException(404, "project not found")
    target = next((s for s in project.snapshots if s.id == snapshot_id), None)
    if not target:
        raise HTTPException(404, "snapshot not found")
    if len(project.snapshots) == 1:
        raise HTTPException(
            409, "마지막 스냅샷은 삭제할 수 없습니다 (프로젝트 자체를 삭제하세요)"
        )
    freed = drop_collection(target.id)
    # If we just deleted the current one, fall back to the most recent
    # remaining snapshot.
    if project.current_snapshot_id == target.id:
        remaining = [s for s in project.snapshots if s.id != target.id]
        remaining.sort(key=lambda s: s.created_at, reverse=True)
        project.current_snapshot_id = remaining[0].id if remaining else None
    await db.delete(target)
    await db.commit()
    return {"freed_bytes": freed}


@router.delete("/{project_id}")
async def delete_project(
    project_id: str,
    db: AsyncSession = Depends(get_db),
    user: models.User = Depends(get_current_user),
):
    project = await _project_with_snapshots(db, project_id, user.id)
    if not project:
        raise HTTPException(404, "project not found")
    # Each snapshot has its own collection; drop them all + capture the
    # total bytes reclaimed so the UI can show a meaningful number.
    freed_total = 0
    for snap in project.snapshots:
        freed_total += drop_collection(snap.id)
    await db.delete(project)
    await db.commit()
    return {"freed_bytes": freed_total}


@router.get("/_storage")
async def storage_overview(
    db: AsyncSession = Depends(get_db),
    user: models.User = Depends(get_current_user),
):
    """Return total disk usage of the RAG vector store (sums across
    every collection, the user's own as well as anyone else's on the
    same backend) so the UI can show a live "사용 중인 저장공간"
    figure. Per-user breakdown would need walking each user's
    Project rows, which we skip until we actually need it."""
    project_count = await db.scalar(
        select(func.count(models.Project.id)).where(
            models.Project.user_id == user.id,
        )
    )
    return {
        "total_bytes": storage_usage_bytes(),
        "project_count": project_count or 0,
    }


@router.get("/{project_id}/search")
async def search_project(
    project_id: str,
    q: str,
    snapshot_id: str | None = None,
    db: AsyncSession = Depends(get_db),
    user: models.User = Depends(get_current_user),
):
    """Debug endpoint — runs retrieval without invoking the LLM.
    Pass snapshot_id to query a historical snapshot instead of the
    current one (useful for the compare-with-old workflow)."""
    project = await _project_with_snapshots(db, project_id, user.id)
    if not project:
        raise HTTPException(404, "project not found")
    if snapshot_id is None and project.status != "ready":
        raise HTTPException(409, f"인덱싱 상태: {project.status}")
    chunks = await retrieve(project_id, q, snapshot_id=snapshot_id)
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
