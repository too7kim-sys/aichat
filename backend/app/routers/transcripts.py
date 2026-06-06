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
from ..auth import get_current_user
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
