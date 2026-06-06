"""faster-whisper wrapper. Model is loaded lazily on first use and
cached for the process lifetime — first call pays the load cost
(~3-10s for large-v3 on GPU), subsequent calls reuse the warm model.

Returns segments as `[ {start, end, text} ]` matching faster-whisper's
own output shape so the diarization aligner can merge speaker turns
into them directly."""
from __future__ import annotations

import logging
from dataclasses import dataclass
from pathlib import Path
from typing import Callable

from ..config import settings

log = logging.getLogger("uvicorn.error")

_MODEL = None  # type: ignore[var-annotated]


@dataclass
class Segment:
    start: float
    end: float
    text: str
    speaker: str | None = None


def _select_device() -> tuple[str, str]:
    """Resolve (device, compute_type) honouring WHISPER_DEVICE=auto.
    CPU forces int8 because float16 isn't supported there."""
    dev = settings.whisper_device.lower()
    if dev == "auto":
        try:
            import torch
            dev = "cuda" if torch.cuda.is_available() else "cpu"
        except ImportError:
            dev = "cpu"
    if dev == "cpu":
        return "cpu", "int8"
    return dev, settings.whisper_compute_type


def _load_model():
    global _MODEL
    if _MODEL is not None:
        return _MODEL
    try:
        from faster_whisper import WhisperModel
    except ImportError as exc:  # pragma: no cover
        raise RuntimeError(
            "faster-whisper 가 설치돼 있지 않습니다. "
            "`pip install faster-whisper` 후 다시 시도하세요."
        ) from exc
    device, compute_type = _select_device()
    log.info(
        "loading whisper model=%s device=%s compute=%s",
        settings.whisper_model, device, compute_type,
    )
    model_dir = Path(settings.whisper_model_dir).expanduser()
    model_dir.mkdir(parents=True, exist_ok=True)
    _MODEL = WhisperModel(
        settings.whisper_model,
        device=device,
        compute_type=compute_type,
        download_root=str(model_dir),
    )
    return _MODEL


def transcribe(
    audio_path: str,
    *,
    language: str | None = None,
    on_progress: Callable[[float], None] | None = None,
) -> tuple[list[Segment], dict]:
    """Run faster-whisper on an audio file. Returns (segments, info)
    where info carries language + duration so the caller can record
    them on the Transcript row. `on_progress(0..1)` is invoked as
    segments stream in so the UI can show a live bar."""
    model = _load_model()
    # vad_filter trims long silences which keeps total runtime under
    # control on lecture-style recordings that have lots of pauses.
    segments_iter, info = model.transcribe(
        audio_path,
        language=language,
        vad_filter=True,
        beam_size=5,
        # Korean works better with the dedicated initial prompt that
        # nudges the model away from English transcription drift.
        initial_prompt="이 녹음은 한국어 회의 또는 강의입니다.",
    )
    total = float(getattr(info, "duration", 0.0) or 0.0)
    out: list[Segment] = []
    last_emit = 0.0
    for seg in segments_iter:
        out.append(Segment(start=seg.start, end=seg.end, text=seg.text.strip()))
        if on_progress and total > 0:
            done = min(1.0, seg.end / total)
            # Throttle to ~every 1% so DB writes stay reasonable.
            if done - last_emit >= 0.01 or done >= 1.0:
                on_progress(done)
                last_emit = done
    return out, {
        "language": getattr(info, "language", None),
        "duration": total,
    }
