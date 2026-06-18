"""외부 알림 webhook (#120).

폐쇄망에서 사내 슬랙/이메일 게이트가 받을 단순한 JSON POST.

  - dispatch(kind, title, body): 한 건 발송 + WebhookDelivery 행 추가.
  - probe_and_alert(): 디스크/5xx 임계치 검사 후 hit 되면 dispatch.
  - probe_loop(): probe_and_alert 를 settings.webhook_check_interval_seconds
    간격으로 백그라운드 실행.

설계 메모:
  - settings.webhook_alert_url 이 비어 있으면 모든 dispatch / probe 가
    silently no-op — '꺼져 있음' 상태.
  - 같은 임계치가 연속으로 hit 돼도 발송이 매번 일어나지 않게 마지막
    발송 시각을 _last_alert_at 에 박아 두고 1시간 쿨다운.
  - 발송 자체는 best-effort — 실패해도 main loop 가 죽으면 안 됨.
"""
from __future__ import annotations

import asyncio
import logging
import time
from datetime import datetime, timedelta, timezone

import httpx
from sqlalchemy import func, select

from . import models
from .config import settings
from .database import SessionLocal


_log = logging.getLogger("uvicorn.error")

# kind → 마지막 발송 monotonic 시각.  같은 종류 알림이 1시간 이내에 또
# 일어나면 스킵해 노이즈를 줄임.
_last_alert_at: dict[str, float] = {}
_COOLDOWN_SECONDS = 60 * 60


async def dispatch(*, kind: str, title: str, body: str | None = None) -> bool:
    """webhook_alert_url 로 한 건 POST.  결과는 WebhookDelivery 에 기록.
    반환: 발송 성공 여부.  설정이 없으면 False (no-op)."""
    url = (settings.webhook_alert_url or "").strip()
    if not url:
        return False

    payload = {
        "kind": kind,
        "title": title,
        "body": body or "",
        "ts": datetime.now(timezone.utc).isoformat(),
    }
    status_code: int | None = None
    error: str | None = None
    delivery_id: str | None = None

    try:
        async with SessionLocal() as db:
            row = models.WebhookDelivery(
                kind=kind[:40],
                title=title[:200],
                body=body,
                target_url=url[:500],
                status="pending",
                attempts=1,
            )
            db.add(row)
            await db.commit()
            delivery_id = row.id
    except Exception as exc:  # noqa: BLE001
        _log.warning("webhook delivery row insert failed: %s", exc)

    timeout = httpx.Timeout(5.0, connect=2.0)
    try:
        async with httpx.AsyncClient(timeout=timeout) as client:
            r = await client.post(url, json=payload)
            status_code = r.status_code
            if r.status_code >= 400:
                error = f"HTTP {r.status_code}: {r.text[:200]}"
    except Exception as exc:  # noqa: BLE001
        error = f"{type(exc).__name__}: {exc}"

    if delivery_id:
        try:
            async with SessionLocal() as db:
                row = await db.get(models.WebhookDelivery, delivery_id)
                if row is not None:
                    row.status = "failed" if error else "sent"
                    row.response_code = status_code
                    row.error = (error or None)
                    await db.commit()
        except Exception as exc:  # noqa: BLE001
            _log.warning("webhook delivery row update failed: %s", exc)

    return error is None


async def probe_and_alert() -> None:
    """현재 상태를 점검하고 임계치 hit 시 알림 발송.

    체크 항목:
      1. 디스크 사용율 (settings.webhook_disk_pct, 기본 90%)
      2. 최근 30분 5xx 비율 (settings.webhook_error_rate_pct, 기본 5%)
      3. Ollama 응답 안 됨

    각 항목은 별도 kind 로 분류해 쿨다운이 독립적으로 적용.
    """
    if not (settings.webhook_alert_url or "").strip():
        return
    now = time.monotonic()

    async def _maybe_send(kind: str, title: str, body: str) -> None:
        last = _last_alert_at.get(kind, 0.0)
        if now - last < _COOLDOWN_SECONDS:
            return
        _last_alert_at[kind] = now
        await dispatch(kind=kind, title=title, body=body)

    # 1) 디스크.
    try:
        import shutil
        usage = shutil.disk_usage("/")
        pct = usage.used * 100.0 / usage.total
        if pct >= settings.webhook_disk_pct:
            await _maybe_send(
                kind="disk_full",
                title=f"⚠️ 디스크 사용율 {pct:.1f}% (임계 {settings.webhook_disk_pct}%)",
                body=(
                    f"전체 {usage.total/1e9:.1f} GB 중 "
                    f"{usage.used/1e9:.1f} GB 사용, "
                    f"여유 {usage.free/1e9:.1f} GB."
                ),
            )
    except Exception as exc:  # noqa: BLE001
        _log.warning("disk probe failed: %s", exc)

    # 2) 최근 30분 5xx 비율.
    try:
        cutoff = datetime.now(timezone.utc).replace(tzinfo=None) - timedelta(
            minutes=30
        )
        async with SessionLocal() as db:
            total = (
                await db.execute(
                    select(func.count(models.RequestLog.id))
                    .where(models.RequestLog.created_at >= cutoff)
                )
            ).scalar_one()
            errors = (
                await db.execute(
                    select(func.count(models.RequestLog.id))
                    .where(
                        models.RequestLog.created_at >= cutoff,
                        models.RequestLog.status_code >= 500,
                    )
                )
            ).scalar_one()
        # 50건 이상은 돼야 의미 있는 비율 — 적은 표본에서 알림 폭주 방지.
        if total >= 50:
            rate = errors * 100.0 / total
            if rate >= settings.webhook_error_rate_pct:
                await _maybe_send(
                    kind="high_error_rate",
                    title=f"⚠️ 5xx 비율 {rate:.1f}% (임계 {settings.webhook_error_rate_pct}%)",
                    body=f"최근 30분 / 전체 {total}건 중 5xx {errors}건.",
                )
    except Exception as exc:  # noqa: BLE001
        _log.warning("error-rate probe failed: %s", exc)

    # 3) Ollama 연결.
    try:
        timeout = httpx.Timeout(3.0, connect=1.0)
        async with httpx.AsyncClient(timeout=timeout) as client:
            r = await client.get(
                f"{settings.ollama_base_url.rstrip('/')}/api/tags"
            )
        if r.status_code >= 400:
            await _maybe_send(
                kind="ollama_down",
                title="⚠️ Ollama 응답 이상",
                body=f"GET {settings.ollama_base_url}/api/tags → HTTP {r.status_code}",
            )
    except Exception as exc:
        await _maybe_send(
            kind="ollama_down",
            title="⚠️ Ollama 접속 실패",
            body=f"{type(exc).__name__}: {exc}",
        )


async def probe_loop() -> None:
    """settings.webhook_check_interval_seconds 간격으로 무한 루프.
    main.lifespan 에서 task 로 띄움."""
    interval = max(60, int(settings.webhook_check_interval_seconds or 300))
    while True:
        try:
            await probe_and_alert()
        except Exception as exc:  # noqa: BLE001
            _log.warning("webhook probe_loop iter failed: %s", exc)
        await asyncio.sleep(interval)
