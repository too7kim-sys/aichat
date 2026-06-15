"""중앙 집중식 오류 캡처.

세 가지 경로로 ErrorLog 행이 쌓인다:

  1. ASGI 미들웨어 (ErrorLogMiddleware) — 핸들러 안에서 안 잡힌 모든
     예외 + 500 응답 캐치, traceback 포함해 기록.
  2. 로깅 핸들러 (DbLogHandler) — 코드가 logger.exception/error 로
     명시 기록한 항목.  uvicorn.error / app 모듈 logger 모두 흡수.
  3. 명시적 호출 — `log_error(db, ...)` 헬퍼로 비즈니스 로직 안에서
     "에러는 아니지만 사용자 시야에 띄울 가치가 있는 사건" 기록.

테이블이 너무 커지지 않게 init 시 오래된 행 삭제 (settings.error_log_
retention_days, 기본 30 일).
"""
from __future__ import annotations

import logging
import traceback
from datetime import datetime, timedelta
from typing import Any

from sqlalchemy import delete, select
from sqlalchemy.ext.asyncio import AsyncSession
from starlette.middleware.base import BaseHTTPMiddleware
from starlette.requests import Request
from starlette.responses import Response

from . import models
from .database import SessionLocal


_log = logging.getLogger("uvicorn.error")


async def _persist(
    *,
    level: str,
    source: str,
    message: str,
    traceback_str: str | None = None,
    path: str | None = None,
    method: str | None = None,
    status_code: int | None = None,
    user_id: str | None = None,
    ip: str | None = None,
    user_agent: str | None = None,
) -> None:
    """ErrorLog 한 줄 INSERT.  자체 실패는 stderr 로만 — 로그 저장
    실패가 다시 로그 저장을 시도하는 무한 루프를 막기 위함."""
    try:
        async with SessionLocal() as db:
            row = models.ErrorLog(
                level=(level or "ERROR")[:16],
                source=(source or "system")[:40],
                message=(message or "")[:1000],
                traceback=traceback_str,
                path=path[:255] if path else None,
                method=method[:10] if method else None,
                status_code=status_code,
                user_id=user_id,
                ip=ip[:64] if ip else None,
                user_agent=user_agent[:255] if user_agent else None,
            )
            db.add(row)
            await db.commit()
    except Exception as exc:  # noqa: BLE001 — 저장 실패는 stderr 로만.
        print(f"[error_log persist failed] {exc}", flush=True)


async def log_error(
    db: AsyncSession,
    *,
    source: str,
    message: str,
    level: str = "ERROR",
    traceback_str: str | None = None,
    user_id: str | None = None,
    extra: dict[str, Any] | None = None,
) -> None:
    """명시적 호출용 — 라우터 안에서 try/except 후 사용."""
    if extra:
        # extra 는 메시지 끝에 짧게 append.  너무 길면 truncate.
        suffix = " | ".join(f"{k}={v}" for k, v in extra.items())
        message = (message + " | " + suffix)[:1000]
    row = models.ErrorLog(
        level=(level or "ERROR")[:16],
        source=(source or "system")[:40],
        message=(message or "")[:1000],
        traceback=traceback_str,
        user_id=user_id,
    )
    db.add(row)
    # commit 은 호출자가 자기 세션 트랜잭션과 같이 묶도록.  명시 호출 시
    # 이미 다른 작업과 같은 트랜잭션 안일 가능성이 높아 여기서 commit
    # 하면 의도치 않은 부수효과가 생김.


class ErrorLogMiddleware(BaseHTTPMiddleware):
    """모든 ASGI 요청을 감싸 예외 / 5xx 상태를 기록.

    스트리밍 응답(SSE) 도 status_code 만 보면 200 인데 그 안에서 에러가
    스트림으로 흘러갈 수 있어 미들웨어로 잡기 어렵다 — 채팅 라우터가
    log_error 헬퍼로 직접 기록할 것.
    """

    async def dispatch(self, request: Request, call_next):
        try:
            response: Response = await call_next(request)
        except Exception as exc:  # noqa: BLE001
            tb = traceback.format_exc()
            await _persist(
                level="EXCEPTION",
                source="middleware",
                message=f"{type(exc).__name__}: {exc}",
                traceback_str=tb,
                path=request.url.path,
                method=request.method,
                status_code=500,
                user_id=_user_id_of(request),
                ip=_client_ip(request),
                user_agent=request.headers.get("user-agent"),
            )
            raise
        # 5xx 는 모두 기록 — HTTPException 으로 raise 한 422 같은 4xx 는
        # 보통 사용자 입력 실수라 SKIP (감사 로그가 따로 있음).  413 처럼
        # 운영자가 자주 봐야 하는 4xx 만 골라서 기록.
        if response.status_code >= 500:
            await _persist(
                level="ERROR",
                source="http",
                message=f"HTTP {response.status_code} on {request.method} {request.url.path}",
                path=request.url.path,
                method=request.method,
                status_code=response.status_code,
                user_id=_user_id_of(request),
                ip=_client_ip(request),
                user_agent=request.headers.get("user-agent"),
            )
        elif response.status_code in (413, 429):
            await _persist(
                level="WARNING",
                source="http",
                message=f"HTTP {response.status_code} on {request.method} {request.url.path}",
                path=request.url.path,
                method=request.method,
                status_code=response.status_code,
                user_id=_user_id_of(request),
                ip=_client_ip(request),
                user_agent=request.headers.get("user-agent"),
            )
        return response


def _client_ip(request: Request) -> str | None:
    # X-Forwarded-For 가 있으면 첫 hop, 없으면 직결 IP.
    xff = request.headers.get("x-forwarded-for")
    if xff:
        return xff.split(",")[0].strip()
    return request.client.host if request.client else None


def _user_id_of(request: Request) -> str | None:
    # 인증된 요청은 미들웨어 단계에선 아직 user 가 부착되어 있지 않을
    # 가능성이 있지만, FastAPI Depends 가 채워두면 state 에 있을 수도.
    user = getattr(request.state, "user", None)
    if user is not None:
        return getattr(user, "id", None)
    return None


class DbLogHandler(logging.Handler):
    """logger.error / logger.exception 호출을 DB 에 미러링.  uvicorn
    의 'uvicorn.error' 로거 + 앱 모듈 로거 모두 흡수해, 코드가 명시한
    오류도 한 곳에 모인다."""

    def emit(self, record: logging.LogRecord) -> None:
        # 자체 모듈에서 발생한 로그는 재귀 방지로 무시.
        if record.name.startswith("aichat.error_log"):
            return
        # ERROR / WARNING / CRITICAL 만 잡음.  uvicorn 의 access 로그를
        # 다 떠 안으면 DB 가 폭주.
        if record.levelno < logging.WARNING:
            return
        try:
            msg = record.getMessage()
        except Exception:  # noqa: BLE001 — 메시지 포맷팅 실패
            msg = record.msg if isinstance(record.msg, str) else str(record.msg)

        tb_str: str | None = None
        if record.exc_info:
            tb_str = "".join(traceback.format_exception(*record.exc_info))

        # asyncio 안에서 호출되는 일이 잦아 fire-and-forget.
        import asyncio

        coro = _persist(
            level=record.levelname,
            source=record.name.split(".")[0][:40] or "logger",
            message=msg,
            traceback_str=tb_str,
        )
        try:
            loop = asyncio.get_event_loop()
            if loop.is_running():
                loop.create_task(coro)
            else:
                loop.run_until_complete(coro)
        except RuntimeError:
            # 이벤트 루프가 없는 컨텍스트 (예: pytest 동기 호출) — 무시.
            pass


def install_db_log_handler() -> None:
    """앱 시작 시 한 번 호출.  uvicorn.error + 루트 로거에 부착."""
    handler = DbLogHandler()
    handler.setLevel(logging.WARNING)
    formatter = logging.Formatter("%(name)s: %(message)s")
    handler.setFormatter(formatter)
    logging.getLogger("uvicorn.error").addHandler(handler)
    # 루트에도 — 앱 모듈들이 자체 logger 를 만들 때를 대비.
    logging.getLogger().addHandler(handler)


async def prune_old(retention_days: int = 30) -> int:
    """오래된 로그 행 삭제.  반환: 지운 행 수."""
    cutoff = datetime.utcnow() - timedelta(days=max(1, retention_days))
    async with SessionLocal() as db:
        result = await db.execute(
            delete(models.ErrorLog).where(models.ErrorLog.created_at < cutoff)
        )
        await db.commit()
        return result.rowcount or 0


async def recent(limit: int = 100) -> list[dict]:
    """최근 ErrorLog limit 개 반환 (관리자 패널용)."""
    limit = max(1, min(int(limit), 500))
    async with SessionLocal() as db:
        rows = (
            await db.execute(
                select(models.ErrorLog)
                .order_by(models.ErrorLog.created_at.desc())
                .limit(limit)
            )
        ).scalars().all()
        # user_id → email 매핑.
        user_ids = {r.user_id for r in rows if r.user_id}
        email_of: dict[str, str] = {}
        if user_ids:
            urows = (
                await db.execute(
                    select(models.User.id, models.User.email).where(
                        models.User.id.in_(user_ids)
                    )
                )
            ).all()
            email_of = {uid: em for (uid, em) in urows}
        return [
            {
                "id": r.id,
                "level": r.level,
                "source": r.source,
                "message": r.message,
                "traceback": r.traceback,
                "path": r.path,
                "method": r.method,
                "status_code": r.status_code,
                "user_email": email_of.get(r.user_id) if r.user_id else None,
                "ip": r.ip,
                "created_at": r.created_at.isoformat() if r.created_at else None,
            }
            for r in rows
        ]
