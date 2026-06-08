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


def _resolve_cached_snapshot(model_ref: str, model_dir: Path) -> Path | None:
    """Look for a pre-downloaded faster-whisper snapshot under the
    configured model dir so an offline boot doesn't have to call the
    HF hub. Snapshots land at:
       {model_dir}/models--Systran--faster-whisper-{size}/snapshots/{hash}/
    The actual hash varies — pick the most recently modified one when
    multiple exist (latest sync wins). Returns None if nothing fits."""
    if Path(model_ref).expanduser().is_dir():
        # Already an absolute path — caller can use as-is.
        return Path(model_ref).expanduser()
    # Try the standard Systran namespace first (what faster-whisper
    # downloads by default), then a few common fallbacks the user
    # may have synced from another machine.
    candidates = [
        f"models--Systran--faster-whisper-{model_ref}",
        f"models--openai--whisper-{model_ref}",
        f"models--guillaumekln--faster-whisper-{model_ref}",
    ]
    for repo_dir_name in candidates:
        repo_root = model_dir / repo_dir_name / "snapshots"
        if not repo_root.is_dir():
            continue
        snaps = [p for p in repo_root.iterdir() if p.is_dir()]
        if not snaps:
            continue
        # Newest snapshot — operator may have rsynced an updated copy.
        snaps.sort(key=lambda p: p.stat().st_mtime, reverse=True)
        log.info(
            "whisper: found cached snapshot for %r at %s",
            model_ref, snaps[0],
        )
        return snaps[0]
    return None


def _offline_help_message(model_ref: str, model_dir: Path) -> str:
    """The concrete copy-paste instructions an operator running on a
    closed network needs. Different from the offline-detection error
    in that it lists the exact download command + path to copy to."""
    return (
        f"오프라인 모드에서 Whisper 모델을 찾지 못했습니다 "
        f"(model={model_ref!r}, WHISPER_MODEL_DIR={model_dir}).\n\n"
        "닫힌 망 설치 절차:\n"
        f"  1) 인터넷 가능한 PC에서:\n"
        f"     pip install -U \"huggingface_hub[cli]\"\n"
        f"     huggingface-cli download Systran/faster-whisper-{model_ref} "
        f"--local-dir ./whisper-{model_ref}\n"
        f"  2) ./whisper-{model_ref} 폴더 전체를 백엔드 서버로 복사\n"
        f"  3) backend/.env 에 다음 중 하나 설정:\n"
        f"     · WHISPER_MODEL=/복사한/경로/whisper-{model_ref}  (절대경로 직접 지정)\n"
        f"     · 또는 {model_dir / f'models--Systran--faster-whisper-{model_ref}' / 'snapshots' / '<hash>'} "
        f"위치에 두고 WHISPER_MODEL={model_ref} 유지 (자동 발견)\n"
        f"  4) 백엔드 재시작"
    )


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
    model_dir = Path(settings.whisper_model_dir).expanduser()
    model_dir.mkdir(parents=True, exist_ok=True)
    # WHISPER_MODEL may be a name ("large-v3") that downloads from the
    # hub, OR an absolute path to a pre-downloaded CTranslate2 model
    # directory (the closed-network case). When running offline,
    # auto-discover any previously-cached snapshot so the operator
    # doesn't have to switch WHISPER_MODEL to a long hash path.
    model_ref = settings.whisper_model
    offline = os.environ.get("HF_HUB_OFFLINE") == "1"
    if offline and not Path(model_ref).expanduser().is_dir():
        cached = _resolve_cached_snapshot(model_ref, model_dir)
        if cached is not None:
            log.info("whisper: using cached snapshot %s", cached)
            model_ref = str(cached)
    log.info(
        "loading whisper model=%s device=%s compute=%s offline=%s",
        model_ref, device, compute_type,
        os.environ.get("HF_HUB_OFFLINE", "0"),
    )
    try:
        _MODEL = WhisperModel(
            model_ref,
            device=device,
            compute_type=compute_type,
            download_root=str(model_dir),
        )
    except Exception as exc:  # noqa: BLE001
        if offline:
            raise RuntimeError(
                _offline_help_message(settings.whisper_model, model_dir)
                + f"\n\n원인: {type(exc).__name__}: {exc}"
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
