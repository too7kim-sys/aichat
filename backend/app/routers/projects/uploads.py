"""projects.py 가 1554줄로 커져 부분 분리.  이 파일의 모든 route 는
projects._core.router (prefix='/api/projects') 에 직접 등록.  main.py
의 include_router 는 projects 패키지의 단일 router 만 부르므로 분할은
internal-only."""
from __future__ import annotations

import os
import shutil
from pathlib import Path
from typing import Annotated

from fastapi import APIRouter, Depends, File, HTTPException, Path as PathParam, Query, UploadFile
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from ... import models, schemas
from ...auth import get_current_user
from ...config import settings
from ...database import get_db

from ._core import router

# ── 내 문서 업로드 (upload source) ───────────────────────────────────

@router.get(
    "/{project_id}/uploads",
    response_model=list[schemas.RagUploadedFile],
)
async def list_uploaded_files(
    project_id: str,
    db: AsyncSession = Depends(get_db),
    user: models.User = Depends(get_current_user),
):
    """Files currently sitting under the project's upload directory.
    Owners + admins always see the list; users who only have shared
    role-based access still get a read-only listing so they can
    download the originals of documents that already feed retrieval."""
    project = await db.scalar(
        select(models.Project).where(models.Project.id == project_id)
    )
    if not project:
        raise HTTPException(404, "project not found")
    is_owner = project.user_id == user.id
    is_admin = await _is_admin(db, user)
    has_shared_access = (
        not (is_owner or is_admin)
        and project.is_shared
        and await can_access_project(db, user, project)
    )
    if not (is_owner or is_admin or has_shared_access):
        raise HTTPException(403, "권한이 없습니다")
    if project.source_type != "upload":
        raise HTTPException(409, "업로드 소스 프로젝트가 아닙니다")
    return await _list_uploaded_files_with_status(db, project)


@router.post(
    "/{project_id}/uploads",
    response_model=schemas.RagUploadResult,
)
async def append_uploaded_files(
    project_id: str,
    files: list[UploadFile] = File(...),
    db: AsyncSession = Depends(get_db),
    user: models.User = Depends(get_current_user),
):
    """Accept one or more files (multipart) and write them under the
    project's upload directory. Per-file errors are non-fatal — a
    single bad file (oversize / blocked extension / suspicious magic
    bytes) is reported in the `errors` list and the rest of the
    batch still completes. The indexer doesn't run here — the UI
    calls /reindex once the user is done staging files."""
    project = await db.scalar(
        select(models.Project).where(models.Project.id == project_id)
    )
    if not project:
        raise HTTPException(404, "project not found")
    is_owner = project.user_id == user.id
    is_admin = await _is_admin(db, user)
    if not (is_owner or is_admin):
        raise HTTPException(403, "권한이 없습니다")
    if project.source_type != "upload":
        raise HTTPException(409, "업로드 소스 프로젝트가 아닙니다")

    upload_dir = _project_upload_dir(project.id)
    upload_dir.mkdir(parents=True, exist_ok=True)
    cap_bytes = settings.rag_upload_max_bytes
    cap_files = settings.rag_max_files

    existing = sum(1 for p in upload_dir.rglob("*") if p.is_file())

    accepted: list[Path] = []
    errors: list[schemas.RagUploadError] = []

    async def _process_one(f: UploadFile) -> None:
        """Write one file with all its per-file gates. Raises
        HTTPException on rejection; the outer loop catches it as a
        per-file error so the rest of the batch keeps going."""
        raw_name = f.filename or "untitled"
        ext = Path(raw_name).suffix.lower()
        if existing + len(accepted) >= cap_files:
            raise HTTPException(
                400,
                f"업로드 파일 수 한도 도달 (RAG_MAX_FILES={cap_files})",
            )
        if ext in _UPLOAD_DENY_EXTS:
            raise HTTPException(
                400,
                f"서버 보안 정책상 차단된 확장자: {ext}",
            )
        safe_rel = _sanitize_upload_relpath(raw_name)
        target = _safe_join_upload(upload_dir, safe_rel)
        i = 2
        while target.exists():
            parent = target.parent
            stem = target.stem
            suffix = target.suffix
            target = parent / f"{stem}_{i}{suffix}"
            i += 1
        target.parent.mkdir(parents=True, exist_ok=True)
        total = 0
        sniff = ext not in _TRUSTED_MAGIC_EXTS
        try:
            with target.open("wb") as out_f:
                head = await f.read(32)
                if head and sniff:
                    danger = _sniff_dangerous_magic(head)
                    if danger:
                        out_f.close()
                        target.unlink(missing_ok=True)
                        raise HTTPException(
                            400,
                            f"파일 헤더가 {danger} 시그니처와 일치 (확장자만 바꾼 실행 파일)",
                        )
                if head:
                    total += len(head)
                    out_f.write(head)
                while True:
                    chunk = await f.read(1024 * 1024)
                    if not chunk:
                        break
                    total += len(chunk)
                    if total > cap_bytes:
                        out_f.close()
                        target.unlink(missing_ok=True)
                        raise HTTPException(
                            413,
                            f"파일이 너무 큼 ({total:,} bytes > "
                            f"한도 {cap_bytes // (1024*1024)} MB)",
                        )
                    out_f.write(chunk)
        except HTTPException:
            raise
        except OSError as exc:
            target.unlink(missing_ok=True)
            raise HTTPException(500, f"디스크 쓰기 실패: {exc}") from exc
        accepted.append(target)

    for f in files:
        raw_name = f.filename or "untitled"
        try:
            await _process_one(f)
        except HTTPException as exc:
            log.warning(
                "upload reject project=%s file=%s reason=%s",
                project.id, raw_name, exc.detail,
            )
            errors.append(
                schemas.RagUploadError(filename=raw_name, reason=str(exc.detail))
            )
        except Exception as exc:  # noqa: BLE001
            log.exception(
                "upload unexpected error project=%s file=%s",
                project.id, raw_name,
            )
            errors.append(
                schemas.RagUploadError(
                    filename=raw_name,
                    reason=f"{type(exc).__name__}: {exc}",
                )
            )

    files_out = await _list_uploaded_files_with_status(db, project)
    return schemas.RagUploadResult(files=files_out, errors=errors)


@router.get("/{project_id}/uploads/{filename:path}/download")
async def download_uploaded_file(
    project_id: str,
    filename: str,
    db: AsyncSession = Depends(get_db),
    user: models.User = Depends(get_current_user),
):
    """Return the original bytes of an uploaded file as a download.
    Same access model as the listing endpoint — owner / admin /
    shared-role grant. The `/download` suffix keeps the URL space
    distinct from the DELETE `{filename:path}` route."""
    from fastapi.responses import FileResponse
    import urllib.parse

    project = await db.scalar(
        select(models.Project).where(models.Project.id == project_id)
    )
    if not project:
        raise HTTPException(404, "project not found")
    is_owner = project.user_id == user.id
    is_admin = await _is_admin(db, user)
    has_shared_access = (
        not (is_owner or is_admin)
        and project.is_shared
        and await can_access_project(db, user, project)
    )
    if not (is_owner or is_admin or has_shared_access):
        raise HTTPException(403, "권한이 없습니다")
    if project.source_type != "upload":
        raise HTTPException(409, "업로드 소스 프로젝트가 아닙니다")
    upload_dir = _project_upload_dir(project.id)
    safe_rel = _sanitize_upload_relpath(filename)
    target = _safe_join_upload(upload_dir, safe_rel)
    if not target.is_file():
        raise HTTPException(404, "파일을 찾을 수 없습니다")

    # Force a download — without `attachment` the browser would try
    # to preview unknown types inline. Encode the filename twice: a
    # plain ASCII fallback for legacy clients, plus the RFC-5987
    # filename* parameter so Korean/UTF-8 names survive.
    leaf = Path(safe_rel).name
    ascii_fallback = leaf.encode("ascii", errors="replace").decode(
        "ascii"
    ).replace('"', "_")
    encoded = urllib.parse.quote(leaf, safe="")
    disposition = (
        f'attachment; filename="{ascii_fallback}"; '
        f"filename*=UTF-8''{encoded}"
    )
    return FileResponse(
        path=str(target),
        filename=leaf,
        media_type="application/octet-stream",
        headers={"Content-Disposition": disposition},
    )


@router.get("/{project_id}/chunk-source")
async def download_chunk_source(
    project_id: str,
    filename: str,
    start_line: int = 0,
    end_line: int = 0,
    db: AsyncSession = Depends(get_db),
    user: models.User = Depends(get_current_user),
):
    """채팅 청크 인용에서 호출 — 청크가 가리키는 원본 문서를 다운로드.

    동작 분기:
      · upload  → rag_uploads/<pid>/<filename> 그대로
      · folder  → source_ref/<filename> (경로 트래버설 가드 후)
      · 그 외   → 청크 텍스트 한 줄로 만든 .txt 로 fallback
                  (git/url/sftp 는 인덱싱 시 임시 폴더로만 받아 보존
                   안 함). 사용자가 답변 근거 문구를 그대로 받을 수
                   있게 해 다음 작업에 활용.
    """
    import urllib.parse
    from fastapi.responses import FileResponse, Response

    project = await db.scalar(
        select(models.Project).where(models.Project.id == project_id)
    )
    if not project:
        raise HTTPException(404, "project not found")
    is_owner = project.user_id == user.id
    is_admin = await _is_admin(db, user)
    has_shared = (
        not (is_owner or is_admin)
        and project.is_shared
        and await can_access_project(db, user, project)
    )
    if not (is_owner or is_admin or has_shared):
        raise HTTPException(403, "권한이 없습니다")

    safe_rel = _sanitize_upload_relpath(filename)
    leaf = Path(safe_rel).name or "chunk.txt"

    def _disposition(name: str) -> str:
        ascii_fallback = (
            name.encode("ascii", errors="replace").decode("ascii").replace('"', "_")
        )
        encoded = urllib.parse.quote(name, safe="")
        return (
            f'attachment; filename="{ascii_fallback}"; '
            f"filename*=UTF-8''{encoded}"
        )

    # 1) upload 소스 — 기존 download_uploaded_file 과 같은 경로.
    if project.source_type == "upload":
        upload_dir = _project_upload_dir(project.id)
        target = _safe_join_upload(upload_dir, safe_rel)
        if target.is_file():
            return FileResponse(
                path=str(target),
                filename=leaf,
                media_type="application/octet-stream",
                headers={"Content-Disposition": _disposition(leaf)},
            )

    # 2) folder 소스 — 관리자가 등록한 서버 폴더 안에서 직접 읽음.
    if project.source_type == "folder" and project.source_ref:
        base = Path(project.source_ref).expanduser().resolve()
        if base.is_dir():
            target = (base / safe_rel).resolve()
            try:
                target.relative_to(base)
            except ValueError:
                raise HTTPException(400, "허용 폴더 밖 경로")
            if target.is_file():
                return FileResponse(
                    path=str(target),
                    filename=leaf,
                    media_type="application/octet-stream",
                    headers={"Content-Disposition": _disposition(leaf)},
                )

    # 3) Fallback — 청크 텍스트를 Qdrant payload 에서 찾아 .txt 로.
    try:
        from ..rag.vector import collection_name, get_client
        client = get_client()
        snap = project.current_snapshot_id
        if not snap:
            raise HTTPException(404, "스냅샷이 없습니다")
        cname = collection_name(snap)
        from qdrant_client.http import models as qm
        flt = qm.Filter(
            must=[
                qm.FieldCondition(
                    key="filename", match=qm.MatchValue(value=filename)
                ),
            ]
        )
        scrolled, _ = client.scroll(
            collection_name=cname,
            scroll_filter=flt,
            with_payload=True,
            limit=50,
        )
        matched = None
        for pt in scrolled:
            p = pt.payload or {}
            if (
                int(p.get("start_line", -1)) == start_line
                and int(p.get("end_line", -1)) == end_line
            ):
                matched = p
                break
        if matched is None and scrolled:
            # 정확한 라인 범위가 없어도 첫 청크 본문이라도 줌.
            matched = scrolled[0].payload or {}
        if matched is None:
            raise HTTPException(404, "청크를 찾을 수 없습니다")
        body = (
            f"# {filename}:{start_line}-{end_line}\n"
            f"# project: {project.name} ({project.source_type})\n\n"
            f"{matched.get('text', '')}\n"
        ).encode("utf-8")
        download_name = (
            f"{Path(filename).stem}_L{start_line}-{end_line}.txt"
        )
        return Response(
            content=body,
            media_type="text/plain; charset=utf-8",
            headers={"Content-Disposition": _disposition(download_name)},
        )
    except HTTPException:
        raise
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(500, f"청크 본문 조회 실패: {exc}")


@router.delete("/{project_id}/uploads/{filename:path}")
async def delete_uploaded_file(
    project_id: str,
    filename: str,
    db: AsyncSession = Depends(get_db),
    user: models.User = Depends(get_current_user),
):
    """Remove a single file from the project's upload directory. The
    `filename` path parameter uses FastAPI's `:path` converter so
    forward slashes (nested folders from a webkitdirectory upload)
    survive intact. Doesn't touch the index — the user reindexes when
    they're done editing the file set. Empty parent directories that
    fall out are cleaned up too so the index walker doesn't keep
    seeing them."""
    project = await db.scalar(
        select(models.Project).where(models.Project.id == project_id)
    )
    if not project:
        raise HTTPException(404, "project not found")
    is_owner = project.user_id == user.id
    is_admin = await _is_admin(db, user)
    if not (is_owner or is_admin):
        raise HTTPException(403, "권한이 없습니다")
    if project.source_type != "upload":
        raise HTTPException(409, "업로드 소스 프로젝트가 아닙니다")
    upload_dir = _project_upload_dir(project.id)
    safe_rel = _sanitize_upload_relpath(filename)
    target = _safe_join_upload(upload_dir, safe_rel)
    if not target.is_file():
        raise HTTPException(404, "파일을 찾을 수 없습니다")
    try:
        target.unlink()
    except OSError as exc:
        raise HTTPException(500, f"삭제 실패: {exc}") from exc
    # Walk up and drop any empty parent directories so the upload
    # tree doesn't accumulate leftover folders.
    upload_root = upload_dir.resolve()
    parent = target.parent
    while parent != upload_root and parent.is_dir():
        try:
            if any(parent.iterdir()):
                break
            parent.rmdir()
        except OSError:
            break
        parent = parent.parent
    return {"ok": True}


@router.get("/{project_id}/search")
async def search_project(
    project_id: str,
    q: str,
    snapshot_id: str | None = None,
    filename: str | None = None,
    db: AsyncSession = Depends(get_db),
    user: models.User = Depends(get_current_user),
):
    """Debug endpoint — runs retrieval without invoking the LLM.
    Pass snapshot_id to query a historical snapshot, or `filename` to
    restrict matches to chunks whose source filename contains that
    substring (case-insensitive) — handy for "billing/" type filtering."""
    project = await _project_with_snapshots_for_read(db, project_id, user)
    if not project:
        raise HTTPException(404, "project not found")
    if snapshot_id is None and project.status != "ready":
        raise HTTPException(409, f"인덱싱 상태: {project.status}")
    chunks = await retrieve(
        project_id, q,
        snapshot_id=snapshot_id,
        filename_pattern=filename,
    )
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
