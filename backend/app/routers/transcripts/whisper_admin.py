"""transcripts.py 가 792줄로 커져 부분 분리.  이 파일의 모든 route 는
transcripts._core.router (prefix='/api/transcripts') 에 직접 등록.  main.py
의 include_router 는 transcripts 패키지의 단일 router 만 부르므로 분할은
internal-only."""
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

from ._core import router

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
    from ...transcribe.whisper import _resolve_cached_snapshot

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
