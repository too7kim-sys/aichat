"""CRUD + indexing trigger for RAG projects."""
from __future__ import annotations

from datetime import datetime

from pydantic import BaseModel, Field as PydField
from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from .. import models, schemas
from ..auth import get_current_user, require_admin
from ..config import settings
from ..database import get_db
from ..rag.access import accessible_shared_project_ids, can_access_project
from ..rag.db_drivers import (
    DriverInfo,
    SqlPreviewRequest,
    SqlPreviewResult,
    TestConnectionRequest,
    TestConnectionResult,
    list_drivers,
    preview_sql,
    test_connection,
)
from ..rag.indexer import schedule_incremental, schedule_indexing
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


async def _is_admin(db: AsyncSession, user: models.User) -> bool:
    """True when the user's role resolves to the admin tier (built-in
    'admin' or a custom code with base_role='admin')."""
    if user.role == "admin":
        return True
    if user.role in {"moderator", "user"}:
        return False
    role = (
        await db.execute(
            select(models.Role).where(models.Role.code == user.role)
        )
    ).scalar_one_or_none()
    return role is not None and role.base_role == "admin"


async def _role_codes_for_project(db: AsyncSession, project_id: str) -> list[str]:
    rows = (
        await db.execute(
            select(models.ProjectRoleAccess.role_code).where(
                models.ProjectRoleAccess.project_id == project_id
            )
        )
    ).scalars().all()
    return list(rows)


async def _serialize_project(
    db: AsyncSession, project: models.Project, user: models.User
) -> schemas.ProjectOut:
    """Build a ProjectOut, attaching the shared-project role grants and
    an `owned` flag so the UI can gate owner-only controls."""
    out = schemas.ProjectOut.model_validate(project)
    out.owned = project.user_id == user.id
    if project.is_shared:
        out.role_codes = await _role_codes_for_project(db, project.id)
    return out


async def _set_project_roles(
    db: AsyncSession, project_id: str, role_codes: list[str]
) -> None:
    """Replace the role grants for a project with `role_codes`. Unknown
    codes are silently dropped (validated against the roles table) so a
    stale client can't grant access to a role that no longer exists."""
    valid = set(
        (
            await db.execute(
                select(models.Role.code).where(
                    models.Role.code.in_(role_codes)
                )
            )
        ).scalars().all()
    )
    # Wipe existing grants, re-insert the validated set.
    existing = (
        await db.execute(
            select(models.ProjectRoleAccess).where(
                models.ProjectRoleAccess.project_id == project_id
            )
        )
    ).scalars().all()
    for row in existing:
        await db.delete(row)
    for code in valid:
        db.add(
            models.ProjectRoleAccess(project_id=project_id, role_code=code)
        )


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
    """Personal projects (owned) plus any shared knowledge bases the
    user's role grants access to. Shared projects the user merely
    consumes come back with owned=False so the UI hides delete /
    reindex on them."""
    owned = (
        await db.execute(
            select(models.Project)
            .where(models.Project.user_id == user.id)
            .options(selectinload(models.Project.snapshots))
            .order_by(models.Project.created_at.desc())
        )
    ).scalars().all()

    shared_ids = await accessible_shared_project_ids(
        db, user, ready_only=False
    )
    owned_ids = {p.id for p in owned}
    extra_ids = [pid for pid in shared_ids if pid not in owned_ids]
    shared: list[models.Project] = []
    if extra_ids:
        shared = list(
            (
                await db.execute(
                    select(models.Project)
                    .where(models.Project.id.in_(extra_ids))
                    .options(selectinload(models.Project.snapshots))
                    .order_by(models.Project.created_at.desc())
                )
            ).scalars().all()
        )

    out: list[schemas.ProjectOut] = []
    for p in [*owned, *shared]:
        out.append(await _serialize_project(db, p, user))
    return out


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
    # Code corpus moved to the Code tab (workspaces). Existing rows
    # still serve via retrieval, but creating new ones from Cowork is
    # blocked so we don't grow more "RAG over code" data when a real
    # working-copy + LLM patch loop already covers that use case.
    if payload.corpus_type == "code":
        raise HTTPException(
            400,
            "코드 코퍼스는 Code 탭의 워크스페이스 기능으로 이전되었습니다. "
            "사이드바의 Code 탭에서 워크스페이스를 추가하세요.",
        )
    allowed = _ALLOWED_SOURCE_BY_CORPUS.get(payload.corpus_type, set())
    if payload.source_type not in allowed:
        raise HTTPException(
            400,
            f"'{payload.corpus_type}' 코퍼스에는 '{payload.source_type}' 연결을 "
            f"사용할 수 없습니다. 허용: {', '.join(sorted(allowed))}",
        )
    # sql_query is only meaningful for the connection source — silently
    # drop it on other source types so a stray paste doesn't end up in
    # the DB tied to a project that'll never run it.
    effective_sql = (
        (payload.sql_query or "").strip() or None
        if payload.source_type == "connection"
        else None
    )
    # Shared knowledge bases are admin-only. A non-admin trying to
    # set is_shared gets a clear 403 rather than a silently-personal
    # project that wouldn't behave as they expect.
    if payload.is_shared and not await _is_admin(db, user):
        raise HTTPException(
            403, "공유 지식베이스는 관리자(admin)만 만들 수 있습니다",
        )
    # api_detail_* only apply to the url source — drop them otherwise.
    api_key = (
        (payload.api_detail_key or "").strip() or None
        if payload.source_type == "url"
        else None
    )
    api_url = (
        (payload.api_detail_url or "").strip() or None
        if payload.source_type == "url"
        else None
    )
    project = models.Project(
        user_id=user.id,
        name=payload.name,
        source_type=payload.source_type,
        source_ref=payload.source_ref,
        corpus_type=payload.corpus_type,
        sql_query=effective_sql,
        api_detail_key=api_key,
        api_detail_url=api_url,
        is_shared=payload.is_shared,
        status="pending",
    )
    db.add(project)
    await db.flush()
    if payload.is_shared and payload.role_codes:
        await _set_project_roles(db, project.id, payload.role_codes)
    await _create_snapshot_and_schedule(db, project)
    # Reload with snapshots populated for the response.
    proj = await _project_with_snapshots(db, project.id, user.id)
    return await _serialize_project(db, proj, user)


# IMPORTANT: literal routes (anything that doesn't start with a path
# parameter) must be declared BEFORE the `/{project_id}` catch-all
# below. FastAPI matches in registration order, so a `_storage`
# request would otherwise be captured as `project_id="_storage"`
# and return a 404 from the project lookup.

class _ApiPreviewIn(BaseModel):
    list_url: str = PydField(min_length=1, max_length=500)
    detail_key: str = PydField(min_length=1, max_length=120)
    detail_url: str = PydField(min_length=1, max_length=500)
    limit: int = 3


@router.post("/_api-preview")
async def api_preview(
    payload: _ApiPreviewIn,
    _user: models.User = Depends(get_current_user),
):
    """Preview the list→detail collection before creating the project:
    fetch the list, then up to `limit` item details, and return the
    sampled records + total list size. SELECT-equivalent guard for the
    API source."""
    import asyncio as _asyncio

    from ..rag.api_collect import ApiCollectError, collect_api_details

    def _run():
        return collect_api_details(
            payload.list_url.strip(),
            payload.detail_key.strip(),
            payload.detail_url.strip(),
            limit=max(1, min(payload.limit, 10)),
        )

    try:
        records, total = await _asyncio.wait_for(
            _asyncio.to_thread(_run), timeout=40
        )
    except _asyncio.TimeoutError:
        return {"ok": False, "error": "미리보기 시간 초과 (40초)"}
    except ApiCollectError as exc:
        return {"ok": False, "error": str(exc)}
    except Exception as exc:  # noqa: BLE001
        return {"ok": False, "error": f"{type(exc).__name__}: {exc}"}
    return {
        "ok": True,
        "total": total,
        "sampled": len(records),
        "records": records,
    }


@router.get("/_db-drivers", response_model=list[DriverInfo])
async def db_drivers(
    _user: models.User = Depends(get_current_user),
):
    """Catalog of supported DB drivers for the connection-source form.
    Each entry carries the display label, default port, whether the
    driver is file-based (SQLite) or needs ODBC at the OS level
    (MSSQL / Tibero / Altibase). The frontend renders one form
    variant per driver based on these flags."""
    return list_drivers()


@router.post("/_db-test", response_model=TestConnectionResult)
async def db_test_connection(
    payload: TestConnectionRequest,
    _user: models.User = Depends(get_current_user),
):
    """Build a SQLAlchemy URL from the per-field payload and try to
    open a real connection (with a 20s wall-clock). Returns ok=True
    + a table count on success, or a redacted URL + error string
    that the UI shows next to the test button."""
    return await test_connection(payload)


@router.post("/_db-sql-preview", response_model=SqlPreviewResult)
async def db_sql_preview(
    payload: SqlPreviewRequest,
    _user: models.User = Depends(get_current_user),
):
    """Preview the SELECT the user is about to commit as the
    project's `sql_query`. Bounded to N rows (UI default = 20) so
    the response stays small even when the underlying query would
    fetch millions. SELECT/WITH-only — same guard as the indexer."""
    return await preview_sql(payload)


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


@router.post("/{project_id}/refresh", response_model=schemas.ProjectOut)
async def refresh_now(
    project_id: str,
    db: AsyncSession = Depends(get_db),
    user: models.User = Depends(get_current_user),
):
    """Manual trigger for incremental update — same code path the
    background scheduler runs on a timer. Doesn't create a new
    snapshot; just brings the current one up to date."""
    project = await _project_with_snapshots(db, project_id, user.id)
    if not project:
        raise HTTPException(404, "project not found")
    if not project.current_snapshot_id:
        raise HTTPException(409, "활성 스냅샷이 없습니다. 먼저 인덱싱하세요.")
    if project.status == "indexing":
        raise HTTPException(409, "이미 인덱싱 진행 중입니다")
    schedule_incremental(project.id)
    return project


@router.patch("/{project_id}/schedule", response_model=schemas.ProjectOut)
async def update_schedule(
    project_id: str,
    payload: schemas.ProjectScheduleUpdate,
    db: AsyncSession = Depends(get_db),
    user: models.User = Depends(get_current_user),
):
    project = await _project_with_snapshots(db, project_id, user.id)
    if not project:
        raise HTTPException(404, "project not found")
    project.schedule_interval_minutes = payload.schedule_interval_minutes
    await db.commit()
    return await _project_with_snapshots(db, project.id, user.id)


@router.patch("/{project_id}/access", response_model=schemas.ProjectOut)
async def update_project_access(
    project_id: str,
    payload: schemas.ProjectAccessUpdate,
    db: AsyncSession = Depends(get_db),
    actor: models.User = Depends(require_admin),
):
    """Replace the role→project access grants for a shared knowledge
    base. Admin-only. Marks the project shared if it wasn't already so
    granting a role from the dashboard 'just works'."""
    project = await db.scalar(
        select(models.Project).where(models.Project.id == project_id)
    )
    if not project:
        raise HTTPException(404, "project not found")
    if not project.is_shared:
        project.is_shared = True
    await _set_project_roles(db, project_id, payload.role_codes)
    await db.commit()
    proj = await db.scalar(
        select(models.Project)
        .where(models.Project.id == project_id)
        .options(selectinload(models.Project.snapshots))
    )
    return await _serialize_project(db, proj, actor)


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
