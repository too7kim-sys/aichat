"""Split-out admin endpoints — admin.py 가 2236줄로 커져 부분 분리.
이 파일의 모든 route 는 admin._core.router (prefix='/api/admin') 에
직접 등록된다.  main.py 의 include_router 는 admin 패키지의 단일
router 만 부르므로 새 파일을 추가해도 main 은 변경 없음."""
from __future__ import annotations

import os
from datetime import datetime, timezone
from pathlib import Path

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from pydantic import BaseModel, Field
from sqlalchemy import func, or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from ... import app_settings, audit, models, schemas
from ...auth import get_current_user, require_admin, require_staff
from ...config import settings
from ...database import get_db
from ._core import router, _resolve_backup_dir

# ── 데이터 정합성 (#112~#115) ────────────────────────────────────────
# 폐쇄망 장기 운영에서 가장 자주 터지는 두 문제 — '백업이 실제로 살아
# 있는가' + '쓸데없이 디스크 차지하는 고아 데이터' 를 admin 이 한 화면
# 에서 검사·정리할 수 있게 묶음.


@router.get("/integrity/backups")
async def check_backup_integrity(
    _admin: models.User = Depends(require_admin),
):
    """백업 디렉터리의 각 .db 파일에 대해 sha256 + SQLite integrity_check
    (#112).  매뉴얼/스케줄러 백업이 실제로 풀리는지 다운로드 전에
    검증하는 용도."""
    import hashlib
    import sqlite3
    from pathlib import Path

    base = _resolve_backup_dir()
    if not base.is_dir():
        return {"backup_dir": str(base), "files": []}
    out = []
    for p in sorted(base.glob("*.db"), reverse=True):
        try:
            h = hashlib.sha256()
            size = 0
            with p.open("rb") as f:
                while True:
                    block = f.read(1024 * 1024)
                    if not block:
                        break
                    h.update(block)
                    size += len(block)
            # SQLite 무결성 — 빠른 모드 (퀵 체크).  PASS → 'ok'.
            integrity = "skipped"
            try:
                c = sqlite3.connect(f"file:{p}?mode=ro", uri=True, timeout=10)
                try:
                    row = c.execute("PRAGMA quick_check").fetchone()
                    integrity = (row[0] if row else "unknown")[:200]
                finally:
                    c.close()
            except sqlite3.Error as exc:
                integrity = f"sqlite-error: {exc}"
            st = p.stat()
            out.append({
                "name": p.name,
                "size_bytes": size,
                "sha256": h.hexdigest(),
                "integrity": integrity,
                "mtime": datetime.fromtimestamp(
                    st.st_mtime, tz=timezone.utc,
                ).isoformat(),
                "ok": integrity == "ok",
            })
        except OSError as exc:
            out.append({"name": p.name, "error": str(exc), "ok": False})
    return {"backup_dir": str(base), "files": out}


# Comment.target_type 별 → 대응 모델 + PK 컬럼.  target_id 가 그 모델
# 에 존재하지 않으면 고아.  새 target 종류가 늘어나면 여기에 추가.
_COMMENT_TARGET_MODELS: dict[str, type] = {
    "message": models.Message,
    "workflow": models.Workflow,
    "transcript": models.Transcript,
    "action": models.ActionItem,
    "session": models.Session,
    # chunk 은 Qdrant 안에 있는 청크 id 라 DB 검사 불가 — 별도 처리 X.
}


async def _orphan_comment_ids(db: AsyncSession) -> dict[str, list[str]]:
    """target_type 별로 '대응 모델에 그 id 가 없는' Comment.id 들 모음."""
    from sqlalchemy import and_, not_, select as _sel
    out: dict[str, list[str]] = {}
    for ttype, Model in _COMMENT_TARGET_MODELS.items():
        pk_col = Model.id  # type: ignore[attr-defined]
        sub = _sel(pk_col)
        orphan = (
            await db.execute(
                _sel(models.Comment.id)
                .where(
                    and_(
                        models.Comment.target_type == ttype,
                        not_(models.Comment.target_id.in_(sub)),
                    )
                )
                .limit(2000)
            )
        ).scalars().all()
        out[ttype] = list(orphan)
    return out


@router.get("/integrity/orphans")
async def list_orphans(
    db: AsyncSession = Depends(get_db),
    _admin: models.User = Depends(require_admin),
):
    """카테고리별 고아 행 개수 (#113).  '검사' 단계 — 실제 삭제는 별도
    POST /integrity/orphans/cleanup 으로."""
    comment_orphans = await _orphan_comment_ids(db)
    return {
        "comments": {
            ttype: {"count": len(ids), "sample": ids[:5]}
            for ttype, ids in comment_orphans.items()
        },
    }


class _OrphanCleanup(BaseModel):
    kind: str = Field(pattern=r"^comments$")
    target_type: str = Field(max_length=20)


@router.post("/integrity/orphans/cleanup")
async def cleanup_orphans(
    payload: _OrphanCleanup,
    request: Request,
    db: AsyncSession = Depends(get_db),
    actor: models.User = Depends(require_admin),
):
    """지정된 카테고리의 고아 Comment 행만 삭제.  감사 로그에 actor 기록."""
    target_type = payload.target_type
    if target_type not in _COMMENT_TARGET_MODELS:
        raise HTTPException(400, "지원하지 않는 정리 대상")
    orphan = await _orphan_comment_ids(db)
    ids = orphan.get(target_type, [])
    if not ids:
        return {"deleted": 0}
    await db.execute(
        models.Comment.__table__.delete().where(models.Comment.id.in_(ids))
    )
    await audit.record(
        db, request, "integrity_cleanup", user_id=actor.id,
        detail=f"comments/{target_type} × {len(ids)}",
    )
    await db.commit()
    return {"deleted": len(ids)}


@router.get("/integrity/files")
async def check_file_integrity(
    db: AsyncSession = Depends(get_db),
    _admin: models.User = Depends(require_admin),
):
    """업로드 디렉터리 vs DB Project 행 정합성 (#114).
    - orphan_dirs: <upload_root>/<id>/... 에 디렉터리는 있지만 Project 행 없음
    - missing_dirs: Project 행은 있는데 디렉터리 없음 (status='ready' 한정)
    """
    from pathlib import Path
    root = Path(settings.rag_upload_dir).expanduser().resolve()
    project_ids = set(
        (
            await db.execute(select(models.Project.id))
        ).scalars().all()
    ) if root.is_dir() else set()

    orphan_dirs: list[dict] = []
    if root.is_dir():
        for child in root.iterdir():
            if not child.is_dir():
                continue
            if child.name not in project_ids:
                # 디스크 사용량 — 최대 10 개 파일만 빠르게 계산.
                size = 0
                files = 0
                for fp in child.rglob("*"):
                    if fp.is_file():
                        try:
                            size += fp.stat().st_size
                        except OSError:
                            continue
                        files += 1
                        if files >= 10_000:
                            break  # 거대한 디렉터리에서 무한 루프 방지
                orphan_dirs.append({
                    "path": str(child),
                    "project_id": child.name,
                    "size_bytes": size,
                    "file_count": files,
                })

    # DB 의 upload 소스 프로젝트 중 디렉터리가 사라진 경우.
    missing_dirs: list[dict] = []
    upload_projects = (
        await db.execute(
            select(models.Project.id, models.Project.name).where(
                models.Project.source_type == "upload",
            )
        )
    ).all() if root.is_dir() else []
    for pid, pname in upload_projects:
        if not (root / pid).is_dir():
            missing_dirs.append({"project_id": pid, "name": pname})
    return {
        "upload_root": str(root),
        "orphan_dirs": orphan_dirs,
        "missing_dirs": missing_dirs,
    }


class _OrphanDirCleanup(BaseModel):
    # 명시적으로 작은 max_length — 100개 이상 한 번에 정리는 비정상.
    project_ids: list[str] = Field(max_length=100)


@router.post("/integrity/files/cleanup")
async def cleanup_orphan_dirs(
    payload: _OrphanDirCleanup,
    request: Request,
    db: AsyncSession = Depends(get_db),
    actor: models.User = Depends(require_admin),
):
    """'/integrity/files' 가 알려준 orphan_dirs 중에서 지정된 것만 실제로
    rm -rf.  경로 트래버설 가드: upload_root 밖이거나 실재 Project 가 있는
    디렉터리는 건너뜀."""
    from pathlib import Path
    import shutil

    project_ids = payload.project_ids
    if not project_ids:
        raise HTTPException(400, "삭제할 project_id 목록이 비어 있음")
    root = Path(settings.rag_upload_dir).expanduser().resolve()
    if not root.is_dir():
        return {"deleted_dirs": 0, "freed_bytes": 0}

    live_ids = set(
        (
            await db.execute(select(models.Project.id))
        ).scalars().all()
    )
    deleted = 0
    freed = 0
    for pid in project_ids:
        if not isinstance(pid, str) or "/" in pid or ".." in pid:
            continue
        if pid in live_ids:
            continue  # 실재 프로젝트 — 절대 안 지움.
        target = (root / pid).resolve()
        try:
            target.relative_to(root)
        except ValueError:
            continue
        if not target.is_dir():
            continue
        # 크기 측정 후 삭제.
        for fp in target.rglob("*"):
            if fp.is_file():
                try:
                    freed += fp.stat().st_size
                except OSError:
                    pass
        try:
            shutil.rmtree(target)
            deleted += 1
        except OSError:
            continue
    await audit.record(
        db, request, "integrity_cleanup", user_id=actor.id,
        detail=f"orphan-dirs × {deleted} ({freed} bytes)",
    )
    await db.commit()
    return {"deleted_dirs": deleted, "freed_bytes": freed}


