"""End-to-end transcription pipeline:

    audio file → Whisper → (optional) pyannote → summary via Ollama
                 ↓
            new chat Session owned by the user
              ├── user message: full speaker-labelled transcript
              └── assistant message: summary

Each stage updates the Transcript row's `status` + `progress` so the
sidebar's 회의록 list can show a meaningful label."""
from __future__ import annotations

import asyncio
import logging
import time
from datetime import datetime, timezone
from pathlib import Path

from sqlalchemy import select

from .. import models
from ..config import settings
from ..database import SessionLocal
from ..providers.base import ChatMessage
from ..providers.registry import get_provider
from . import diarize as diar
from .whisper import Segment, transcribe

log = logging.getLogger("uvicorn.error")


def _format_time(s: float) -> str:
    m, sec = divmod(int(s), 60)
    h, m = divmod(m, 60)
    return f"{h:02d}:{m:02d}:{sec:02d}"


def _render_transcript(segments: list[Segment], diarized: bool) -> str:
    """Render the segment list as a Markdown transcript. Diarized
    output groups consecutive segments by speaker so the document
    reads as natural turns instead of one-line-per-utterance."""
    if not segments:
        return "(빈 전사)"
    parts: list[str] = ["# 전사", ""]
    if diarized:
        cur_speaker = None
        cur_start = 0.0
        buf: list[str] = []
        for seg in segments:
            spk = seg.speaker or "UNKNOWN"
            if spk != cur_speaker:
                if cur_speaker is not None:
                    parts.append(
                        f"**{cur_speaker}** [{_format_time(cur_start)}]"
                    )
                    parts.append(" ".join(buf).strip())
                    parts.append("")
                cur_speaker = spk
                cur_start = seg.start
                buf = []
            buf.append(seg.text)
        if cur_speaker is not None:
            parts.append(f"**{cur_speaker}** [{_format_time(cur_start)}]")
            parts.append(" ".join(buf).strip())
    else:
        for seg in segments:
            parts.append(f"[{_format_time(seg.start)}] {seg.text}")
    return "\n".join(parts)


_SUMMARY_SYSTEM = (
    "당신은 한국어 회의록·강의 정리 전문가입니다. 주어진 전사 내용을 "
    "다음 구조의 마크다운으로 정리하세요:\n\n"
    "## 핵심 요약\n"
    "  - 3~5개 불릿 (각 한 줄)\n"
    "## 주요 안건/주제\n"
    "  - 안건별 H3 헤딩 + 핵심 발언 요지 (화자 표시 있으면 인용)\n"
    "## 결정 사항\n"
    "  - 합의된 내용만, 없으면 \"명시적 결정 없음\"\n"
    "## 액션 아이템\n"
    "  - 담당자/마감일 식별 가능하면 같이. 없으면 \"식별되지 않음\"\n"
    "## 미해결 질문\n"
    "  - 답이 보류된 항목\n\n"
    "전사에 없는 내용을 추측하지 마세요. 화자 라벨(SPEAKER_00 등)이 "
    "있으면 자연스러운 이름 대신 그대로 두세요."
)


async def _summarize(transcript_text: str) -> str:
    provider = get_provider("ollama")
    if provider is None or not provider.enabled:
        return "(요약 사용 불가 — Ollama 비활성)"
    model = (
        settings.transcription_summary_model.strip()
        or settings.ollama_model
    )
    history = [
        ChatMessage(role="system", content=_SUMMARY_SYSTEM),
        ChatMessage(role="user", content=transcript_text),
    ]
    buf: list[str] = []
    async for delta in provider.stream(history, model=model):
        buf.append(delta)
    return "".join(buf).strip() or "(빈 요약)"


async def _update(
    db, tr: models.Transcript, **fields,
) -> None:
    for k, v in fields.items():
        setattr(tr, k, v)
    await db.commit()


async def run_transcription(transcript_id: str, audio_path: str) -> None:
    """Top-level coroutine kicked off by the upload endpoint. Cleans
    up the temp audio file when done, regardless of success/fail."""
    try:
        await _run_transcription(transcript_id, audio_path)
    finally:
        try:
            Path(audio_path).unlink(missing_ok=True)
        except Exception:  # noqa: BLE001
            pass


async def _run_transcription(transcript_id: str, audio_path: str) -> None:
    async with SessionLocal() as db:
        tr = await db.scalar(
            select(models.Transcript).where(
                models.Transcript.id == transcript_id
            )
        )
        if tr is None:
            return
        await _update(db, tr, status="transcribing", progress=0.0)

        loop = asyncio.get_running_loop()

        def progress_cb(p: float) -> None:
            asyncio.run_coroutine_threadsafe(
                _bump_progress(transcript_id, p), loop,
            )

        try:
            segments, info = await asyncio.to_thread(
                transcribe, audio_path, language=None, on_progress=progress_cb,
            )
        except Exception as exc:  # noqa: BLE001
            log.exception("transcription failed: %s", exc)
            await _update(
                db, tr, status="failed",
                error=f"전사 실패: {type(exc).__name__}: {exc}"[:1000],
            )
            return

        tr.language = info.get("language")
        tr.duration_sec = float(info.get("duration") or 0.0)
        await db.commit()

        diarized = False
        if diar.available():
            await _update(db, tr, status="diarizing", progress=None)
            try:
                turns = await asyncio.to_thread(diar.diarize, audio_path)
                segments = diar.align(segments, turns)
                diarized = bool(turns)
            except Exception as exc:  # noqa: BLE001
                log.warning("diarization failed (계속 진행): %s", exc)

        transcript_md = _render_transcript(segments, diarized=diarized)
        await _update(
            db, tr, status="summarizing", diarized=diarized, progress=None,
        )

        # Build the chat Session that holds the result.
        ts = datetime.now(timezone.utc).strftime("%m-%d %H:%M")
        title = f"[회의록] {Path(tr.source_filename).stem or '녹음'} · {ts}"
        session = models.Session(user_id=tr.user_id, title=title)
        db.add(session)
        await db.flush()
        # User message = full transcript (chunker-friendly). Marked
        # hidden so the chat panel collapses it into a "원문 전사 —
        # 클릭해서 펼치기" placeholder instead of flooding the bubble
        # row. The row stays in the DB for the export modal and the
        # RAG indexer.
        db.add(models.Message(
            session_id=session.id, role="user", content=transcript_md,
            hidden=True,
        ))
        await db.commit()

        # Summarise via Ollama and persist the assistant reply.
        try:
            start = time.monotonic()
            summary = await _summarize(transcript_md)
            latency_ms = int((time.monotonic() - start) * 1000)
        except Exception as exc:  # noqa: BLE001
            log.exception("summary failed: %s", exc)
            await _update(
                db, tr, status="failed", session_id=session.id,
                error=f"요약 실패: {type(exc).__name__}: {exc}"[:1000],
            )
            return

        db.add(models.Message(
            session_id=session.id,
            role="assistant",
            provider="ollama",
            content=summary,
            latency_ms=latency_ms,
            tokens_out=len(summary.split()),
        ))
        await _update(
            db, tr, status="ok", session_id=session.id, progress=1.0,
        )


async def _bump_progress(transcript_id: str, p: float) -> None:
    async with SessionLocal() as db:
        tr = await db.scalar(
            select(models.Transcript).where(
                models.Transcript.id == transcript_id
            )
        )
        if tr is None or tr.status not in {"transcribing"}:
            return
        tr.progress = float(p)
        await db.commit()
