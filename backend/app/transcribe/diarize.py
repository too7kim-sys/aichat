"""pyannote.audio diarization wrapper. Optional — when the package
or HF token are missing, the runner falls back to "no speakers" and
the transcript renders without SPEAKER labels.

We align speaker turns onto the Whisper segments by majority overlap:
for each Whisper segment, the speaker whose turns cover the largest
slice of [seg.start, seg.end] wins. This avoids fragmenting a
speaker's continuous sentence across multiple tiny labels."""
from __future__ import annotations

import logging
from dataclasses import dataclass

from ..config import settings
from .whisper import Segment

log = logging.getLogger("uvicorn.error")

_PIPELINE = None  # type: ignore[var-annotated]


@dataclass
class SpeakerTurn:
    start: float
    end: float
    speaker: str


def available() -> bool:
    """Cheap availability check the runner uses to decide whether to
    even attempt diarization."""
    if not settings.enable_diarization:
        return False
    if not settings.hf_token:
        return False
    try:
        import pyannote.audio  # noqa: F401
        return True
    except ImportError:
        return False


def _load_pipeline():
    global _PIPELINE
    if _PIPELINE is not None:
        return _PIPELINE
    # Apply the same offline guard as Whisper so a closed-network box
    # uses the locally-cached pyannote models instead of trying the hub.
    from .whisper import _apply_offline_env
    _apply_offline_env()
    try:
        from pyannote.audio import Pipeline
    except ImportError as exc:  # pragma: no cover
        raise RuntimeError(
            "pyannote.audio 가 설치돼 있지 않습니다. "
            "`pip install pyannote.audio` 후 .env에 HF_TOKEN 설정."
        ) from exc
    log.info("loading pyannote diarization pipeline")
    pipeline = Pipeline.from_pretrained(
        "pyannote/speaker-diarization-3.1",
        use_auth_token=settings.hf_token,
    )
    # Move to GPU if available — diarization is much faster there.
    try:
        import torch
        if torch.cuda.is_available():
            pipeline.to(torch.device("cuda"))
    except ImportError:
        pass
    _PIPELINE = pipeline
    return _PIPELINE


def diarize(audio_path: str) -> list[SpeakerTurn]:
    pipeline = _load_pipeline()
    annotation = pipeline(audio_path)
    out: list[SpeakerTurn] = []
    for turn, _, speaker in annotation.itertracks(yield_label=True):
        out.append(SpeakerTurn(
            start=float(turn.start),
            end=float(turn.end),
            speaker=str(speaker),
        ))
    return out


def align(
    segments: list[Segment], turns: list[SpeakerTurn],
) -> list[Segment]:
    """Stamp a speaker label onto each Whisper segment based on which
    turn covers the most of its time window."""
    if not turns:
        return segments
    out: list[Segment] = []
    for seg in segments:
        best_speaker = None
        best_overlap = 0.0
        for t in turns:
            overlap = max(0.0, min(seg.end, t.end) - max(seg.start, t.start))
            if overlap > best_overlap:
                best_overlap = overlap
                best_speaker = t.speaker
        out.append(Segment(
            start=seg.start, end=seg.end, text=seg.text,
            speaker=best_speaker,
        ))
    return out
