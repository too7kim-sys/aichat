"""HTTP routes for the Code workspace feature (Phase 1)."""
from __future__ import annotations

import asyncio
import logging
from datetime import datetime, timezone

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from .. import models, schemas
from ..auth import get_current_user
from ..code.workspace import (
    clone_repo,
    read_file,
    remove_repo,
    sync_repo,
    walk_tree,
    workspace_path_for,
)
from ..crypto import decrypt_secret, encrypt_secret
from ..database import SessionLocal, get_db

log = logging.getLogger("uvicorn.error")

router = APIRouter(prefix="/api/code", tags=["code"])

_BACKGROUND_TASKS: set[asyncio.Task] = set()


# ── Background helpers ────────────────────────────────────────────────

async def _do_clone(
    workspace_id: str, user_id: str, git_url: str, branch: str,
    username: str | None, token: str | None,
) -> None:
    dest = workspace_path_for(user_id, workspace_id)
    try:
        await asyncio.get_running_loop().run_in_executor(
            None, clone_repo, dest, git_url, branch, username, token,
        )
        tree, file_count, total = await asyncio.get_running_loop().run_in_executor(
            None, walk_tree, dest
        )
        async with SessionLocal() as db:
            row = await db.scalar(
                select(models.CodeWorkspace).where(
                    models.CodeWorkspace.id == workspace_id
                )
            )
            if row:
                row.status = "ready"
                row.file_count = file_count
                row.size_bytes = total
                row.last_synced_at = datetime.now(timezone.utc)
                row.error = None
                await db.commit()
    except Exception as exc:  # noqa: BLE001
        log.exception("Workspace clone failed: %s", workspace_id)
        async with SessionLocal() as db:
            row = await db.scalar(
                select(models.CodeWorkspace).where(
                    models.CodeWorkspace.id == workspace_id
                )
            )
            if row:
                row.status = "failed"
                row.error = str(exc)[:500]
                await db.commit()


async def _do_sync(
    workspace_id: str, user_id: str, git_url: str, branch: str,
    username: str | None, token: str | None,
) -> None:
    dest = workspace_path_for(user_id, workspace_id)
    try:
        await asyncio.get_running_loop().run_in_executor(
            None, sync_repo, dest, git_url, branch, username, token,
        )
        tree, file_count, total = await asyncio.get_running_loop().run_in_executor(
            None, walk_tree, dest
        )
        async with SessionLocal() as db:
            row = await db.scalar(
                select(models.CodeWorkspace).where(
                    models.CodeWorkspace.id == workspace_id
                )
            )
            if row:
                row.status = "ready"
                row.file_count = file_count
                row.size_bytes = total
                row.last_synced_at = datetime.now(timezone.utc)
                row.error = None
                await db.commit()
    except Exception as exc:  # noqa: BLE001
        log.exception("Workspace sync failed: %s", workspace_id)
        async with SessionLocal() as db:
            row = await db.scalar(
                select(models.CodeWorkspace).where(
                    models.CodeWorkspace.id == workspace_id
                )
            )
            if row:
                row.status = "failed"
                row.error = str(exc)[:500]
                await db.commit()


def _schedule(coro) -> None:
    task = asyncio.get_running_loop().create_task(coro)
    _BACKGROUND_TASKS.add(task)
    task.add_done_callback(_BACKGROUND_TASKS.discard)


# ── Routes ────────────────────────────────────────────────────────────

@router.get("/workspaces", response_model=list[schemas.WorkspaceOut])
async def list_workspaces(
    db: AsyncSession = Depends(get_db),
    user: models.User = Depends(get_current_user),
):
    result = await db.execute(
        select(models.CodeWorkspace)
        .where(models.CodeWorkspace.user_id == user.id)
        .order_by(models.CodeWorkspace.created_at.desc())
    )
    return list(result.scalars())


@router.post("/workspaces", response_model=schemas.WorkspaceOut)
async def create_workspace(
    payload: schemas.WorkspaceCreate,
    db: AsyncSession = Depends(get_db),
    user: models.User = Depends(get_current_user),
):
    ws = models.CodeWorkspace(
        user_id=user.id,
        name=payload.name.strip(),
        git_url=payload.git_url.strip(),
        branch=(payload.branch or "").strip(),
        auth_username=(payload.auth_username or "").strip() or None,
        auth_token_encrypted=encrypt_secret(payload.auth_token),
        status="cloning",
    )
    db.add(ws)
    await db.flush()
    ws.local_path = str(workspace_path_for(user.id, ws.id))
    await db.commit()
    await db.refresh(ws)
    _schedule(
        _do_clone(
            ws.id, user.id, ws.git_url, ws.branch,
            ws.auth_username, payload.auth_token,
        )
    )
    return ws


@router.delete("/workspaces/{workspace_id}")
async def delete_workspace(
    workspace_id: str,
    db: AsyncSession = Depends(get_db),
    user: models.User = Depends(get_current_user),
):
    ws = await db.scalar(
        select(models.CodeWorkspace).where(
            models.CodeWorkspace.id == workspace_id,
            models.CodeWorkspace.user_id == user.id,
        )
    )
    if not ws:
        raise HTTPException(404, "workspace not found")
    freed = 0
    if ws.local_path:
        freed = await asyncio.get_running_loop().run_in_executor(
            None, remove_repo, ws.local_path
        )
    await db.delete(ws)
    await db.commit()
    return {"freed_bytes": freed}


@router.post("/workspaces/{workspace_id}/sync", response_model=schemas.WorkspaceOut)
async def sync_workspace(
    workspace_id: str,
    db: AsyncSession = Depends(get_db),
    user: models.User = Depends(get_current_user),
):
    ws = await db.scalar(
        select(models.CodeWorkspace).where(
            models.CodeWorkspace.id == workspace_id,
            models.CodeWorkspace.user_id == user.id,
        )
    )
    if not ws:
        raise HTTPException(404, "workspace not found")
    if ws.status == "cloning":
        raise HTTPException(409, "이미 진행 중입니다")
    token = decrypt_secret(ws.auth_token_encrypted)
    ws.status = "cloning"
    ws.error = None
    await db.commit()
    _schedule(
        _do_sync(
            ws.id, user.id, ws.git_url, ws.branch,
            ws.auth_username, token,
        )
    )
    await db.refresh(ws)
    return ws


@router.get("/workspaces/{workspace_id}/tree")
async def workspace_tree(
    workspace_id: str,
    db: AsyncSession = Depends(get_db),
    user: models.User = Depends(get_current_user),
):
    ws = await db.scalar(
        select(models.CodeWorkspace).where(
            models.CodeWorkspace.id == workspace_id,
            models.CodeWorkspace.user_id == user.id,
        )
    )
    if not ws:
        raise HTTPException(404, "workspace not found")
    if ws.status != "ready":
        raise HTTPException(409, f"준비되지 않음 (status={ws.status})")
    dest = workspace_path_for(user.id, workspace_id)
    tree, file_count, total = await asyncio.get_running_loop().run_in_executor(
        None, walk_tree, dest
    )
    return {"tree": tree, "file_count": file_count, "size_bytes": total}


@router.get("/workspaces/{workspace_id}/file", response_model=schemas.WorkspaceFileContent)
async def workspace_file(
    workspace_id: str,
    path: str = Query(..., min_length=1, max_length=500),
    db: AsyncSession = Depends(get_db),
    user: models.User = Depends(get_current_user),
):
    ws = await db.scalar(
        select(models.CodeWorkspace).where(
            models.CodeWorkspace.id == workspace_id,
            models.CodeWorkspace.user_id == user.id,
        )
    )
    if not ws:
        raise HTTPException(404, "workspace not found")
    if ws.status != "ready":
        raise HTTPException(409, f"준비되지 않음 (status={ws.status})")
    dest = workspace_path_for(user.id, workspace_id)
    try:
        return await asyncio.get_running_loop().run_in_executor(
            None, read_file, dest, path
        )
    except ValueError as exc:
        raise HTTPException(400, str(exc))
    except FileNotFoundError:
        raise HTTPException(404, "파일을 찾을 수 없습니다")
