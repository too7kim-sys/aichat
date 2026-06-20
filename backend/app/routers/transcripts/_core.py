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

from ... import models, schemas
from ...auth import get_current_user, require_admin
from ...config import settings
from ...database import get_db
from ...transcribe.runner import run_transcription

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
    # 1. Live transcript rows (audio still on file).
    rows = (
        await db.execute(
            select(models.Transcript)
            .where(models.Transcript.user_id == user.id)
            .order_by(models.Transcript.created_at.desc())
            .limit(50)
        )
    ).scalars().all()
    out: list = list(rows)

    # 2. Orphan meeting sessions — chat sessions that were created by
    #    the transcript pipeline (marker: at least one hidden message)
    #    but whose Transcript row has since been deleted. Without this
    #    backfill the meeting disappears from the Cowork list while
    #    still living in the Chat tab, which looks like a bug to the
    #    user ("cowork에서만 사라짐"). We synthesize a TranscriptOut-
    #    shaped row from the session so the meeting stays visible.
    live_session_ids = {r.session_id for r in rows if r.session_id}
    orphan_q = (
        select(models.Session)
        .where(
            models.Session.user_id == user.id,
            models.Session.id.in_(
                select(models.Message.session_id)
                .where(models.Message.hidden.is_(True))
                .distinct()
            ),
        )
        .order_by(models.Session.updated_at.desc())
        .limit(50)
    )
    orphan_sessions = (await db.execute(orphan_q)).scalars().all()
    for sess in orphan_sessions:
        if sess.id in live_session_ids:
            continue
        # Build a synthetic TranscriptOut-compatible dict. The id is
        # prefixed so the frontend can tell synthesized rows apart
        # from real transcripts (no audio file to delete, no rename
        # round-trip to the source file).
        out.append(
            schemas.TranscriptOut(
                id=f"orphan:{sess.id}",
                source_filename=sess.title or "(제목 없음)",
                size_bytes=0,
                duration_sec=None,
                status="archived",
                progress=None,
                language=None,
                diarized=False,
                session_id=sess.id,
                error=None,
                created_at=sess.created_at,
                updated_at=sess.updated_at,
            )
        )
    # Sort merged list by updated_at desc so newest activity wins
    # regardless of which table it came from.
    out.sort(
        key=lambda r: r.updated_at if hasattr(r, "updated_at") else r.created_at,
        reverse=True,
    )
    return out[:50]


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


async def _resolve_orphan_session(
    db: AsyncSession, transcript_id: str, user_id: str,
) -> models.Session | None:
    """If `transcript_id` is a synthesized `orphan:<session_id>` row
    from list_transcripts, return the underlying Session. Otherwise
    None — caller falls back to the normal Transcript lookup."""
    if not transcript_id.startswith("orphan:"):
        return None
    session_id = transcript_id[len("orphan:") :]
    return await db.scalar(
        select(models.Session).where(
            models.Session.id == session_id,
            models.Session.user_id == user_id,
        )
    )


@router.post("/_inline")
async def transcribe_inline(
    file: UploadFile = File(...),
    user: models.User = Depends(get_current_user),
):
    """짧은 오디오 한 토막을 받아 텍스트만 반환 (세션 / Transcript 행
    생성 안 함). 채팅 composer 의 🎙 음성 입력에서 사용 — Whisper
    모델 인프라 그대로 재활용."""
    _guard_enabled()
    fname = file.filename or "voice.webm"
    ext = os.path.splitext(fname)[1].lower()
    if ext not in _AUDIO_EXTS:
        raise HTTPException(400, f"지원하지 않는 오디오 형식: {ext}")

    # 인라인 STT 는 짧은 발화 (≤ 60초) 가정 — 30 MB 캡으로 충분.
    cap = 30 * 1024 * 1024
    tmp = tempfile.NamedTemporaryFile(
        prefix="aichat-stt-", suffix=ext, delete=False,
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
                raise HTTPException(413, "오디오가 너무 큽니다 (30 MB)")
            tmp.write(chunk)
    finally:
        tmp.close()

    try:
        from ...transcribe.whisper import transcribe as _whisper
        import asyncio as _aio
        segments, _info = await _aio.to_thread(_whisper, tmp.name)
        text = " ".join(s.text.strip() for s in segments if s.text.strip()).strip()
        return {"text": text, "duration": float(_info.get("duration", 0.0))}
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(500, f"전사 실패: {exc}")
    finally:
        try:
            os.unlink(tmp.name)
        except OSError:
            pass


@router.delete("/{transcript_id}", status_code=204)
async def delete_transcript(
    transcript_id: str,
    db: AsyncSession = Depends(get_db),
    user: models.User = Depends(get_current_user),
):
    # Synthesized orphan rows come from sessions whose Transcript was
    # already deleted — clicking 삭제 on one removes the session itself
    # (and cascades to its messages) so the row disappears from both
    # Cowork and Chat.
    orphan_sess = await _resolve_orphan_session(db, transcript_id, user.id)
    if orphan_sess is not None:
        await db.delete(orphan_sess)
        await db.commit()
        return
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


@router.post("/{transcript_id}/extract-actions")
async def extract_actions(
    transcript_id: str,
    db: AsyncSession = Depends(get_db),
    user: models.User = Depends(get_current_user),
):
    """회의록 본문에서 LLM 으로 액션 아이템을 추출해 ActionItem 으로
    저장 (#97).  반환: {created: N}.  같은 회의록을 두 번 돌리면
    이전 추출분은 그대로 두고 새 항목만 추가된다."""
    from ...routers.cowork import extract_actions_from_transcript

    tr = await db.scalar(
        select(models.Transcript).where(
            models.Transcript.id == transcript_id,
            models.Transcript.user_id == user.id,
        )
    )
    if tr is None:
        raise HTTPException(404, "transcript not found")
    if not tr.session_id:
        raise HTTPException(400, "연결된 채팅 세션이 없습니다")
    # 세션의 사용자 메시지(= 전사 본문) 를 모아 LLM 에 던진다.
    rows = (
        await db.execute(
            select(models.Message)
            .where(
                models.Message.session_id == tr.session_id,
                models.Message.role == "user",
            )
            .order_by(models.Message.created_at)
        )
    ).scalars().all()
    body_text = "\n\n".join(m.content or "" for m in rows)
    if not body_text.strip():
        return {"created": 0}
    model = (
        settings.transcription_summary_model
        or getattr(settings, "default_model", "")
        or "qwen2.5:7b"
    )
    n = await extract_actions_from_transcript(
        db,
        transcript_id=tr.id,
        session_id=tr.session_id,
        transcript_text=body_text,
        model=model,
        base_url=settings.ollama_base_url,
    )
    return {"created": n}


@router.patch("/{transcript_id}", response_model=schemas.TranscriptOut)
async def rename_transcript(
    transcript_id: str,
    payload: schemas.TranscriptUpdate,
    db: AsyncSession = Depends(get_db),
    user: models.User = Depends(get_current_user),
):
    """Rename a transcript. Updates source_filename (the row's
    visible label) AND the linked chat session's title — keeping
    both surfaces in sync so the sidebar's session list and the
    Cowork meetings list show the same name."""
    new_title = payload.title.strip()
    # Orphan rows have no Transcript record — operate on the linked
    # session directly and synthesize the response.
    orphan_sess = await _resolve_orphan_session(db, transcript_id, user.id)
    if orphan_sess is not None:
        orphan_sess.title = new_title
        await db.commit()
        await db.refresh(orphan_sess)
        return schemas.TranscriptOut(
            id=transcript_id,
            source_filename=new_title,
            size_bytes=0,
            duration_sec=None,
            status="archived",
            progress=None,
            language=None,
            diarized=False,
            session_id=orphan_sess.id,
            error=None,
            created_at=orphan_sess.created_at,
            updated_at=orphan_sess.updated_at,
        )
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
    tr.source_filename = new_title
    if tr.session_id:
        sess = await db.scalar(
            select(models.Session).where(
                models.Session.id == tr.session_id,
                models.Session.user_id == user.id,
            )
        )
        if sess:
            sess.title = new_title
    await db.commit()
    await db.refresh(tr)
    return tr


