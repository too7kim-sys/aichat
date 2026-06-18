"""In-process per-IP rate limiter for auth endpoints.

Token-bucket style sliding window — adequate for a single-instance dev
deployment. For multi-worker / horizontal scale a Redis-backed limiter
(slowapi + redis) would be the next step.
"""
from __future__ import annotations

import time
from collections import deque

from fastapi import HTTPException, Request

# scope -> ip -> deque[timestamp]
_buckets: dict[str, dict[str, deque[float]]] = {}

# 계정-당 로그인 실패 누적 — IP 기반 rate limit 보다 강한 잠금.  이메일을
# key 로 5회 실패가 쌓이면 5분 동안 423 Locked 응답.  성공 시 즉시 해제.
_LOCKOUT_MAX_FAILS = 5
_LOCKOUT_WINDOW = 15 * 60       # 15분 안에 5회면
_LOCKOUT_DURATION = 5 * 60      # 5분 잠금
_login_fails: dict[str, deque[float]] = {}
_locked_until: dict[str, float] = {}


def _client_ip(request: Request) -> str:
    # Prefer X-Forwarded-For first hop when behind a reverse proxy; falls
    # back to the direct peer.
    fwd = request.headers.get("x-forwarded-for")
    if fwd:
        return fwd.split(",", 1)[0].strip()
    return request.client.host if request.client else "anonymous"


def enforce_rate_limit(
    scope: str, request: Request, *, limit: int, window_seconds: int
) -> None:
    """Raise HTTPException(429) if the given client IP exceeds `limit`
    requests in the most recent `window_seconds`."""
    ip = _client_ip(request)
    bucket = _buckets.setdefault(scope, {}).setdefault(ip, deque())
    now = time.monotonic()
    cutoff = now - window_seconds
    while bucket and bucket[0] < cutoff:
        bucket.popleft()
    if len(bucket) >= limit:
        retry = int(window_seconds - (now - bucket[0])) + 1
        raise HTTPException(
            429,
            detail=f"요청이 너무 잦습니다. {retry}초 후 다시 시도해 주세요.",
            headers={"Retry-After": str(retry)},
        )
    bucket.append(now)


def check_account_lockout(email: str) -> None:
    """이메일이 현재 잠금 상태이면 423 Locked 발생.  성공/실패 기록 전에
    먼저 호출해서 잠긴 계정에 추가 시도를 못하게 막는다."""
    if not email:
        return
    key = email.lower()
    now = time.monotonic()
    until = _locked_until.get(key, 0.0)
    if until > now:
        retry = int(until - now) + 1
        raise HTTPException(
            423,
            detail=(
                f"로그인 실패가 잦아 계정이 일시 잠겼습니다. "
                f"{retry//60}분 {retry%60}초 후 다시 시도해 주세요."
            ),
            headers={"Retry-After": str(retry)},
        )


def record_login_failure(email: str) -> None:
    """이메일 단위로 실패 횟수를 늘리고, 임계치에 도달하면 잠근다."""
    if not email:
        return
    key = email.lower()
    now = time.monotonic()
    bucket = _login_fails.setdefault(key, deque())
    cutoff = now - _LOCKOUT_WINDOW
    while bucket and bucket[0] < cutoff:
        bucket.popleft()
    bucket.append(now)
    if len(bucket) >= _LOCKOUT_MAX_FAILS:
        _locked_until[key] = now + _LOCKOUT_DURATION
        bucket.clear()  # 잠금 후엔 버킷을 비워 다음 라운드를 새로 시작.


def reset_login_failures(email: str) -> None:
    """로그인 성공 / 비밀번호 재설정 후 잠금 상태를 즉시 해제."""
    if not email:
        return
    key = email.lower()
    _login_fails.pop(key, None)
    _locked_until.pop(key, None)
