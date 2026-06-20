"""code.py 가 2266줄로 커져 분리.  이 파일의 모든 route 는
code._core.router (prefix='/api/code') 에 직접 등록된다.  main.py 의
include_router 는 code 패키지의 단일 router 만 부르므로 분할은
internal-only — public API 는 그대로."""
from __future__ import annotations

import asyncio
import logging
import os
import shutil
from datetime import datetime, timezone
from pathlib import Path

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from ... import models, schemas
from ...auth import get_current_user
from ...config import settings
from ...database import get_db
from ...code.workspace import (
    activity_heatmap,
    ai_changelog,
    ai_commit_message,
    ai_document_file,
    ai_generate_tests,
    ai_refactor_file,
    ai_review_diff,
    ai_security_summarize,
    apply_file_write,
    bulk_delete,
    contributor_stats,
    extract_outline,
    extract_zip_into,
    file_diff_between,
    file_git_log,
    git_cherry_pick,
    git_reset,
    git_revert_file,
    is_git_workdir,
    load_custom_tasks,
    parse_dependencies,
    run_custom_task,
    scan_security,
    search_symbols,
    tag_create,
    tag_delete,
    tag_list,
    tag_push,
    workspace_grep,
    workspace_stats,
    write_uploaded_file,
)
from ...crypto import decrypt_secret

from ._core import (
    _MAX_SAVE_FILE_BYTES,
    _BranchOp,
    _BulkDelete,
    _CherryPick,
    _ConflictResolve,
    _CustomTaskRun,
    _GitReset,
    _PathOnly,
    _TagCreate,
    _fetch_workspace_owned_by,
    router,
)

# ── AI 리팩터 / 테스트 생성 (#68) ───────────────────────────
@router.post("/workspaces/{workspace_id}/ai-refactor")
async def workspace_ai_refactor(
    workspace_id: str,
    payload: _PathOnly,
    db: AsyncSession = Depends(get_db),
    user: models.User = Depends(get_current_user),
):
    ws = await _fetch_workspace_owned_by(workspace_id, user, db)
    dest = Path(ws.local_path)
    if not dest.is_dir():
        raise HTTPException(409, "워크스페이스 디렉터리가 사라졌어요")
    path = payload.path.strip()
    if not path:
        raise HTTPException(400, "path 가 필요해요")
    try:
        info = await asyncio.get_running_loop().run_in_executor(
            None, read_file, dest, path
        )
    except (ValueError, RuntimeError) as exc:
        raise HTTPException(400, str(exc))
    model = settings.model_auto_code or settings.ollama_model
    try:
        text = await ai_refactor_file(
            info.get("text") or "", path, model, settings.ollama_base_url
        )
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(502, f"리팩터 실패: {exc}") from exc
    return {"path": path, "review": text, "model": model}


@router.post("/workspaces/{workspace_id}/ai-tests")
async def workspace_ai_tests(
    workspace_id: str,
    payload: _PathOnly,
    db: AsyncSession = Depends(get_db),
    user: models.User = Depends(get_current_user),
):
    ws = await _fetch_workspace_owned_by(workspace_id, user, db)
    dest = Path(ws.local_path)
    if not dest.is_dir():
        raise HTTPException(409, "워크스페이스 디렉터리가 사라졌어요")
    path = payload.path.strip()
    if not path:
        raise HTTPException(400, "path 가 필요해요")
    try:
        info = await asyncio.get_running_loop().run_in_executor(
            None, read_file, dest, path
        )
    except (ValueError, RuntimeError) as exc:
        raise HTTPException(400, str(exc))
    model = settings.model_auto_code or settings.ollama_model
    try:
        text = await ai_generate_tests(
            info.get("text") or "", path, model, settings.ollama_base_url
        )
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(502, f"테스트 생성 실패: {exc}") from exc
    return {"path": path, "tests": text, "model": model}


# ── 파일 활동 타임라인 (#70) ────────────────────────────────
@router.get("/workspaces/{workspace_id}/file-timeline")
async def workspace_file_timeline(
    workspace_id: str,
    path: str = Query(...),
    limit: int = Query(50, ge=1, le=200),
    db: AsyncSession = Depends(get_db),
    user: models.User = Depends(get_current_user),
):
    ws = await _fetch_workspace_owned_by(workspace_id, user, db)
    dest = Path(ws.local_path)
    if not dest.is_dir():
        raise HTTPException(409, "워크스페이스 디렉터리가 사라졌어요")
    git_items: list[dict] = []
    if is_git_workdir(dest):
        try:
            git_items = await asyncio.get_running_loop().run_in_executor(
                None, file_git_log, dest, path, limit
            )
        except ValueError as exc:
            raise HTTPException(400, str(exc))
    # 채팅 메시지에서 이 경로를 언급한 답변도 같이 모음 — 사용자 본인의
    # 세션만, 최근 N개.  검색 비용을 줄이려 attachments_summary + content
    # 둘 다 LIKE 검색.
    chat_items: list[dict] = []
    if path.strip():
        like = f"%{path.strip()}%"
        from sqlalchemy import or_, select as _sel
        rows = (
            await db.execute(
                _sel(
                    models.Message.id,
                    models.Message.session_id,
                    models.Message.role,
                    models.Message.content,
                    models.Message.created_at,
                )
                .join(
                    models.Session,
                    models.Session.id == models.Message.session_id,
                )
                .where(models.Session.user_id == user.id)
                .where(
                    or_(
                        models.Message.content.ilike(like),
                        models.Message.attachments_summary.ilike(like),
                    )
                )
                .order_by(models.Message.created_at.desc())
                .limit(limit)
            )
        ).all()
        for mid, sid, role, content, when in rows:
            snippet = (content or "")[:240]
            chat_items.append(
                {
                    "message_id": mid,
                    "session_id": sid,
                    "role": role,
                    "snippet": snippet,
                    "when": when.isoformat() if when else None,
                }
            )
    return {"path": path, "commits": git_items, "chats": chat_items}


# ── git 태그 (#75) ─────────────────────────────────────────
@router.get("/workspaces/{workspace_id}/tags")
async def workspace_tags(
    workspace_id: str,
    db: AsyncSession = Depends(get_db),
    user: models.User = Depends(get_current_user),
):
    ws = await _fetch_workspace_owned_by(workspace_id, user, db)
    dest = Path(ws.local_path)
    if not dest.is_dir() or not is_git_workdir(dest):
        return {"tags": []}
    items = await asyncio.get_running_loop().run_in_executor(
        None, tag_list, dest
    )
    return {"tags": items}


@router.post("/workspaces/{workspace_id}/tag")
async def workspace_tag_create(
    workspace_id: str,
    payload: _TagCreate,
    db: AsyncSession = Depends(get_db),
    user: models.User = Depends(get_current_user),
):
    ws = await _fetch_workspace_owned_by(workspace_id, user, db)
    dest = Path(ws.local_path)
    if not dest.is_dir() or not is_git_workdir(dest):
        raise HTTPException(400, "git 워크스페이스가 아니에요")
    name = payload.name.strip()
    message = payload.message
    ref = payload.ref.strip()
    try:
        return await asyncio.get_running_loop().run_in_executor(
            None, tag_create, dest, name, message, ref
        )
    except ValueError as exc:
        raise HTTPException(400, str(exc))
    except RuntimeError as exc:
        raise HTTPException(409, str(exc))


@router.delete("/workspaces/{workspace_id}/tag")
async def workspace_tag_delete(
    workspace_id: str,
    name: str = Query(...),
    db: AsyncSession = Depends(get_db),
    user: models.User = Depends(get_current_user),
):
    ws = await _fetch_workspace_owned_by(workspace_id, user, db)
    dest = Path(ws.local_path)
    if not dest.is_dir() or not is_git_workdir(dest):
        raise HTTPException(400, "git 워크스페이스가 아니에요")
    try:
        return await asyncio.get_running_loop().run_in_executor(
            None, tag_delete, dest, name
        )
    except ValueError as exc:
        raise HTTPException(400, str(exc))
    except RuntimeError as exc:
        raise HTTPException(409, str(exc))


@router.post("/workspaces/{workspace_id}/tag/push")
async def workspace_tag_push(
    workspace_id: str,
    payload: _BranchOp,
    db: AsyncSession = Depends(get_db),
    user: models.User = Depends(get_current_user),
):
    ws = await _fetch_workspace_owned_by(workspace_id, user, db)
    dest = Path(ws.local_path)
    if not dest.is_dir() or not is_git_workdir(dest):
        raise HTTPException(400, "git 워크스페이스가 아니에요")
    if not ws.git_url:
        raise HTTPException(400, "원격이 없는 워크스페이스에는 push 할 수 없어요")
    # auth 가 필요한 git_url 이면 기존 commit/push 흐름과 같이 토큰 합성.
    push_url = ws.git_url
    if ws.auth_username and ws.auth_token_encrypted:
        try:
            token = decrypt_secret(ws.auth_token_encrypted)
        except Exception:
            token = None
        if token:
            # https://user:token@host/...
            from urllib.parse import urlparse, quote
            u = urlparse(ws.git_url)
            if u.scheme.startswith("http"):
                push_url = (
                    f"{u.scheme}://{quote(ws.auth_username)}:{quote(token)}"
                    f"@{u.netloc}{u.path}"
                )
    name = payload.name.strip()
    try:
        return await asyncio.get_running_loop().run_in_executor(
            None, tag_push, dest, name, push_url
        )
    except ValueError as exc:
        raise HTTPException(400, str(exc))
    except RuntimeError as exc:
        raise HTTPException(409, str(exc))


# ── AI 문서화 (#72) ────────────────────────────────────────
@router.post("/workspaces/{workspace_id}/ai-document")
async def workspace_ai_document(
    workspace_id: str,
    payload: _PathOnly,
    db: AsyncSession = Depends(get_db),
    user: models.User = Depends(get_current_user),
):
    ws = await _fetch_workspace_owned_by(workspace_id, user, db)
    dest = Path(ws.local_path)
    if not dest.is_dir():
        raise HTTPException(409, "워크스페이스 디렉터리가 사라졌어요")
    path = payload.path.strip()
    if not path:
        raise HTTPException(400, "path 가 필요해요")
    try:
        info = await asyncio.get_running_loop().run_in_executor(
            None, read_file, dest, path
        )
    except (ValueError, RuntimeError) as exc:
        raise HTTPException(400, str(exc))
    model = settings.model_auto_code or settings.ollama_model
    try:
        text = await ai_document_file(
            info.get("text") or "", path, model, settings.ollama_base_url
        )
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(502, f"문서화 실패: {exc}") from exc
    return {"path": path, "documented": text, "model": model}


# ── AI 보안 점검 (#74) ─────────────────────────────────────
@router.post("/workspaces/{workspace_id}/security-scan")
async def workspace_security_scan(
    workspace_id: str,
    db: AsyncSession = Depends(get_db),
    user: models.User = Depends(get_current_user),
):
    ws = await _fetch_workspace_owned_by(workspace_id, user, db)
    dest = Path(ws.local_path)
    if not dest.is_dir():
        raise HTTPException(409, "워크스페이스 디렉터리가 사라졌어요")
    findings = await asyncio.get_running_loop().run_in_executor(
        None, scan_security, dest
    )
    model = settings.model_auto_code or settings.ollama_model
    try:
        summary = await ai_security_summarize(
            findings, model, settings.ollama_base_url
        )
    except Exception as exc:  # noqa: BLE001
        summary = f"(LLM 분석 실패: {exc})"
    return {
        "count": len(findings),
        "findings": findings,
        "summary": summary,
        "model": model,
    }


# ── 의존성 dashboard (#76) ─────────────────────────────────
@router.get("/workspaces/{workspace_id}/dependencies")
async def workspace_dependencies(
    workspace_id: str,
    db: AsyncSession = Depends(get_db),
    user: models.User = Depends(get_current_user),
):
    ws = await _fetch_workspace_owned_by(workspace_id, user, db)
    dest = Path(ws.local_path)
    if not dest.is_dir():
        raise HTTPException(409, "워크스페이스 디렉터리가 사라졌어요")
    result = await asyncio.get_running_loop().run_in_executor(
        None, parse_dependencies, dest
    )
    return {"managers": result}


# ── 체리픽 / 리셋 (#77) ────────────────────────────────────
@router.post("/workspaces/{workspace_id}/cherry-pick")
async def workspace_cherry_pick(
    workspace_id: str,
    payload: _CherryPick,
    db: AsyncSession = Depends(get_db),
    user: models.User = Depends(get_current_user),
):
    ws = await _fetch_workspace_owned_by(workspace_id, user, db)
    dest = Path(ws.local_path)
    if not dest.is_dir() or not is_git_workdir(dest):
        raise HTTPException(400, "git 워크스페이스가 아니에요")
    sha = payload.sha.strip()
    try:
        return await asyncio.get_running_loop().run_in_executor(
            None, git_cherry_pick, dest, sha
        )
    except ValueError as exc:
        raise HTTPException(400, str(exc))
    except RuntimeError as exc:
        raise HTTPException(409, str(exc))


@router.post("/workspaces/{workspace_id}/reset")
async def workspace_reset(
    workspace_id: str,
    payload: _GitReset,
    db: AsyncSession = Depends(get_db),
    user: models.User = Depends(get_current_user),
):
    ws = await _fetch_workspace_owned_by(workspace_id, user, db)
    dest = Path(ws.local_path)
    if not dest.is_dir() or not is_git_workdir(dest):
        raise HTTPException(400, "git 워크스페이스가 아니에요")
    sha = payload.sha.strip()
    mode = payload.mode.strip()
    try:
        return await asyncio.get_running_loop().run_in_executor(
            None, git_reset, dest, sha, mode
        )
    except ValueError as exc:
        raise HTTPException(400, str(exc))
    except RuntimeError as exc:
        raise HTTPException(409, str(exc))


# ── 브랜치 비교 (#78) ──────────────────────────────────────
@router.get("/workspaces/{workspace_id}/compare")
async def workspace_compare(
    workspace_id: str,
    base: str = Query(...),
    head: str = Query(...),
    db: AsyncSession = Depends(get_db),
    user: models.User = Depends(get_current_user),
):
    ws = await _fetch_workspace_owned_by(workspace_id, user, db)
    dest = Path(ws.local_path)
    if not dest.is_dir() or not is_git_workdir(dest):
        raise HTTPException(400, "git 워크스페이스가 아니에요")
    try:
        files = await asyncio.get_running_loop().run_in_executor(
            None, compare_refs, dest, base, head
        )
    except ValueError as exc:
        raise HTTPException(400, str(exc))
    except RuntimeError as exc:
        raise HTTPException(500, str(exc))
    return {"base": base, "head": head, "files": files}


@router.get("/workspaces/{workspace_id}/compare/file")
async def workspace_compare_file(
    workspace_id: str,
    base: str = Query(...),
    head: str = Query(...),
    path: str = Query(...),
    db: AsyncSession = Depends(get_db),
    user: models.User = Depends(get_current_user),
):
    ws = await _fetch_workspace_owned_by(workspace_id, user, db)
    dest = Path(ws.local_path)
    if not dest.is_dir() or not is_git_workdir(dest):
        raise HTTPException(400, "git 워크스페이스가 아니에요")
    try:
        return await asyncio.get_running_loop().run_in_executor(
            None, file_diff_between, dest, base, head, path
        )
    except ValueError as exc:
        raise HTTPException(400, str(exc))


# ── 파일 outline (#80) ─────────────────────────────────────
@router.get("/workspaces/{workspace_id}/outline")
async def workspace_outline(
    workspace_id: str,
    path: str = Query(...),
    db: AsyncSession = Depends(get_db),
    user: models.User = Depends(get_current_user),
):
    ws = await _fetch_workspace_owned_by(workspace_id, user, db)
    dest = Path(ws.local_path)
    if not dest.is_dir():
        raise HTTPException(409, "워크스페이스 디렉터리가 사라졌어요")
    try:
        info = await asyncio.get_running_loop().run_in_executor(
            None, read_file, dest, path
        )
    except (ValueError, RuntimeError) as exc:
        raise HTTPException(400, str(exc))
    ext = path.split(".")[-1] if "." in path else ""
    items = extract_outline(info.get("text") or "", ext)
    return {"path": path, "items": items}


# ── 컨트리뷰터 통계 (#81) ──────────────────────────────────
@router.get("/workspaces/{workspace_id}/contributors")
async def workspace_contributors(
    workspace_id: str,
    limit: int = Query(50, ge=1, le=500),
    db: AsyncSession = Depends(get_db),
    user: models.User = Depends(get_current_user),
):
    ws = await _fetch_workspace_owned_by(workspace_id, user, db)
    dest = Path(ws.local_path)
    if not dest.is_dir() or not is_git_workdir(dest):
        return {"contributors": []}
    items = await asyncio.get_running_loop().run_in_executor(
        None, contributor_stats, dest, limit
    )
    return {"contributors": items}


# ── 활동 히트맵 (#82) ──────────────────────────────────────
@router.get("/workspaces/{workspace_id}/activity")
async def workspace_activity(
    workspace_id: str,
    days: int = Query(365, ge=7, le=1095),
    db: AsyncSession = Depends(get_db),
    user: models.User = Depends(get_current_user),
):
    ws = await _fetch_workspace_owned_by(workspace_id, user, db)
    dest = Path(ws.local_path)
    if not dest.is_dir() or not is_git_workdir(dest):
        return {"days": days, "weekday_hour": [], "by_day": []}
    return await asyncio.get_running_loop().run_in_executor(
        None, activity_heatmap, dest, days
    )


# ── 심볼 전역 검색 (#83) ────────────────────────────────────
@router.get("/workspaces/{workspace_id}/symbols")
async def workspace_symbols(
    workspace_id: str,
    q: str = Query(""),
    limit: int = Query(200, ge=1, le=2000),
    db: AsyncSession = Depends(get_db),
    user: models.User = Depends(get_current_user),
):
    ws = await _fetch_workspace_owned_by(workspace_id, user, db)
    dest = Path(ws.local_path)
    if not dest.is_dir():
        raise HTTPException(409, "워크스페이스 디렉터리가 사라졌어요")
    items = await asyncio.get_running_loop().run_in_executor(
        None, search_symbols, dest, q, limit
    )
    return {"query": q, "count": len(items), "items": items}


# ── AI changelog (#84) ────────────────────────────────────
@router.post("/workspaces/{workspace_id}/ai-changelog")
async def workspace_ai_changelog(
    workspace_id: str,
    days: int = Query(7, ge=1, le=90),
    db: AsyncSession = Depends(get_db),
    user: models.User = Depends(get_current_user),
):
    ws = await _fetch_workspace_owned_by(workspace_id, user, db)
    dest = Path(ws.local_path)
    if not dest.is_dir() or not is_git_workdir(dest):
        raise HTTPException(400, "git 워크스페이스가 아니에요")
    model = settings.model_auto_code or settings.ollama_model
    try:
        return await ai_changelog(dest, days, model, settings.ollama_base_url)
    except RuntimeError as exc:
        raise HTTPException(502, str(exc))


# ── drag-drop 파일 업로드 (#85) ─────────────────────────────
from fastapi import File, Form, UploadFile


@router.post("/workspaces/{workspace_id}/upload-file")
async def workspace_upload_file(
    workspace_id: str,
    file: UploadFile = File(...),
    path: str = Form(...),
    db: AsyncSession = Depends(get_db),
    user: models.User = Depends(get_current_user),
):
    ws = await _fetch_workspace_owned_by(workspace_id, user, db)
    dest = Path(ws.local_path)
    if not dest.is_dir():
        raise HTTPException(409, "워크스페이스 디렉터리가 사라졌어요")
    rel = (path or "").strip()
    if not rel:
        raise HTTPException(400, "path 가 필요해요")
    # 한 파일 25MB 가드 — nginx 와 동일.
    raw = await file.read()
    if len(raw) > 25 * 1024 * 1024:
        raise HTTPException(413, "파일이 너무 커요 (>25 MB)")
    try:
        return await asyncio.get_running_loop().run_in_executor(
            None, write_uploaded_file, dest, rel, raw
        )
    except ValueError as exc:
        raise HTTPException(400, str(exc))


# ── zip import (#86) ────────────────────────────────────────
@router.post("/workspaces/{workspace_id}/import-zip")
async def workspace_import_zip(
    workspace_id: str,
    file: UploadFile = File(...),
    db: AsyncSession = Depends(get_db),
    user: models.User = Depends(get_current_user),
):
    ws = await _fetch_workspace_owned_by(workspace_id, user, db)
    dest = Path(ws.local_path)
    if not dest.is_dir():
        raise HTTPException(409, "워크스페이스 디렉터리가 사라졌어요")
    raw = await file.read()
    if len(raw) > 200 * 1024 * 1024:
        raise HTTPException(413, "zip 이 너무 커요 (>200 MB)")
    try:
        result = await asyncio.get_running_loop().run_in_executor(
            None, extract_zip_into, dest, raw
        )
    except ValueError as exc:
        raise HTTPException(400, str(exc))
    # 파일 카운트 갱신.
    try:
        _t, fc, sz = await asyncio.get_running_loop().run_in_executor(
            None, walk_tree, dest
        )
        ws.file_count = fc
        ws.size_bytes = sz
        ws.last_synced_at = datetime.now(timezone.utc)
        await db.commit()
    except Exception:  # noqa: BLE001
        pass
    return result


# ── 다중 일괄 삭제 (#87) ────────────────────────────────────
@router.post("/workspaces/{workspace_id}/bulk-delete")
async def workspace_bulk_delete(
    workspace_id: str,
    payload: _BulkDelete,
    db: AsyncSession = Depends(get_db),
    user: models.User = Depends(get_current_user),
):
    ws = await _fetch_workspace_owned_by(workspace_id, user, db)
    dest = Path(ws.local_path)
    if not dest.is_dir():
        raise HTTPException(409, "워크스페이스 디렉터리가 사라졌어요")
    paths = [p for p in payload.paths if p]
    if not paths:
        raise HTTPException(400, "paths 가 비어 있어요")
    return await asyncio.get_running_loop().run_in_executor(
        None, bulk_delete, dest, paths
    )
