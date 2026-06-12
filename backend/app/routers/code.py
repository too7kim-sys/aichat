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
from ..config import settings
from pathlib import Path

from ..code.workspace import (
    apply_file_write,
    clone_repo,
    collect_workspace_files,
    git_commit,
    git_diff,
    git_push,
    git_revert_file,
    git_status_porcelain,
    is_git_workdir,
    read_file,
    remove_repo,
    sync_repo,
    validate_local_folder,
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

# IMPORTANT: literal routes (no path parameter) must be declared
# BEFORE the dynamic `/{workspace_id}/...` ones below. FastAPI
# matches in registration order; otherwise `_constraints` would be
# captured as workspace_id="_constraints" and 404.

@router.get("/_constraints")
async def workspace_constraints(
    user: models.User = Depends(get_current_user),
):
    """Return the live caps + allow-lists so the create form can
    show the user what's possible BEFORE they submit, and preflight
    obvious violations (host not allowed / path not under any
    configured root)."""
    from ..code import workspace as ws_module
    return {
        "allowed_hosts": settings.workspace_allowed_host_list,
        "local_roots": settings.workspace_local_root_list,
        # ── tree walk caps (file browser side) ──
        "max_files": settings.workspace_max_files,
        "max_size_mb": settings.workspace_max_size_mb,
        "clone_depth": settings.workspace_clone_depth,
        # ── chat-auto-attach caps (collect_workspace_files) ──
        "bundle_max_files": ws_module._BULK_MAX_FILES,
        "bundle_max_total_bytes": ws_module._BULK_MAX_TOTAL_BYTES,
        "bundle_max_per_file_bytes": ws_module._BULK_MAX_BYTES_PER_FILE,
    }


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
    source_type = payload.source_type
    if source_type == "local":
        # ── In-app local workspace ──
        # 사용자가 서버 경로를 직접 입력하지 않는다 (예전엔 입력했지만
        # 서버 파일 시스템이 사용자에게 노출됐다). 대신 git 클론과 같은
        # 자동 생성 경로 (WORKSPACE_DIR/<user>/<workspace_id>) 를 비어
        # 있는 채로 만들고 채팅이 거기다 파일을 생성하게 한다.
        ws = models.CodeWorkspace(
            user_id=user.id,
            name=payload.name.strip(),
            source_type="local",
            git_url="",
            branch="",
            local_path="",   # ws.id 가 정해진 뒤 채움
            auth_username=None,
            auth_token_encrypted=None,
            status="ready",
        )
        db.add(ws)
        await db.flush()
        local_dir = workspace_path_for(user.id, ws.id)
        try:
            local_dir.mkdir(parents=True, exist_ok=True)
        except OSError as exc:
            raise HTTPException(
                500,
                f"워크스페이스 디렉터리 생성 실패: {exc}",
            ) from exc
        ws.local_path = str(local_dir)
        ws.file_count = 0
        ws.size_bytes = 0
        ws.last_synced_at = datetime.now(timezone.utc)
        await db.commit()
        await db.refresh(ws)
        return ws

    # ── Git source (default) ──
    if not (payload.git_url or "").strip():
        raise HTTPException(400, "git_url이 비어 있습니다")
    ws = models.CodeWorkspace(
        user_id=user.id,
        name=payload.name.strip(),
        source_type="git",
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
    # Local workspaces now point at an auto-generated managed directory
    # under WORKSPACE_DIR (사용자가 직접 입력하던 경로가 아니다), so we
    # own it and can safely remove it just like a git clone. Pre-existing
    # rows from the legacy "사용자가 직접 입력한 절대경로" 시대에는
    # local_path 가 WORKSPACE_DIR 밖일 수 있어 remove_repo 가 자체적으로
    # 안전 가드를 한다.
    if ws.local_path and ws.source_type in ("git", "local"):
        freed = await asyncio.get_running_loop().run_in_executor(
            None, remove_repo, ws.local_path
        )
    await db.delete(ws)
    await db.commit()
    # Stale bundle-status cache entries for the deleted workspace
    # expire on their own (TTL=30s, key includes last_synced_at);
    # explicit busts are unnecessary.
    return {"freed_bytes": freed, "removed_files": bool(ws.local_path)}


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

    # Local-folder source: "sync" = rescan the tree. No network, no
    # fetch — just refresh file_count / size_bytes for the UI in case
    # the user changed files outside the app.
    if ws.source_type == "local":
        root = Path(ws.local_path)
        if not root.exists() or not root.is_dir():
            ws.status = "failed"
            ws.error = f"폴더가 더 이상 존재하지 않습니다: {ws.local_path}"
            await db.commit()
            await db.refresh(ws)
            return ws
        try:
            _tree, file_count, total = await asyncio.get_running_loop().run_in_executor(
                None, walk_tree, root
            )
            ws.file_count = file_count
            ws.size_bytes = total
            ws.last_synced_at = datetime.now(timezone.utc)
            ws.error = None
            ws.status = "ready"
        except Exception as exc:  # noqa: BLE001
            ws.status = "failed"
            ws.error = str(exc)[:500]
        await db.commit()
        await db.refresh(ws)
        # bundle-status cache key includes last_synced_at — touching
        # the row above naturally invalidates the previous entry.
        return ws

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


@router.get("/workspaces/{workspace_id}/download.zip")
async def workspace_download_zip(
    workspace_id: str,
    db: AsyncSession = Depends(get_db),
    user: models.User = Depends(get_current_user),
):
    """워크스페이스 전체를 zip 으로 묶어 스트리밍. .git / node_modules
    / __pycache__ 등 큰 무용 디렉터리는 자동 제외. 50 MB 가 넘으면
    409 반환 (큰 워크스페이스는 git 사용을 권장)."""
    import io
    import urllib.parse
    import zipfile
    from fastapi.responses import StreamingResponse

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

    root = Path(ws.local_path)
    if not root.is_dir():
        raise HTTPException(409, "워크스페이스 디렉터리가 사라졌습니다")

    # 제외 패턴 — VCS 메타 / 의존성 캐시 / 빌드 산출물.
    SKIP_DIRS = {
        ".git", ".hg", ".svn", "node_modules", "__pycache__",
        ".venv", "venv", ".idea", ".vscode", "dist", "build",
        ".pytest_cache", ".mypy_cache", ".ruff_cache", "target",
    }
    MAX_BYTES = 50 * 1024 * 1024  # 50 MB cap

    def build_zip() -> bytes:
        buf = io.BytesIO()
        total = 0
        with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as zf:
            for p in root.rglob("*"):
                # 디렉터리 자체는 zip 에 안 넣음 (압축률만 떨어짐).
                if p.is_dir():
                    continue
                # 상위 어디든 SKIP 패턴이 끼면 제외.
                rel = p.relative_to(root)
                parts = set(rel.parts)
                if parts & SKIP_DIRS:
                    continue
                try:
                    size = p.stat().st_size
                except OSError:
                    continue
                if total + size > MAX_BYTES:
                    raise RuntimeError(
                        f"워크스페이스가 너무 큽니다 (>{MAX_BYTES // (1024 * 1024)}MB). "
                        "git push 또는 개별 파일 받기를 사용하세요."
                    )
                total += size
                try:
                    zf.write(p, arcname=str(rel))
                except OSError:
                    continue
        return buf.getvalue()

    try:
        data = await asyncio.get_running_loop().run_in_executor(
            None, build_zip,
        )
    except RuntimeError as exc:
        raise HTTPException(409, str(exc))

    safe = urllib.parse.quote((ws.name or "workspace").replace("/", "_"))
    return StreamingResponse(
        io.BytesIO(data),
        media_type="application/zip",
        headers={
            "Content-Disposition": f"attachment; filename*=UTF-8''{safe}.zip",
            "Content-Length": str(len(data)),
        },
    )


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
    dest = Path(ws.local_path)
    tree, file_count, total = await asyncio.get_running_loop().run_in_executor(
        None, walk_tree, dest
    )
    return {"tree": tree, "file_count": file_count, "size_bytes": total}


# Short-lived bundle-status cache. React StrictMode in dev runs every
# useEffect twice, which would otherwise re-walk a 400-file workspace
# back-to-back; the chat router also calls collect_workspace_files on
# the next turn. A 30-second per-workspace TTL keeps the result fresh
# enough that the operator's "this file just landed" expectation
# holds, while collapsing burst duplicates into a single walk.
_BUNDLE_STATUS_CACHE: dict[str, tuple[float, dict]] = {}
_BUNDLE_STATUS_TTL_S = 30.0


@router.get("/workspaces/{workspace_id}/bundle-status")
async def workspace_bundle_status(
    workspace_id: str,
    refresh: bool = False,
    db: AsyncSession = Depends(get_db),
    user: models.User = Depends(get_current_user),
):
    """Per-file inclusion status the chat side panel uses to mark
    each row in the tree with ✓ (첨부됨) / ⊘ (제외됨, 이유와 함께).
    Re-runs collect_workspace_files so the result reflects the
    exact same selection the next chat turn will see — handy for
    "왜 이 파일은 분석 안 됐어요?" troubleshooting before the user
    even asks a question. Pass `refresh=true` to bypass the
    short-lived cache after a workspace sync."""
    import time as _time

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
    from ..code.workspace import collect_workspace_files
    from ..code import workspace as ws_module

    # Cache key folds in last_synced_at so a background sync that
    # changed the file set automatically invalidates the entry — no
    # need for the sync handler to explicitly busts the cache.
    sync_stamp = (
        ws.last_synced_at.isoformat() if ws.last_synced_at else "none"
    )
    cache_key = f"{user.id}:{workspace_id}:{sync_stamp}"
    now = _time.monotonic()
    if not refresh:
        hit = _BUNDLE_STATUS_CACHE.get(cache_key)
        if hit and now - hit[0] < _BUNDLE_STATUS_TTL_S:
            return hit[1]

    root = Path(ws.local_path)
    bundle = await asyncio.get_running_loop().run_in_executor(
        None, collect_workspace_files, root,
    )
    result = {
        "total_files_in_repo": bundle["total_files_in_repo"],
        "bundled_files": bundle["total_files"],
        "bundled_bytes": bundle["total_size"],
        "skipped_too_large": bundle.get("skipped_too_large", 0),
        "skipped_unsupported_ext": bundle.get("skipped_unsupported_ext", 0),
        "walk_error": bundle.get("walk_error"),
        # Per-file reason map — keys are POSIX paths, values are the
        # raw status string (ok / oversize:N / over-file-cap / …).
        # Frontend turns those into icons + tooltips.
        "file_status": bundle.get("file_status") or {},
        "caps": {
            "max_files": ws_module._BULK_MAX_FILES,
            "max_total_bytes": ws_module._BULK_MAX_TOTAL_BYTES,
            "max_bytes_per_file": ws_module._BULK_MAX_BYTES_PER_FILE,
        },
    }
    _BUNDLE_STATUS_CACHE[cache_key] = (now, result)
    # Trim other users' stale entries opportunistically so the dict
    # never grows unbounded — tiny cost on a cache miss.
    if len(_BUNDLE_STATUS_CACHE) > 64:
        cutoff = now - _BUNDLE_STATUS_TTL_S * 4
        for k in list(_BUNDLE_STATUS_CACHE):
            if _BUNDLE_STATUS_CACHE[k][0] < cutoff:
                del _BUNDLE_STATUS_CACHE[k]
    return result


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

    root = Path(ws.local_path)
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
    dest = Path(ws.local_path)
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
    ws = await _fetch_workspace_owned_by(workspace_id, user, db)
    dest = Path(ws.local_path)
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
    """List dirty files (modified / added / untracked / deleted).
    Returns clean=True with `git=False` for local-folder sources that
    aren't a git working tree — the UI uses that to hide the commit
    panel instead of showing a confusing error."""
    ws = await _fetch_workspace_owned_by(workspace_id, user, db)
    dest = Path(ws.local_path)
    if not is_git_workdir(dest):
        return {"entries": [], "clean": True, "git": False}
    try:
        entries = await asyncio.get_running_loop().run_in_executor(
            None, git_status_porcelain, dest
        )
    except RuntimeError as exc:
        raise HTTPException(500, str(exc))
    return {"entries": entries, "clean": len(entries) == 0, "git": True}


@router.post("/workspaces/{workspace_id}/preview")
async def workspace_preview(
    workspace_id: str,
    payload: schemas.WorkspaceApply,
    db: AsyncSession = Depends(get_db),
    user: models.User = Depends(get_current_user),
):
    """LLM 이 만들어낸 새 파일 내용을 디스크에 쓰지 않고 unified diff 만
    돌려준다. 프론트가 모달에서 보여 사용자가 확인한 뒤에 /apply 로
    실제 적용. 새 파일이면 added=true, 동일하면 unchanged=true."""
    import difflib
    ws = await _fetch_workspace_owned_by(workspace_id, user, db)
    dest = Path(ws.local_path)

    rel = payload.path.lstrip("/")
    if ".." in rel.split("/"):
        raise HTTPException(400, "잘못된 경로")
    target = (dest / rel).resolve()
    try:
        target.relative_to(dest.resolve())
    except ValueError:
        raise HTTPException(400, "워크스페이스 밖 경로")

    existed = target.is_file()
    if existed:
        try:
            old_text = target.read_text(encoding="utf-8", errors="replace")
        except OSError as exc:
            raise HTTPException(500, f"기존 파일 읽기 실패: {exc}")
    else:
        old_text = ""
    new_text = payload.content

    if old_text == new_text:
        return {
            "path": payload.path,
            "added": False,
            "unchanged": True,
            "diff": "",
            "old_lines": len(old_text.splitlines()),
            "new_lines": len(new_text.splitlines()),
        }

    diff_lines = list(
        difflib.unified_diff(
            old_text.splitlines(keepends=True),
            new_text.splitlines(keepends=True),
            fromfile=f"a/{rel}" if existed else "/dev/null",
            tofile=f"b/{rel}",
            n=3,
        )
    )
    return {
        "path": payload.path,
        "added": not existed,
        "unchanged": False,
        "diff": "".join(diff_lines),
        "old_lines": len(old_text.splitlines()),
        "new_lines": len(new_text.splitlines()),
    }


@router.get("/workspaces/{workspace_id}/diff")
async def workspace_diff(
    workspace_id: str,
    path: str | None = Query(default=None, max_length=500),
    db: AsyncSession = Depends(get_db),
    user: models.User = Depends(get_current_user),
):
    """Working tree diff against HEAD. Pass `?path=` to scope to a
    single file; omit it for the whole tree."""
    ws = await _fetch_workspace_owned_by(workspace_id, user, db)
    dest = Path(ws.local_path)
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
    ws = await _fetch_workspace_owned_by(workspace_id, user, db)
    dest = Path(ws.local_path)
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
    dest = Path(ws.local_path)
    if not is_git_workdir(dest):
        raise HTTPException(
            400,
            "이 폴더는 git 저장소가 아닙니다 — 커밋하려면 .git 워킹트리가 필요합니다",
        )
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
        # Git-clone workspaces use the stored token; local-folder
        # workspaces rely on whatever auth the working tree already
        # has configured (SSH agent, credential helper, etc.).
        token = (
            decrypt_secret(ws.auth_token_encrypted)
            if ws.source_type == "git"
            else None
        )
        push_git_url = ws.git_url if ws.source_type == "git" else ""
        try:
            push_result = await asyncio.get_running_loop().run_in_executor(
                None,
                git_push,
                dest,
                push_git_url,
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
    dest = Path(ws.local_path)
    if not is_git_workdir(dest):
        raise HTTPException(
            400,
            "이 폴더는 git 저장소가 아닙니다 — push하려면 .git 워킹트리가 필요합니다",
        )
    token = (
        decrypt_secret(ws.auth_token_encrypted)
        if ws.source_type == "git"
        else None
    )
    push_git_url = ws.git_url if ws.source_type == "git" else ""
    try:
        result = await asyncio.get_running_loop().run_in_executor(
            None,
            git_push,
            dest,
            push_git_url,
            ws.branch,
            ws.auth_username,
            token,
        )
    except ValueError as exc:
        raise HTTPException(400, str(exc))
    except RuntimeError as exc:
        raise HTTPException(500, str(exc))
    return result
