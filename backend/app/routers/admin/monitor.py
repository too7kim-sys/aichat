"""Split-out admin endpoints — admin.py 가 2236줄로 커져 부분 분리.
이 파일의 모든 route 는 admin._core.router (prefix='/api/admin') 에
직접 등록된다.  main.py 의 include_router 는 admin 패키지의 단일
router 만 부르므로 새 파일을 추가해도 main 은 변경 없음."""
from __future__ import annotations

import os
from datetime import datetime, timezone
from pathlib import Path

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from pydantic import BaseModel, Field
from sqlalchemy import func, or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from ... import app_settings, audit, models, schemas
from ...auth import get_current_user, require_admin, require_staff
from ...config import settings
from ...database import get_db
from ._core import router

# ── 관측/모니터링 (#116~#120) ────────────────────────────────
# 요청 트레이싱 raw 데이터로 slow request 패널, 엔드포인트별 통계, SLO
# 대시보드를 구축.  raw 행은 RequestLogMiddleware 가 만들고, 여기서는
# 읽기 전용 집계만.


@router.get("/requests/slow")
async def list_slow_requests(
    limit: int = Query(200, ge=1, le=1000),
    threshold_ms: int | None = Query(None, ge=0, le=300_000),
    _staff: models.User = Depends(require_staff),
    db: AsyncSession = Depends(get_db),
):
    """Slow request 로그 (#117).  threshold_ms 를 안 주면
    settings.slow_request_ms (기본 500ms) 사용."""
    th = threshold_ms if threshold_ms is not None else settings.slow_request_ms
    rows = (
        await db.execute(
            select(models.RequestLog)
            .where(models.RequestLog.latency_ms >= th)
            .order_by(models.RequestLog.created_at.desc())
            .limit(limit)
        )
    ).scalars().all()
    user_ids = {r.user_id for r in rows if r.user_id}
    emails: dict[str, str] = {}
    if user_ids:
        for uid, em in (
            await db.execute(
                select(models.User.id, models.User.email)
                .where(models.User.id.in_(user_ids))
            )
        ).all():
            emails[uid] = em
    return {
        "threshold_ms": th,
        "items": [
            {
                "id": r.id,
                "method": r.method,
                "path": r.path,
                "status_code": r.status_code,
                "latency_ms": r.latency_ms,
                "user_email": emails.get(r.user_id or "", "—"),
                "ip": r.ip,
                "created_at": r.created_at.isoformat() if r.created_at else None,
            }
            for r in rows
        ],
    }


@router.get("/requests/stats")
async def endpoint_stats(
    hours: int = 24,
    _staff: models.User = Depends(require_staff),
    db: AsyncSession = Depends(get_db),
):
    """엔드포인트별 p50/p95/p99 + 호출 수 + 5xx 비율 (#118).  최근 N
    시간 (기본 24h)."""
    from datetime import datetime as _dt, timedelta as _td
    cutoff = _dt.utcnow() - _td(hours=max(1, min(int(hours), 24 * 30)))
    rows = (
        await db.execute(
            select(
                models.RequestLog.path,
                models.RequestLog.method,
                models.RequestLog.status_code,
                models.RequestLog.latency_ms,
            )
            .where(models.RequestLog.created_at >= cutoff)
        )
    ).all()
    # path+method 묶음으로 집계.
    buckets: dict[tuple[str, str], list[tuple[int, int]]] = {}
    for path, method, status, latency in rows:
        buckets.setdefault((method, path), []).append((status, latency))
    out: list[dict] = []
    for (method, path), entries in buckets.items():
        latencies = sorted(e[1] for e in entries)
        n = len(latencies)
        if n == 0:
            continue
        def _pct(p: float) -> int:
            idx = max(0, min(n - 1, int(p * n / 100)))
            return latencies[idx]
        err = sum(1 for s, _ in entries if s >= 500)
        out.append({
            "method": method,
            "path": path,
            "count": n,
            "p50": _pct(50),
            "p95": _pct(95),
            "p99": _pct(99),
            "errors_5xx": err,
            "error_rate_pct": round(err * 100.0 / n, 2),
        })
    # 호출 수 많은 순.
    out.sort(key=lambda x: x["count"], reverse=True)
    return {"hours": hours, "items": out[:200]}


@router.get("/requests/slo")
async def slo_dashboard(
    _staff: models.User = Depends(require_staff),
    db: AsyncSession = Depends(get_db),
):
    """SLO 대시보드 (#119).  최근 24h / 7d 의 성공율·5xx 비율·평균
    latency 합산 + 시간대별 trend (24h 는 1시간 bucket, 7d 는 1일 bucket).
    """
    from datetime import datetime as _dt, timedelta as _td
    now = _dt.utcnow()

    async def _summary(since: _dt) -> dict:
        rows = (
            await db.execute(
                select(
                    models.RequestLog.status_code,
                    models.RequestLog.latency_ms,
                )
                .where(models.RequestLog.created_at >= since)
            )
        ).all()
        total = len(rows)
        if total == 0:
            return {
                "total": 0, "success_pct": 100.0,
                "error_5xx_pct": 0.0, "avg_latency_ms": 0,
            }
        err = sum(1 for s, _ in rows if s >= 500)
        success = sum(1 for s, _ in rows if s < 400)
        avg_lat = sum(l for _, l in rows) / total
        return {
            "total": total,
            "success_pct": round(success * 100.0 / total, 2),
            "error_5xx_pct": round(err * 100.0 / total, 2),
            "avg_latency_ms": round(avg_lat, 1),
        }

    async def _trend(
        since: _dt, bucket_seconds: int, label_fmt: str,
    ) -> list[dict]:
        rows = (
            await db.execute(
                select(
                    models.RequestLog.created_at,
                    models.RequestLog.status_code,
                    models.RequestLog.latency_ms,
                )
                .where(models.RequestLog.created_at >= since)
                .order_by(models.RequestLog.created_at)
            )
        ).all()
        buckets: dict[str, list[tuple[int, int]]] = {}
        for ts, status, latency in rows:
            # bucket key = ts 를 bucket_seconds 단위로 floor.
            epoch = int(ts.replace(tzinfo=timezone.utc).timestamp())
            floored = epoch - (epoch % bucket_seconds)
            key = _dt.fromtimestamp(floored, tz=timezone.utc).strftime(label_fmt)
            buckets.setdefault(key, []).append((status, latency))
        out = []
        for key in sorted(buckets):
            entries = buckets[key]
            total = len(entries)
            err = sum(1 for s, _ in entries if s >= 500)
            avg_lat = sum(l for _, l in entries) / total if total else 0
            out.append({
                "label": key,
                "total": total,
                "errors_5xx": err,
                "avg_latency_ms": round(avg_lat, 1),
            })
        return out

    return {
        "now": now.isoformat(),
        "h24": await _summary(now - _td(hours=24)),
        "d7": await _summary(now - _td(days=7)),
        "trend_24h": await _trend(now - _td(hours=24), 3600, "%H:00"),
        "trend_7d": await _trend(now - _td(days=7), 86400, "%m-%d"),
    }


# ── 웹훅 알림 (#120) ─────────────────────────────────────────


@router.get("/webhooks/recent")
async def list_recent_webhooks(
    limit: int = Query(50, ge=1, le=500),
    _admin: models.User = Depends(require_admin),
    db: AsyncSession = Depends(get_db),
):
    """최근 발송된 webhook 결과 — admin 이 '동작했나' 점검할 때."""
    rows = (
        await db.execute(
            select(models.WebhookDelivery)
            .order_by(models.WebhookDelivery.created_at.desc())
            .limit(limit)
        )
    ).scalars().all()
    return [
        {
            "id": r.id,
            "kind": r.kind,
            "title": r.title,
            "body": r.body,
            "target_url": r.target_url,
            "status": r.status,
            "response_code": r.response_code,
            "error": r.error,
            "attempts": r.attempts,
            "created_at": r.created_at.isoformat() if r.created_at else None,
        }
        for r in rows
    ]


@router.post("/webhooks/test", status_code=204)
async def test_webhook(
    _admin: models.User = Depends(require_admin),
    db: AsyncSession = Depends(get_db),
):
    """현재 settings.webhook_alert_url 로 테스트 알림 발송.  설정이
    안 돼 있으면 400."""
    url = (settings.webhook_alert_url or "").strip()
    if not url:
        raise HTTPException(400, "webhook_alert_url 이 설정돼 있지 않습니다 (.env).")
    from ... import webhook as _wh
    await _wh.dispatch(
        kind="test", title="aichat 웹훅 테스트",
        body="이 메시지는 관리자가 수동으로 보낸 테스트입니다.",
    )
    return


# ── 답변 품질 분석 (#37) ─────────────────────────────────────
