"""Wall-clock aligned scheduler for workflows — fires on the same
boundary logic as the RAG indexer's auto-refresh. Sub-day intervals
fire at :00 / :slot from local midnight; day-or-longer intervals fire
once at rag_daily_refresh_hour local time, every N days."""
from __future__ import annotations

import asyncio
import logging
from datetime import datetime, timezone

from sqlalchemy import select

from .. import models
from ..database import SessionLocal
from ..rag.indexer import _due_for_refresh
from .runner import run_workflow

log = logging.getLogger("uvicorn.error")

_BACKGROUND_RUN_TASKS: set[asyncio.Task] = set()


async def scheduler_loop(poll_seconds: int = 60) -> None:
    """Background task launched from FastAPI's lifespan. Each tick
    walks workflows with schedule_interval_minutes > 0 and fires the
    ones whose wall-clock boundary has passed since the last run."""
    log.info("workflow scheduler started (poll=%ds)", poll_seconds)
    while True:
        try:
            await asyncio.sleep(poll_seconds)
            await _tick()
        except asyncio.CancelledError:
            log.info("workflow scheduler cancelled")
            return
        except Exception as exc:  # noqa: BLE001
            log.exception("workflow scheduler tick failed: %s", exc)


async def _tick() -> None:
    async with SessionLocal() as db:
        rows = await db.execute(
            select(models.Workflow).where(
                models.Workflow.enabled.is_(True),
                models.Workflow.schedule_interval_minutes > 0,
                # Skip ones that are currently running so a slow LLM
                # call doesn't queue up another tick on top.
                (models.Workflow.last_run_status != "running")
                | models.Workflow.last_run_status.is_(None),
            )
        )
        candidates = list(rows.scalars())
    now = datetime.now(timezone.utc)
    from . import holidays as _hol
    # 워크플로 스케줄은 로컬 시간 기준이라 공휴일 판정도 로컬 날짜로.
    local_today = datetime.now().date()
    holiday_label = _hol.label_for(local_today)
    for wf in candidates:
        if not _due_for_refresh(
            wf.schedule_interval_minutes, wf.last_run_at, now
        ):
            continue
        if wf.skip_holidays and holiday_label is not None:
            log.info(
                "workflow scheduler skipping %s — 오늘은 %s",
                wf.id, holiday_label,
            )
            continue
        log.info(
            "workflow scheduler firing %s (interval=%dm)",
            wf.id, wf.schedule_interval_minutes,
        )
        task = asyncio.get_running_loop().create_task(run_workflow(wf.id))
        _BACKGROUND_RUN_TASKS.add(task)
        task.add_done_callback(_BACKGROUND_RUN_TASKS.discard)
