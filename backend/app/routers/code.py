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
    apply_file_write,
    clone_repo,
    collect_workspace_files,
    git_commit,
    git_diff,
    git_push,
    git_revert_file,
    git_status_porcelain,
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


@router.post("/workspaces/{workspace_id}/start-chat")
async def start_chat_from_workspace(
    workspace_id: str,
    db: AsyncSession = Depends(get_db),
    user: models.User = Depends(get_current_user),
):
    """Spin up — or RESUME — the chat session tied to this workspace.

    Every workspace owns at most one persistent chat. If the user
    has clicked this card before, we return that session's id (the
    UI just flips activeId to it). Only when no prior session
    exists do we create a fresh one. Either way the response shape
    is identical so the caller can stay agnostic, with `reused`
    telling it whether to expect history."""
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

    # Reuse an existing chat pinned to the workspace before creating
    # a new row. Pick the most-recently-updated one in the unlikely
    # case multiple exist (legacy data from before this dedupe).
    existing = await db.scalar(
        select(models.Session)
        .where(
            models.Session.workspace_id == ws.id,
            models.Session.user_id == user.id,
        )
        .order_by(models.Session.updated_at.desc())
    )
    if existing is not None:
        session = existing
        # Make sure code_focused is set even on legacy rows that
        # predate the column. Idempotent.
        if not session.code_focused:
            session.code_focused = True
            await db.commit()
            await db.refresh(session)
        reused = True
    else:
        session = models.Session(
            title=(ws.name or "Code workspace")[:200],
            user_id=user.id,
            mode="single",
            workspace_id=ws.id,
            code_focused=True,
        )
        db.add(session)
        await db.commit()
        await db.refresh(session)
        reused = False

    root = workspace_path_for(user.id, workspace_id)
    bundle = await asyncio.get_running_loop().run_in_executor(
        None, collect_workspace_files, root
    )

    return {
        "session_id": session.id,
        "title": session.title,
        "workspace_id": ws.id,
        "workspace_name": ws.name,
        "reused": reused,
        "file_count": bundle["total_files"],
        "truncated": bundle["truncated"],
        "total_files_in_repo": bundle["total_files_in_repo"],
    }


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


# ── Phase 2: apply / status / diff / commit / push ────────────────────

async def _fetch_workspace_owned_by(
    workspace_id: str, user: models.User, db: AsyncSession
) -> models.CodeWorkspace:
    """Common guard used by every Phase-2 endpoint — fetch the row,
    enforce ownership, require status==ready."""
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
    return ws


@router.post("/workspaces/{workspace_id}/apply")
async def workspace_apply(
    workspace_id: str,
    payload: schemas.WorkspaceApply,
    db: AsyncSession = Depends(get_db),
    user: models.User = Depends(get_current_user),
):
    """Write the LLM-generated content to a workspace file (no git
    add/commit yet — the user reviews the dirty list before
    committing)."""
    await _fetch_workspace_owned_by(workspace_id, user, db)
    dest = workspace_path_for(user.id, workspace_id)
    try:
        return await asyncio.get_running_loop().run_in_executor(
            None, apply_file_write, dest, payload.path, payload.content
        )
    except ValueError as exc:
        raise HTTPException(400, str(exc))


@router.get("/workspaces/{workspace_id}/status")
async def workspace_status(
    workspace_id: str,
    db: AsyncSession = Depends(get_db),
    user: models.User = Depends(get_current_user),
):
    """List dirty files (modified / added / untracked / deleted)."""
    await _fetch_workspace_owned_by(workspace_id, user, db)
    dest = workspace_path_for(user.id, workspace_id)
    try:
        entries = await asyncio.get_running_loop().run_in_executor(
            None, git_status_porcelain, dest
        )
    except RuntimeError as exc:
        raise HTTPException(500, str(exc))
    return {"entries": entries, "clean": len(entries) == 0}


@router.get("/workspaces/{workspace_id}/diff")
async def workspace_diff(
    workspace_id: str,
    path: str | None = Query(default=None, max_length=500),
    db: AsyncSession = Depends(get_db),
    user: models.User = Depends(get_current_user),
):
    """Working tree diff against HEAD. Pass `?path=` to scope to a
    single file; omit it for the whole tree."""
    await _fetch_workspace_owned_by(workspace_id, user, db)
    dest = workspace_path_for(user.id, workspace_id)
    try:
        text = await asyncio.get_running_loop().run_in_executor(
            None, git_diff, dest, path
        )
    except ValueError as exc:
        raise HTTPException(400, str(exc))
    except RuntimeError as exc:
        raise HTTPException(500, str(exc))
    return {"diff": text, "path": path}


@router.post("/workspaces/{workspace_id}/revert")
async def workspace_revert(
    workspace_id: str,
    payload: dict,
    db: AsyncSession = Depends(get_db),
    user: models.User = Depends(get_current_user),
):
    """Discard local changes to a single file. Body: {"path": "..."}."""
    rel = (payload or {}).get("path")
    if not isinstance(rel, str) or not rel.strip():
        raise HTTPException(400, "path가 필요합니다")
    await _fetch_workspace_owned_by(workspace_id, user, db)
    dest = workspace_path_for(user.id, workspace_id)
    try:
        return await asyncio.get_running_loop().run_in_executor(
            None, git_revert_file, dest, rel
        )
    except ValueError as exc:
        raise HTTPException(400, str(exc))
    except RuntimeError as exc:
        raise HTTPException(500, str(exc))


@router.post("/workspaces/{workspace_id}/commit")
async def workspace_commit(
    workspace_id: str,
    payload: schemas.WorkspaceCommitRequest,
    db: AsyncSession = Depends(get_db),
    user: models.User = Depends(get_current_user),
):
    """Stage the given paths (or all dirty files if `paths` is empty)
    and create a commit. If `push` is true, also push to origin in
    the same call so the UI can do "commit & push" in one click."""
    ws = await _fetch_workspace_owned_by(workspace_id, user, db)
    dest = workspace_path_for(user.id, workspace_id)
    author_name = (user.name or "").strip() or user.email.split("@")[0]
    author_email = user.email

    try:
        commit_result = await asyncio.get_running_loop().run_in_executor(
            None,
            git_commit,
            dest,
            payload.message,
            list(payload.paths),
            author_name,
            author_email,
        )
    except ValueError as exc:
        raise HTTPException(400, str(exc))
    except RuntimeError as exc:
        raise HTTPException(500, str(exc))

    push_result: dict | None = None
    if payload.push and commit_result.get("committed"):
        token = decrypt_secret(ws.auth_token_encrypted)
        try:
            push_result = await asyncio.get_running_loop().run_in_executor(
                None,
                git_push,
                dest,
                ws.git_url,
                ws.branch,
                ws.auth_username,
                token,
            )
        except ValueError as exc:
            raise HTTPException(400, str(exc))
        except RuntimeError as exc:
            # The commit succeeded, only the push failed — surface
            # both so the UI can say "commit OK, push 실패: …".
            return {
                "commit": commit_result,
                "push": {"pushed": False, "error": str(exc)[:300]},
            }

    return {
        "commit": commit_result,
        "push": push_result,
    }


@router.post("/workspaces/{workspace_id}/push")
async def workspace_push(
    workspace_id: str,
    db: AsyncSession = Depends(get_db),
    user: models.User = Depends(get_current_user),
):
    """Push the current branch to origin using the stored credentials.
    Use this when the user wants to push commits that were created
    outside the LLM patch flow (e.g. a series of commits already in
    place)."""
    ws = await _fetch_workspace_owned_by(workspace_id, user, db)
    dest = workspace_path_for(user.id, workspace_id)
    token = decrypt_secret(ws.auth_token_encrypted)
    try:
        result = await asyncio.get_running_loop().run_in_executor(
            None,
            git_push,
            dest,
            ws.git_url,
            ws.branch,
            ws.auth_username,
            token,
        )
    except ValueError as exc:
        raise HTTPException(400, str(exc))
    except RuntimeError as exc:
        raise HTTPException(500, str(exc))
    return result
