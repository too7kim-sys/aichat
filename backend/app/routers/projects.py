"""CRUD + indexing trigger for RAG projects."""
from __future__ import annotations

import logging
import re
import shutil
from datetime import datetime, timezone
from pathlib import Path

from pydantic import BaseModel, Field as PydField
from fastapi import APIRouter, Depends, File, HTTPException, UploadFile
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

log = logging.getLogger("uvicorn.error")

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
    """Owner-only fetch. Use for mutating endpoints — write ops on a
    shared knowledge base belong to its owner, not its consumers."""
    return await db.scalar(
        select(models.Project)
        .where(
            models.Project.id == project_id,
            models.Project.user_id == user_id,
        )
        .options(selectinload(models.Project.snapshots))
    )


async def _project_with_snapshots_for_read(
    db: AsyncSession, project_id: str, user: models.User,
) -> models.Project | None:
    """Read-mode fetch: owner OR shared-with-this-user. Use for view +
    retrieval endpoints so users who hold a role grant on a shared KB
    can actually see and search it (the sidebar listing already does
    this — gating the detail endpoint to owner-only made shared rows
    open into a 404)."""
    project = await db.scalar(
        select(models.Project)
        .where(models.Project.id == project_id)
        .options(selectinload(models.Project.snapshots))
    )
    if project is None:
        return None
    if not await can_access_project(db, user, project):
        return None
    return project


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
    "document": {"sftp", "folder", "upload"},
    "api": {"url", "folder", "git"},
    "db": {"connection"},
}


# Files uploaded via the upload-source endpoint land here. Each project
# gets its own subdirectory keyed by project id so we never mix users'
# documents on disk.
_UPLOAD_DENY_EXTS = {
    # Server-side / shell executables — would run if the upload dir is
    # ever served as static content or sourced into the wrong place.
    ".exe", ".dll", ".bat", ".cmd", ".com", ".scr", ".msi", ".ps1",
    ".vbs", ".vbe", ".jse", ".wsf", ".wsh", ".pif", ".lnk", ".url",
    ".reg", ".sys",
    # Java / native libraries — same risk as the above on linux/mac.
    ".jar", ".war", ".ear", ".class", ".so", ".dylib", ".a",
    # Office files with macros (typical phishing vector).
    ".docm", ".dotm", ".xlsm", ".xltm", ".xlsb",
    ".pptm", ".potm", ".ppsm",
    # Disk images / installers / kernel modules — large, opaque, never
    # legitimately part of a 지식베이스.
    ".iso", ".img", ".dmg", ".pkg", ".deb", ".rpm", ".apk", ".ipa",
    ".vhd", ".vmdk", ".ko",
    # Chrome/HTA executables and Windows installers.
    ".hta", ".cpl", ".mst", ".msc",
    # PHP / ASP — only relevant if the upload dir gets misconfigured,
    # but cheap to block.
    ".php", ".phtml", ".phar", ".asp", ".aspx", ".cgi",
}
# Strip path separators + leading dots so a user-supplied "..\..\etc"
# can't escape the per-project upload directory.
_FILENAME_SAFE_RE = re.compile(r"[^A-Za-z0-9._가-힣\- ()\[\]]+")


# Magic-byte signatures for the executable formats we never want on
# disk. Renaming `notepad.exe` to `notepad.pdf` bypasses the extension
# deny-list — sniffing the first 32 bytes catches it because the PE /
# ELF / Mach-O headers are unforgeable. Each entry is (signature,
# offset_to_check_at, human label).
_DANGEROUS_MAGIC: list[tuple[bytes, int, str]] = [
    # Windows PE — EXE, DLL, SYS, OCX, SCR, CPL, …
    (b"MZ", 0, "Windows PE (EXE/DLL/SCR)"),
    # ELF — Linux/BSD executables, shared objects, kernel modules
    (b"\x7fELF", 0, "ELF 실행 파일 / 라이브러리"),
    # Mach-O 32 / 64 bit, big and little endian — macOS binaries
    (b"\xfe\xed\xfa\xce", 0, "Mach-O 실행 파일"),
    (b"\xfe\xed\xfa\xcf", 0, "Mach-O 실행 파일"),
    (b"\xce\xfa\xed\xfe", 0, "Mach-O 실행 파일"),
    (b"\xcf\xfa\xed\xfe", 0, "Mach-O 실행 파일"),
    # 0xCAFEBABE covers Mach-O fat binaries AND Java class files —
    # both are executable code and have no business in a 지식베이스.
    (b"\xca\xfe\xba\xbe", 0, "Java class / Mach-O fat binary"),
    # Windows registry hive
    (b"regf", 0, "Windows 레지스트리 hive"),
]


def _sniff_dangerous_magic(head: bytes) -> str | None:
    """Return a human label when the first bytes look like an
    executable / library / hive that the server should never accept,
    regardless of what extension the client claimed. Returns None for
    everything benign (text, PDF, ZIP-based Office, images, …).

    Callers should normally only invoke this for files whose extension
    ISN'T in `_TRUSTED_MAGIC_EXTS` — every known-safe extension has
    its own format-specific magic, and forcing a header check against
    a tiny signature list invites false positives (a CSV that opens
    with `MZ` as a column header would otherwise read as a Windows
    PE binary).
    """
    for sig, offset, label in _DANGEROUS_MAGIC:
        end = offset + len(sig)
        if len(head) >= end and head[offset:end] == sig:
            return label
    return None


# Extensions where we trust the format and skip the magic-byte sniff.
# Each one has its own well-defined header signature, so a renamed
# EXE *with* a doc extension is still possible — but rarer than the
# false-positive case where a small text/CSV/image accidentally
# matches one of our tiny magic strings.
_TRUSTED_MAGIC_EXTS = {
    # Office / PDF / Hangul
    ".pdf", ".docx", ".doc", ".xlsx", ".xls", ".pptx", ".ppt",
    ".hwp", ".hwpx", ".rtf",
    # Plain text + markup + structured data
    ".txt", ".md", ".markdown", ".log",
    ".csv", ".tsv",
    ".json", ".jsonl", ".xml", ".yaml", ".yml",
    ".ini", ".cfg", ".conf", ".toml", ".properties",
    ".html", ".htm", ".eml", ".tex",
    # Common images (chat attachments often land here too)
    ".png", ".jpg", ".jpeg", ".gif", ".bmp", ".webp",
    ".tiff", ".tif", ".svg",
    # Audio / video (transcription source)
    ".mp3", ".wav", ".m4a", ".webm", ".ogg", ".opus", ".flac",
    ".mp4", ".mkv", ".mov", ".aac",
    # Archives — content extraction is a separate decision; the
    # archive itself is harmless on disk.
    ".zip", ".tar", ".gz", ".bz2", ".xz", ".7z",
}


def _project_upload_dir(project_id: str) -> Path:
    root = Path(settings.rag_upload_dir).resolve()
    root.mkdir(parents=True, exist_ok=True)
    return root / project_id


async def _list_uploaded_files_with_status(
    db: AsyncSession, project: models.Project,
) -> list[schemas.RagUploadedFile]:
    """Walk the project's upload directory and annotate each file
    with its indexing outcome — same ✓ / ⊘ shape the code workspace
    tree uses so "어떤 문서가 인덱스에 들어갔는지" reads at a glance.

    Joins the on-disk listing against the IndexedFile inventory for
    the current snapshot. A file landed in the index → "indexed";
    excluded by the walker (oversize / unsupported ext / empty) →
    the matching reason; not yet seen by any snapshot → "pending"
    (or "no-snapshot" when the project hasn't been indexed at all).
    """
    from ..rag.indexer import _EXTS_BY_TYPE

    upload_dir = _project_upload_dir(project.id)
    if not upload_dir.is_dir():
        return []
    allowed_exts = _EXTS_BY_TYPE.get(project.corpus_type or "document", set())
    cap_bytes = settings.rag_max_bytes_per_file

    # Pull the per-file inventory for the active snapshot in one query
    # so we don't N+1 the listing on a folder with 400 files.
    indexed: dict[str, int] = {}
    if project.current_snapshot_id:
        rows = (
            await db.execute(
                select(
                    models.IndexedFile.filename,
                    models.IndexedFile.chunk_count,
                ).where(
                    models.IndexedFile.snapshot_id
                    == project.current_snapshot_id,
                )
            )
        ).all()
        indexed = {fn: cnt for fn, cnt in rows}

    out: list[schemas.RagUploadedFile] = []
    upload_root = upload_dir.resolve()
    for p in sorted(upload_dir.rglob("*")):
        if not p.is_file():
            continue
        try:
            rel = p.resolve().relative_to(upload_root).as_posix()
            st = p.stat()
        except (OSError, ValueError):
            continue

        # Determine the file's indexing fate. Order matters — the
        # walker's own short-circuits run in this sequence.
        if rel in indexed:
            status = "indexed"
            chunks: int | None = int(indexed[rel] or 0)
        elif not project.current_snapshot_id:
            status = "no-snapshot"
            chunks = None
        elif st.st_size == 0:
            status = "empty"
            chunks = None
        elif st.st_size > cap_bytes:
            status = "oversize"
            chunks = None
        elif p.suffix.lower() not in allowed_exts:
            status = "unsupported-ext"
            chunks = None
        else:
            # Eligible but not in the inventory — was added after
            # the last reindex (or chunking failed silently). UI
            # nudges the user to re-run indexing.
            status = "pending"
            chunks = None

        out.append(
            schemas.RagUploadedFile(
                filename=rel,
                size=st.st_size,
                modified_at=datetime.fromtimestamp(st.st_mtime, tz=timezone.utc),
                index_status=status,
                chunk_count=chunks,
            )
        )
    return out


def _upload_dir_size_bytes(upload_dir: Path) -> int:
    """Walk the upload tree and sum file sizes so the delete response
    can report how many bytes the user is freeing — covers the
    indexer-collection bytes (Qdrant) AND the original files we
    wrote here ourselves. Returns 0 on missing dir / IO errors."""
    if not upload_dir.is_dir():
        return 0
    total = 0
    try:
        for p in upload_dir.rglob("*"):
            if p.is_file():
                try:
                    total += p.stat().st_size
                except OSError:
                    continue
    except OSError:
        return 0
    return total


def _wipe_project_upload_dir(project_id: str) -> int:
    """Remove the per-project upload directory and report how many
    bytes were freed. Idempotent — safe to call when the project
    never had an upload source (returns 0 immediately on a missing
    dir). Called from every code path that destroys a project so a
    leftover folder never lingers on disk after the DB row is gone."""
    upload_dir = _project_upload_dir(project_id)
    if not upload_dir.is_dir():
        return 0
    freed = _upload_dir_size_bytes(upload_dir)
    shutil.rmtree(upload_dir, ignore_errors=True)
    return freed


def _sanitize_upload_name(name: str) -> str:
    """Reduce an uploaded file's filename to something safe to write
    under the per-project upload directory. Drops everything but the
    basename, replaces path separators and unusual characters, and
    rejects empty / dotfile-only results."""
    base = Path(name).name  # strip any client-supplied directory parts
    base = base.lstrip(".")  # don't allow .htaccess-style hidden files
    cleaned = _FILENAME_SAFE_RE.sub("_", base).strip("._ ")
    if not cleaned:
        raise HTTPException(400, "파일명이 유효하지 않습니다")
    return cleaned[:200]  # filesystem-friendly cap


def _sanitize_upload_relpath(name: str) -> str:
    """Same as `_sanitize_upload_name` but accepts a (possibly
    nested) POSIX-style relative path — `webkitRelativePath` from a
    folder picker. Each component is sanitised independently and
    `..` / hidden segments are dropped; the result is the joined
    relative path the backend can write under the upload directory."""
    parts: list[str] = []
    raw = (name or "").replace("\\", "/").strip("/")
    for seg in raw.split("/"):
        seg = seg.strip()
        if not seg or seg in (".", ".."):
            continue
        seg = seg.lstrip(".")
        cleaned = _FILENAME_SAFE_RE.sub("_", seg).strip("._ ")
        if not cleaned:
            continue
        parts.append(cleaned[:200])
    if not parts:
        raise HTTPException(400, "파일 경로가 유효하지 않습니다")
    return "/".join(parts)


def _safe_join_upload(upload_dir: Path, relpath: str) -> Path:
    """Resolve a sanitised relative path against the upload directory
    and verify the result stays inside it — defence-in-depth against
    a malicious `..` segment that slipped past the sanitiser."""
    target = (upload_dir / relpath).resolve()
    try:
        target.relative_to(upload_dir.resolve())
    except ValueError as exc:
        raise HTTPException(400, "경로가 업로드 디렉토리를 벗어납니다") from exc
    return target


async def prune_old_snapshots(
    db: AsyncSession, project_id: str,
) -> tuple[int, int]:
    """Drop snapshots beyond the project's retention window. Keeps
    the most recent `snapshot_retention_count` ready+failed rows,
    plus whichever snapshot is currently active (even if it would
    otherwise have aged out — never orphan the live index).

    Returns `(snapshots_dropped, bytes_freed)`. Called from the
    indexer after a fresh snapshot lands "ready" so the table doesn't
    grow without bound under a busy auto-refresh schedule, and from
    the PATCH endpoint when the user tightens the retention setting.
    """
    project = await db.scalar(
        select(models.Project).where(models.Project.id == project_id)
    )
    if not project:
        return 0, 0
    keep = project.snapshot_retention_count
    if keep is None or keep <= 0:
        return 0, 0  # unlimited

    snapshots = (
        await db.execute(
            select(models.ProjectSnapshot)
            .where(models.ProjectSnapshot.project_id == project_id)
            .order_by(models.ProjectSnapshot.created_at.desc())
        )
    ).scalars().all()
    if len(snapshots) <= keep:
        return 0, 0

    # Never delete an in-flight indexing job — it'd leave the Qdrant
    # collection mid-write and the project status stuck on
    # "indexing". The retention window only thins finished history.
    safe_to_drop = [
        s for s in snapshots
        if s.status not in ("pending", "indexing")
        and s.id != project.current_snapshot_id
    ]
    # Determine which finished snapshots to keep (most recent N after
    # always-keep set). Build the keep set from the ordered list.
    always_keep: set[str] = set()
    if project.current_snapshot_id:
        always_keep.add(project.current_snapshot_id)
    for s in snapshots:
        if s.status in ("pending", "indexing"):
            always_keep.add(s.id)

    # Walk snapshots newest-first; keep until we've held onto `keep`
    # rows (counting always-keep entries against the budget so the
    # user sees roughly that many in the UI).
    kept = 0
    keep_ids: set[str] = set(always_keep)
    for s in snapshots:
        if s.id in keep_ids:
            kept += 1
            continue
        if kept < keep:
            keep_ids.add(s.id)
            kept += 1

    dropped = 0
    freed = 0
    for s in safe_to_drop:
        if s.id in keep_ids:
            continue
        freed += drop_collection(s.id)
        await db.delete(s)
        dropped += 1
    if dropped:
        await db.commit()
    return dropped, freed


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
        snapshot_retention_count=payload.snapshot_retention_count,
        status="pending",
    )
    db.add(project)
    await db.flush()
    if payload.is_shared and payload.role_codes:
        await _set_project_roles(db, project.id, payload.role_codes)
    # Upload-source projects start empty: we make the per-project
    # upload directory so subsequent /uploads calls have a target, but
    # we don't schedule the first snapshot — that fires from /reindex
    # once the user has actually uploaded files.
    if payload.source_type == "upload":
        upload_dir = _project_upload_dir(project.id)
        upload_dir.mkdir(parents=True, exist_ok=True)
        # Pin source_ref to the on-disk path so the indexer can walk it
        # without needing to know about the upload source specially.
        project.source_ref = str(upload_dir)
        await db.commit()
    else:
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
    # 공유 KB 의 사용자도 detail 을 볼 수 있어야 한다 — 이전에는 owner
    # 한정이라 사이드바에 보이는데 클릭하면 404 가 났다.
    project = await _project_with_snapshots_for_read(db, project_id, user)
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


@router.patch("/{project_id}", response_model=schemas.ProjectOut)
async def update_project(
    project_id: str,
    payload: schemas.ProjectUpdate,
    db: AsyncSession = Depends(get_db),
    user: models.User = Depends(get_current_user),
):
    """Edit an existing project. Owner can edit fields; admin
    additionally edits is_shared / role_codes on shared projects.
    When a source-defining field changes, the current index is stale,
    so we set status back to 'pending' and create a fresh snapshot —
    same path as the manual reindex button."""
    project = await db.scalar(
        select(models.Project)
        .where(models.Project.id == project_id)
        .options(selectinload(models.Project.snapshots))
    )
    if project is None:
        raise HTTPException(404, "project not found")

    is_owner = project.user_id == user.id
    is_admin = await _is_admin(db, user)
    if not is_owner and not is_admin:
        raise HTTPException(403, "권한이 없습니다")

    # Track whether the source / fetch contract changed — that's what
    # makes the existing index stale and warrants a reindex.
    source_changed = False

    if payload.name is not None and payload.name.strip() != project.name:
        project.name = payload.name.strip()

    if payload.source_ref is not None:
        new_ref = payload.source_ref.strip()
        if new_ref and new_ref != project.source_ref:
            project.source_ref = new_ref
            source_changed = True

    # `ref` (git branch/tag) only applies to git sources; accept the
    # value regardless and let the indexer ignore it on other sources.
    if payload.ref is not None and project.source_type == "git":
        # Empty string is meaningful: "back to default branch".
        new_branch = payload.ref.strip()
        # We don't store branch on the project today — silently no-op
        # so the wire shape stays compatible with the create form.
        _ = new_branch
        source_changed = True

    if payload.sql_query is not None and project.source_type == "connection":
        new_sql = (payload.sql_query or "").strip() or None
        if new_sql != project.sql_query:
            project.sql_query = new_sql
            source_changed = True

    if payload.api_detail_key is not None and project.source_type == "url":
        new_key = (payload.api_detail_key or "").strip() or None
        if new_key != project.api_detail_key:
            project.api_detail_key = new_key
            source_changed = True
    if payload.api_detail_url is not None and project.source_type == "url":
        new_dt_url = (payload.api_detail_url or "").strip() or None
        if new_dt_url != project.api_detail_url:
            project.api_detail_url = new_dt_url
            source_changed = True

    # Admin-only flag changes.
    if payload.is_shared is not None:
        if payload.is_shared != project.is_shared:
            if not is_admin:
                raise HTTPException(
                    403, "공유 지식베이스 토글은 관리자만 변경할 수 있습니다",
                )
            project.is_shared = payload.is_shared
    if payload.role_codes is not None:
        if not is_admin:
            raise HTTPException(
                403, "역할 매핑은 관리자만 변경할 수 있습니다",
            )
        await _set_project_roles(db, project_id, payload.role_codes)

    # Snapshot retention — owner (or admin) can tighten / loosen the
    # cap. When the number drops we run the pruner immediately so
    # the user sees the effect right away instead of having to wait
    # for the next reindex.
    retention_dropped = False
    if payload.snapshot_retention_count is not None:
        new_n = payload.snapshot_retention_count
        if new_n != project.snapshot_retention_count:
            project.snapshot_retention_count = new_n
            retention_dropped = new_n > 0  # 0 = unlimited, nothing to prune

    if source_changed and project.current_snapshot_id is not None:
        # Stale index — schedule a fresh snapshot (same path as the
        # reindex button) so retrieval reflects the new source ASAP.
        # status flips to pending so the UI shows "대기" until the
        # new snapshot kicks off.
        project.status = "pending"
        await db.flush()
        await _create_snapshot_and_schedule(db, project)

    await db.commit()
    # Run the retention sweep after the commit so the updated cap is
    # the one the helper reads. Safe to no-op when the cap didn't
    # actually move.
    if retention_dropped:
        await prune_old_snapshots(db, project_id)
    proj = await db.scalar(
        select(models.Project)
        .where(models.Project.id == project_id)
        .options(selectinload(models.Project.snapshots))
    )
    return await _serialize_project(db, proj, user)


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
    """Owner-initiated delete — admins also get an escape hatch so a
    shared knowledge base another admin uploaded can still be
    retired from the dashboard. Always wipes the per-project upload
    directory + every snapshot's Qdrant collection."""
    project = await db.scalar(
        select(models.Project)
        .where(models.Project.id == project_id)
        .options(selectinload(models.Project.snapshots))
    )
    if not project:
        raise HTTPException(404, "project not found")
    is_owner = project.user_id == user.id
    is_admin = await _is_admin(db, user)
    if not (is_owner or is_admin):
        raise HTTPException(403, "권한이 없습니다")
    # Each snapshot has its own Qdrant collection; drop them all +
    # capture the total bytes reclaimed so the UI can show a
    # meaningful number.
    freed_total = 0
    for snap in project.snapshots:
        freed_total += drop_collection(snap.id)
    # Wipe the per-project upload directory unconditionally — the
    # helper noops when the project never used the upload source, so
    # we don't need to branch on source_type here. Bytes recovered
    # land in the same freed_bytes total so the user sees a single
    # number that includes both the vector store and the originals.
    freed_total += _wipe_project_upload_dir(project.id)
    await db.delete(project)
    await db.commit()
    return {"freed_bytes": freed_total}


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
    db: AsyncSession = Depends(get_db),
    user: models.User = Depends(get_current_user),
):
    """Debug endpoint — runs retrieval without invoking the LLM.
    Pass snapshot_id to query a historical snapshot instead of the
    current one (useful for the compare-with-old workflow)."""
    # 공유 KB 도 검색 가능해야 한다 (chat 도 같은 retrieve 를 쓴다).
    project = await _project_with_snapshots_for_read(db, project_id, user)
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
