"""요청 트레이싱 middleware (#116~#118).

모든 ASGI 요청을 RequestLog 한 줄로 적어 throughput/latency 분석 + slow
request 패널 + p50/p95/p99 통계의 raw 데이터로 활용한다.  ErrorLog 와
별개 — ErrorLog 는 실패만, 여기는 성공도 포함.

설계 메모:
  - /api/health, /api/admin/health 같은 로드 밸런서 probe 는 폭주성이라
    기록 스킵.  filter_path() 가 결정.
  - 로깅 실패가 응답을 막지 않도록 try/except 로 감싸 silently 흡수.
  - 경로 정규화: UUID 처럼 보이는 path 세그먼트를 '{id}' 로 치환해
    /api/sessions/abc-def → /api/sessions/{id} 처럼 그룹 통계가 가능.
  - 보존 기간 초과 행은 cleanup_request_log() 가 정리 (DB init 후 호출).
"""
from __future__ import annotations

import logging
import re
import time
from datetime import datetime, timedelta, timezone

from sqlalchemy import delete
from starlette.middleware.base import BaseHTTPMiddleware
from starlette.requests import Request
from starlette.responses import Response

from . import models
from .config import settings
from .database import SessionLocal


_log = logging.getLogger("uvicorn.error")

# UUID v4 패턴 — 경로 세그먼트가 이걸 매치하면 {id} 로 치환.
_UUID_RE = re.compile(
    r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$",
    re.I,
)
# 짧은 숫자 id (e.g. /messages/123) 도 같이 묶음.
_NUM_RE = re.compile(r"^\d{1,12}$")

# noisy probe 경로는 기록 스킵 — 운영기에서 1초마다 찍힐 수 있다.
_SKIP_PREFIXES = (
    "/api/health",
    "/static/",
    "/assets/",
    "/favicon",
    "/manifest.json",
)


def _client_ip(request: Request) -> str | None:
    fwd = request.headers.get("x-forwarded-for")
    if fwd:
        return fwd.split(",", 1)[0].strip()
    return request.client.host if request.client else None


def _user_id_of(request: Request) -> str | None:
    # auth.get_current_user 가 request.state.user 에 박아 두면 사용.
    # SSE / 무인증 경로는 None.
    u = getattr(request.state, "user", None)
    return getattr(u, "id", None) if u else None


def _normalize_path(raw: str) -> str:
    """UUID / 숫자 세그먼트를 {id} 로 치환해 엔드포인트 그룹화."""
    if not raw or raw == "/":
        return "/"
    parts = raw.split("/")
    out: list[str] = []
    for p in parts:
        if _UUID_RE.match(p) or _NUM_RE.match(p):
            out.append("{id}")
        else:
            out.append(p)
    return "/".join(out)


def filter_path(path: str) -> bool:
    """기록할 가치가 있는 경로인지.  True 면 RequestLog 에 한 줄 추가."""
    if not path:
        return False
    for pre in _SKIP_PREFIXES:
        if path.startswith(pre):
            return False
    return True


async def _persist(
    *,
    method: str,
    path: str,
    status_code: int,
    latency_ms: int,
    user_id: str | None,
    ip: str | None,
    user_agent: str | None,
) -> None:
    try:
        async with SessionLocal() as db:
            db.add(
                models.RequestLog(
                    method=(method or "")[:10],
                    path=path[:255],
                    status_code=int(status_code),
                    latency_ms=int(latency_ms),
                    user_id=user_id,
                    ip=ip[:64] if ip else None,
                    user_agent=user_agent[:255] if user_agent else None,
                )
            )
            await db.commit()
    except Exception as exc:  # noqa: BLE001 — 로깅 실패가 응답을 막으면 안 됨.
        _log.warning("request_log persist failed: %s", exc)


class RequestLogMiddleware(BaseHTTPMiddleware):
    """매 요청을 RequestLog 한 줄로."""

    async def dispatch(self, request: Request, call_next):
        path_raw = request.url.path
        if not filter_path(path_raw):
            return await call_next(request)
        t0 = time.monotonic()
        status = 500  # 예외 시 default
        try:
            response: Response = await call_next(request)
            status = response.status_code
            return response
        finally:
            elapsed_ms = int((time.monotonic() - t0) * 1000)
            # ASGI route pattern 우선 (그룹 통계용), 없으면 정규화한 path.
            route_path: str | None = None
            route = request.scope.get("route")
            if route is not None:
                route_path = getattr(route, "path", None)
            await _persist(
                method=request.method,
                path=route_path or _normalize_path(path_raw),
                status_code=status,
                latency_ms=elapsed_ms,
                user_id=_user_id_of(request),
                ip=_client_ip(request),
                user_agent=request.headers.get("user-agent"),
            )


async def cleanup_request_log() -> int:
    """오래된 RequestLog 행 일괄 삭제.  앱 부팅 시 한 번 호출하면 충분
    하지만 cron 으로 매일 돌리는 게 안전."""
    days = max(1, int(settings.request_log_retention_days or 7))
    cutoff = datetime.now(timezone.utc) - timedelta(days=days)
    try:
        async with SessionLocal() as db:
            res = await db.execute(
                delete(models.RequestLog).where(
                    models.RequestLog.created_at < cutoff
                )
            )
            await db.commit()
            return int(res.rowcount or 0)
    except Exception as exc:  # noqa: BLE001
        _log.warning("cleanup_request_log failed: %s", exc)
        return 0
