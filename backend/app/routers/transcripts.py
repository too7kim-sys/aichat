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


@router.get("/{transcript_id}/export.hwpx")
async def export_transcript_hwpx(
    transcript_id: str,
    include: str = "summary",
    message_ids: str = "",
    mask_pii: bool = False,
    db: AsyncSession = Depends(get_db),
    user: models.User = Depends(get_current_user),
):
    """회의록을 HWPX (한컴 오픈 XML) 로 다운로드. include / message_ids /
    mask_pii 동작은 export.docx 와 동일."""
    import urllib.parse
    from fastapi.responses import Response
    from .. import hwpx_export, pii_mask

    orphan_sess = await _resolve_orphan_session(db, transcript_id, user.id)
    if orphan_sess is not None:
        sess = orphan_sess
        title = sess.title or "회의록"
    else:
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
        if not tr.session_id:
            raise HTTPException(409, "전사가 아직 완료되지 않았습니다")
        sess = await db.scalar(
            select(models.Session).where(
                models.Session.id == tr.session_id,
                models.Session.user_id == user.id,
            )
        )
        if sess is None:
            raise HTTPException(404, "연결된 채팅 세션을 찾을 수 없습니다")
        title = tr.source_filename or sess.title or "회의록"

    msg_rows = (
        await db.execute(
            select(models.Message)
            .where(models.Message.session_id == sess.id)
            .order_by(models.Message.created_at.asc())
        )
    ).scalars().all()

    picked_ids: set[str] | None = None
    if message_ids.strip():
        picked_ids = {x.strip() for x in message_ids.split(",") if x.strip()}
    if picked_ids is not None:
        selected = [m for m in msg_rows if m.id in picked_ids]
    elif include == "all":
        selected = list(msg_rows)
    else:
        selected = [m for m in msg_rows if m.role == "assistant"]

    paragraphs = ["회의록", title, ""]
    for m in selected:
        text = (m.content or "").strip()
        if not text:
            continue
        if mask_pii:
            text = pii_mask.mask(text)
        paragraphs.append("[요약]" if m.role == "assistant" else "[원문/메모]")
        paragraphs.append(text)
        paragraphs.append("")

    data = hwpx_export.build_hwpx(title, paragraphs)
    safe = urllib.parse.quote((title or "회의록").replace("/", "_"))
    return Response(
        content=data,
        media_type="application/hwp+zip",
        headers={
            "Content-Disposition": f"attachment; filename*=UTF-8''{safe}.hwpx"
        },
    )


@router.get("/{transcript_id}/export.docx")
async def export_transcript_docx(
    transcript_id: str,
    include: str = "summary",
    message_ids: str = "",
    mask_pii: bool = False,
    db: AsyncSession = Depends(get_db),
    user: models.User = Depends(get_current_user),
):
    """Render the transcript's linked chat session as a Korean
    회의록 DOCX and stream it back.

    Query params control which messages land in the document:
      · `include=summary` (default) — assistant messages only, raw
        transcript hidden. Matches the common "회의록 = 요약만" need.
      · `include=all` — every message including the raw transcript.
      · `message_ids=<id>,<id>,...` — explicit pick from the
        selection modal in the UI. Overrides `include` when set.
    """
    import io
    import urllib.parse

    # Orphan rows export from the linked Session directly (no
    # Transcript row to look up). `tr` stays None for that path so the
    # title-page rendering below has to fall back to session attrs.
    tr: models.Transcript | None = None
    orphan_sess = await _resolve_orphan_session(db, transcript_id, user.id)
    if orphan_sess is not None:
        sess = orphan_sess
    else:
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
        if not tr.session_id:
            raise HTTPException(409, "전사가 아직 완료되지 않았습니다")
        sess = await db.scalar(
            select(models.Session).where(
                models.Session.id == tr.session_id,
                models.Session.user_id == user.id,
            )
        )
        if sess is None:
            raise HTTPException(404, "연결된 채팅 세션을 찾을 수 없습니다")
    msg_rows = (
        await db.execute(
            select(models.Message)
            .where(models.Message.session_id == sess.id)
            .order_by(models.Message.created_at.asc())
        )
    ).scalars().all()

    # Decide which messages to include. Explicit IDs win; otherwise
    # the `include` mode picks a sensible default.
    picked_ids: set[str] | None = None
    if message_ids.strip():
        picked_ids = {
            x.strip() for x in message_ids.split(",") if x.strip()
        }
    selected_msgs: list[models.Message] = []
    if picked_ids is not None:
        selected_msgs = [m for m in msg_rows if m.id in picked_ids]
    elif include == "all":
        selected_msgs = list(msg_rows)
    else:  # "summary" (default)
        selected_msgs = [m for m in msg_rows if m.role == "assistant"]

    try:
        from docx import Document
        from docx.shared import Pt
        from docx.enum.text import WD_ALIGN_PARAGRAPH
    except ImportError as exc:
        raise HTTPException(
            500,
            "python-docx 가 설치돼 있지 않습니다. "
            "백엔드 의존성 설치를 확인하세요.",
        ) from exc

    doc = Document()

    # Title page
    title = doc.add_heading("회의록", level=0)
    title.alignment = WD_ALIGN_PARAGRAPH.CENTER
    subtitle = doc.add_paragraph()
    subtitle.alignment = WD_ALIGN_PARAGRAPH.CENTER
    title_text = (
        (tr.source_filename if tr else None) or sess.title or "녹음"
    )
    run = subtitle.add_run(title_text)
    run.bold = True
    run.font.size = Pt(14)

    meta = doc.add_paragraph()
    meta.alignment = WD_ALIGN_PARAGRAPH.CENTER
    meta_bits: list[str] = []
    created_at = (tr.created_at if tr else None) or sess.created_at
    if created_at:
        meta_bits.append(f"작성 일시: {created_at.strftime('%Y-%m-%d %H:%M')}")
    if tr and tr.duration_sec:
        m_, s_ = divmod(int(tr.duration_sec), 60)
        h_, m_ = divmod(m_, 60)
        if h_:
            meta_bits.append(f"녹음 길이: {h_}h {m_:02d}m {s_:02d}s")
        else:
            meta_bits.append(f"녹음 길이: {m_}m {s_:02d}s")
    if tr and tr.language:
        meta_bits.append(f"언어: {tr.language}")
    if tr and tr.diarized:
        meta_bits.append("화자 분리: 적용")
    if tr is None:
        meta_bits.append("보관됨 (음원 삭제)")
    meta_run = meta.add_run("  ·  ".join(meta_bits))
    meta_run.italic = True
    meta_run.font.size = Pt(10)

    doc.add_paragraph()  # spacer

    if not selected_msgs:
        doc.add_paragraph(
            "선택된 본문이 없습니다. 채팅창에서 회의록에 담을 메시지를 "
            "선택한 뒤 다시 받아주세요."
        )
    else:
        # Each picked message renders as one section. Numbering only
        # appears when there's more than one of the same role so a
        # single-summary export reads cleanly as just "요약".
        role_counts = {"assistant": 0, "user": 0}
        for m in selected_msgs:
            role_counts[m.role] += 1
        a_idx = 0
        u_idx = 0
        from .. import pii_mask
        for m in selected_msgs:
            content = (m.content or "").strip()
            if not content:
                continue
            if mask_pii:
                content = pii_mask.mask(content)
            if m.role == "assistant":
                a_idx += 1
                label = "요약"
                if role_counts["assistant"] > 1:
                    label = f"요약 {a_idx}"
                doc.add_heading(label, level=1)
            else:
                u_idx += 1
                # User-side: distinguish the original transcript (first
                # one) from later notes the user typed into chat.
                if u_idx == 1 and role_counts["user"] >= 1:
                    label = "전체 전사"
                else:
                    label = f"메모 {u_idx - 1}"
                doc.add_heading(label, level=1)
            for para in content.split("\n\n"):
                line = para.strip()
                if not line:
                    continue
                if line.startswith("# "):
                    doc.add_heading(line[2:].strip(), level=2)
                elif line.startswith("## "):
                    doc.add_heading(line[3:].strip(), level=2)
                elif line.startswith("### "):
                    doc.add_heading(line[4:].strip(), level=3)
                else:
                    p = doc.add_paragraph()
                    p.add_run(line)

    buf = io.BytesIO()
    doc.save(buf)
    buf.seek(0)

    base = (tr.source_filename or sess.title or "회의록").rsplit(".", 1)[0]
    leaf = f"{base} 회의록.docx"
    ascii_fallback = (
        leaf.encode("ascii", errors="replace")
        .decode("ascii")
        .replace('"', "_")
    )
    encoded = urllib.parse.quote(leaf, safe="")
    disposition = (
        f'attachment; filename="{ascii_fallback}"; '
        f"filename*=UTF-8''{encoded}"
    )
    from fastapi.responses import StreamingResponse

    return StreamingResponse(
        buf,
        media_type=(
            "application/vnd.openxmlformats-officedocument."
            "wordprocessingml.document"
        ),
        headers={"Content-Disposition": disposition},
    )


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
    # WHISPER_MODEL 이 운영자가 추후에 자유롭게 바꿀 수 있는 값이라,
    # `..` 같은 경로 트래버설 문자가 들어가면 target_dir 가 WHISPER_
    # MODEL_DIR 바깥을 가리킬 수 있다. HuggingFace repo id 패턴 외에는
    # 거부한다 ("org/repo" 형태, 영숫자/./-/_ 만).
    import re as _re
    if not _re.fullmatch(r"[A-Za-z0-9._-]+/[A-Za-z0-9._-]+", repo_id):
        raise HTTPException(
            400,
            f"WHISPER_MODEL 형식이 잘못됐습니다: {repo_id!r} "
            "(예: large-v3 또는 Systran/faster-whisper-large-v3)",
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
