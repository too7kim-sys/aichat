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
