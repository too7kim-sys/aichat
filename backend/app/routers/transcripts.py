"""Audio → transcript → summary pipeline endpoints.

POST /api/transcripts    multipart upload, kicks off the background
                         pipeline (whisper → diarization → summary →
                         chat session)
GET  /api/transcripts    list this user's transcripts (most recent
                         first), so the Cowork pane can render the
                         live status of any in-flight job
DELETE /api/transcripts/{id}  drop the row (does NOT touch the result
                              chat session; that's the user's to
                              keep or delete normally)
"""
from __future__ import annotations

import asyncio
import logging
import os
import tempfile

from fastapi import APIRouter, Depends, File, HTTPException, UploadFile
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from .. import models, schemas
from ..auth import get_current_user, require_admin
from ..config import settings
from ..database import get_db
from ..transcribe.runner import run_transcription

log = logging.getLogger("uvicorn.error")

router = APIRouter(prefix="/api/transcripts", tags=["transcripts"])

_BACKGROUND_TASKS: set[asyncio.Task] = set()

# Acceptable audio extensions. The browser's MediaRecorder emits webm
# with opus; the upload path also accepts common formats users might
# already have on disk.
_AUDIO_EXTS = {
    ".webm", ".ogg", ".oga", ".opus",
    ".mp3", ".m4a", ".aac",
    ".wav", ".flac",
    ".mp4",  # iOS Safari sometimes saves audio as mp4
}


def _guard_enabled() -> None:
    if not settings.enable_transcription:
        raise HTTPException(
            503,
            "전사 기능이 비활성 상태입니다 (.env: ENABLE_TRANSCRIPTION=true).",
        )


@router.get("", response_model=list[schemas.TranscriptOut])
async def list_transcripts(
    db: AsyncSession = Depends(get_db),
    user: models.User = Depends(get_current_user),
):
    rows = (
        await db.execute(
            select(models.Transcript)
            .where(models.Transcript.user_id == user.id)
            .order_by(models.Transcript.created_at.desc())
            .limit(50)
        )
    ).scalars().all()
    return rows


@router.post("", response_model=schemas.TranscriptOut, status_code=202)
async def upload_audio(
    file: UploadFile = File(...),
    db: AsyncSession = Depends(get_db),
    user: models.User = Depends(get_current_user),
):
    _guard_enabled()
    fname = file.filename or "녹음.webm"
    ext = os.path.splitext(fname)[1].lower()
    if ext not in _AUDIO_EXTS:
        raise HTTPException(
            400,
            f"지원하지 않는 오디오 형식: {ext}. "
            f"허용: {', '.join(sorted(_AUDIO_EXTS))}",
        )

    # Stream the upload to a tempfile so a huge recording doesn't
    # balloon memory. Cap at the configured limit.
    cap = settings.transcription_max_upload_mb * 1024 * 1024
    tmp = tempfile.NamedTemporaryFile(
        prefix="aichat-audio-", suffix=ext, delete=False,
    )
    total = 0
    try:
        while True:
            chunk = await file.read(1024 * 1024)
            if not chunk:
                break
            total += len(chunk)
            if total > cap:
                tmp.close()
                os.unlink(tmp.name)
                raise HTTPException(
                    413,
                    f"파일이 너무 큽니다 (limit "
                    f"{settings.transcription_max_upload_mb} MB)",
                )
            tmp.write(chunk)
    finally:
        tmp.close()

    tr = models.Transcript(
        user_id=user.id,
        source_filename=fname,
        size_bytes=total,
        status="pending",
    )
    db.add(tr)
    await db.commit()
    await db.refresh(tr)

    task = asyncio.get_running_loop().create_task(
        run_transcription(tr.id, tmp.name)
    )
    _BACKGROUND_TASKS.add(task)
    task.add_done_callback(_BACKGROUND_TASKS.discard)
    return tr


@router.delete("/{transcript_id}", status_code=204)
async def delete_transcript(
    transcript_id: str,
    db: AsyncSession = Depends(get_db),
    user: models.User = Depends(get_current_user),
):
    tr = (
        await db.execute(
            select(models.Transcript).where(
                models.Transcript.id == transcript_id,
                models.Transcript.user_id == user.id,
            )
        )
    ).scalar_one_or_none()
    if tr is None:
        raise HTTPException(404, "transcript not found")
    await db.delete(tr)
    await db.commit()


# ── Whisper model bootstrap (admin) ──────────────────────────────────

_DOWNLOAD_BACKGROUND: set[asyncio.Task] = set()
_DOWNLOAD_STATE: dict = {
    "status": "idle",  # idle | running | done | failed
    "model": "",
    "local_dir": "",
    "error": None,
}


@router.get("/_whisper-status")
async def whisper_status(
    _admin: models.User = Depends(require_admin),
):
    """Report which Whisper model the backend is configured for and
    whether the on-disk snapshot is ready. Admin-only — exposes the
    model dir path. Used by the Cowork pane to show a "모델 다운로드"
    button when the closed-network setup hasn't been finished yet."""
    from pathlib import Path
    from ..transcribe.whisper import _resolve_cached_snapshot

    model_dir = Path(settings.whisper_model_dir).expanduser()
    cached = _resolve_cached_snapshot(settings.whisper_model, model_dir)
    explicit = Path(settings.whisper_model).expanduser().is_dir()
    return {
        "enabled": settings.enable_transcription,
        "offline": settings.transcription_offline,
        "model": settings.whisper_model,
        "model_dir": str(model_dir),
        "cached_snapshot": str(cached) if cached else None,
        "ready": bool(cached or explicit),
        "download": _DOWNLOAD_STATE,
    }


@router.post("/_whisper-download", status_code=202)
async def whisper_download(
    _admin: models.User = Depends(require_admin),
):
    """Kick off a background snapshot_download of the configured
    Whisper model into WHISPER_MODEL_DIR. Lets the operator complete
    a closed-network install via the Cowork UI when this machine has
    *temporary* internet access (e.g. corporate VPN session) instead
    of needing the huggingface-cli on a separate PC + USB copy.

    Idempotent — a running job is reported as 'running' so the UI
    can poll _whisper-status; calling again while running is a no-op.
    """
    if _DOWNLOAD_STATE["status"] == "running":
        return _DOWNLOAD_STATE
    # Pull the imports here so a stripped-down install without
    # huggingface_hub still boots — only this endpoint requires it.
    from pathlib import Path

    try:
        from huggingface_hub import snapshot_download
    except ImportError as exc:
        raise HTTPException(
            500,
            "huggingface_hub 가 설치돼 있지 않습니다. "
            f"venv 에서 pip install -U \"huggingface_hub[cli]\" 후 재시도하세요. "
            f"({exc})",
        )

    model_ref = settings.whisper_model.strip()
    if not model_ref:
        raise HTTPException(400, "WHISPER_MODEL 이 설정돼 있지 않습니다")
    # Don't try to download when the user already pointed at a local
    # path — the model is already present.
    if Path(model_ref).expanduser().is_dir():
        _DOWNLOAD_STATE.update(
            status="done", model=model_ref,
            local_dir=str(Path(model_ref).expanduser()),
            error=None,
        )
        return _DOWNLOAD_STATE

    model_dir = Path(settings.whisper_model_dir).expanduser()
    model_dir.mkdir(parents=True, exist_ok=True)
    # Pick the Systran namespace by default — that's what
    # faster-whisper expects. The user can pre-set WHISPER_MODEL to
    # the full "org/repo" form if they want a different fork.
    repo_id = (
        model_ref if "/" in model_ref
        else f"Systran/faster-whisper-{model_ref}"
    )
    target_dir = model_dir / repo_id.replace("/", "_")
    _DOWNLOAD_STATE.update(
        status="running",
        model=repo_id,
        local_dir=str(target_dir),
        error=None,
    )

    def _run_sync():
        try:
            snapshot_download(repo_id=repo_id, local_dir=str(target_dir))
            _DOWNLOAD_STATE.update(status="done", error=None)
            log.info("whisper download complete: %s → %s", repo_id, target_dir)
        except Exception as exc:  # noqa: BLE001
            log.exception("whisper download failed for %s", repo_id)
            _DOWNLOAD_STATE.update(
                status="failed",
                error=f"{type(exc).__name__}: {exc}",
            )

    task = asyncio.get_running_loop().run_in_executor(None, _run_sync)
    _DOWNLOAD_BACKGROUND.add(task)
    task.add_done_callback(_DOWNLOAD_BACKGROUND.discard)
    return _DOWNLOAD_STATE
