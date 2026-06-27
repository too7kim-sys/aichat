"""Helpers for writing rows into AuditLog."""
from __future__ import annotations

from fastapi import Request
from sqlalchemy.ext.asyncio import AsyncSession

from . import models

# Canonical event names — keep stable so log queries don't drift.
SIGNUP = "signup"
SIGNUP_FAIL = "signup_fail"
LOGIN_OK = "login_ok"
LOGIN_FAIL = "login_fail"
PASSWORD_CHANGE = "password_change"
NAME_CHANGE = "name_change"
ACCOUNT_DELETE = "account_delete"


def _client_ip(request: Request) -> str:
    # request.client.host 만 신뢰 — raw X-Forwarded-For 를 그대로 쓰면
    # 감사 로그의 IP 를 공격자가 위조할 수 있다 (헤더만 바꿔 추적 회피
    # /타인 IP 모함).  프록시 뒤에서는 uvicorn --proxy-headers 가
    # request.client.host 에 실제 IP 를 채운다.
    return (request.client.host if request.client else "")[:64]


def _ua(request: Request) -> str:
    return (request.headers.get("user-agent") or "")[:255]


async def record(
    db: AsyncSession,
    request: Request,
    event: str,
    *,
    user_id: str | None = None,
    detail: str = "",
) -> None:
    row = models.AuditLog(
        user_id=user_id,
        event=event,
        ip=_client_ip(request),
        user_agent=_ua(request),
        detail=detail[:255],
    )
    db.add(row)
    # Caller is expected to commit as part of its own transaction; we
    # only flush here so that a downstream HTTPException raised by the
    # caller still rolls back consistently.
    await db.flush()
