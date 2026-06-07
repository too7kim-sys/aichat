"""faster-whisper wrapper. Model is loaded lazily on first use and
cached for the process lifetime — first call pays the load cost
(~3-10s for large-v3 on GPU), subsequent calls reuse the warm model.

Returns segments as `[ {start, end, text} ]` matching faster-whisper's
own output shape so the diarization aligner can merge speaker turns
into them directly."""
from __future__ import annotations

import logging
import os
from dataclasses import dataclass
from pathlib import Path
from typing import Callable

from ..config import settings


def _apply_offline_env() -> None:
    """When running on a closed network, block all HuggingFace hub
    network calls so a missing model fails fast with a clear message
    instead of hanging on a connection timeout. Also auto-enabled when
    WHISPER_MODEL points at a local directory that already exists."""
    model_is_local_path = Path(settings.whisper_model).expanduser().is_dir()
    if settings.transcription_offline or model_is_local_path:
        os.environ.setdefault("HF_HUB_OFFLINE", "1")
        os.environ.setdefault("TRANSFORMERS_OFFLINE", "1")
        os.environ.setdefault("HF_HUB_DISABLE_TELEMETRY", "1")

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
    _apply_offline_env()
    try:
        from faster_whisper import WhisperModel
    except ImportError as exc:  # pragma: no cover
        raise RuntimeError(
            "faster-whisper 가 설치돼 있지 않습니다. "
            "`pip install faster-whisper` 후 다시 시도하세요."
        ) from exc
    device, compute_type = _select_device()
    # WHISPER_MODEL may be a name ("large-v3") that downloads from the
    # hub, OR an absolute path to a pre-downloaded CTranslate2 model
    # directory (the closed-network case). faster-whisper accepts both.
    model_ref = settings.whisper_model
    log.info(
        "loading whisper model=%s device=%s compute=%s offline=%s",
        model_ref, device, compute_type,
        os.environ.get("HF_HUB_OFFLINE", "0"),
    )
    model_dir = Path(settings.whisper_model_dir).expanduser()
    model_dir.mkdir(parents=True, exist_ok=True)
    try:
        _MODEL = WhisperModel(
            model_ref,
            device=device,
            compute_type=compute_type,
            download_root=str(model_dir),
        )
    except Exception as exc:  # noqa: BLE001
        if os.environ.get("HF_HUB_OFFLINE") == "1":
            raise RuntimeError(
                f"오프라인 모드에서 Whisper 모델을 찾지 못했습니다 "
                f"(model={model_ref!r}). 인터넷 PC에서 모델을 받아 "
                f"WHISPER_MODEL 에 로컬 폴더 경로를 지정하세요. "
                f"원인: {type(exc).__name__}: {exc}"
            ) from exc
        raise
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
