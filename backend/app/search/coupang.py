"""Coupang Partners OpenAPI shop search.

Requires affiliate partner approval from https://partners.coupang.com.
Once you have AccessKey + SecretKey, set COUPANG_ACCESS_KEY and
COUPANG_SECRET_KEY in .env.  Without both keys this module reports
itself disabled and the aggregator skips it.

Request requires a custom Authorization header with HMAC-SHA256 over
the signed-date + HTTP method + path + query string.  See:
https://partners.coupang.com/#fragment-2

Endpoint used:
    GET /v2/providers/affiliate_open_api/apis/openapi/v1/products/search
        ?keyword=<query>&limit=<n>

Returns JSON {"data": [{ productName, productPrice, productImage,
productUrl, categoryName, ... }]}.
"""
from __future__ import annotations

import datetime as _dt
import hashlib
import hmac

import httpx

from ..config import settings

_API_HOST = "https://api-gateway.coupang.com"
_PATH = "/v2/providers/affiliate_open_api/apis/openapi/v1/products/search"

# Coupang Partners API 는 정렬 파라미터를 직접 지원하지 않는 대신
# subId/limit/keyword 만 받는다.  asc/dsc 등은 클라이언트 측에서
# 정렬해야 함 — 그래서 호출 후 sort 인자에 따라 in-Python 정렬.


class CoupangError(RuntimeError):
    pass


def _signature(method: str, query: str, secret_key: str, access_key: str) -> tuple[str, str]:
    """Coupang HMAC 인증 헤더 생성.  반환: (auth_header, signed_date).
    signed_date 는 'YYMMDDTHHMMSSZ' (UTC, GMT) 형식.
    """
    now = _dt.datetime.now(_dt.timezone.utc).strftime("%y%m%dT%H%M%SZ")
    message = now + method + _PATH + query
    signature = hmac.new(
        bytes(secret_key, "utf-8"),
        msg=bytes(message, "utf-8"),
        digestmod=hashlib.sha256,
    ).hexdigest()
    auth = (
        f"CEA algorithm=HmacSHA256, access-key={access_key}, "
        f"signed-date={now}, signature={signature}"
    )
    return auth, now


def _sort_items(items: list[dict], sort: str) -> list[dict]:
    if sort == "asc":
        return sorted(items, key=lambda r: (r.get("lprice") or 10**12))
    if sort == "dsc":
        return sorted(items, key=lambda r: -(r.get("lprice") or 0))
    # date / sim: 응답 순서 그대로 — 쿠팡 인기/추천 순.
    return items


async def search_shop(
    query: str,
    *,
    display: int = 30,
    start: int = 1,
    sort: str = "sim",
) -> list[dict]:
    """쿠팡 상품 검색.  start 는 무시 (쿠팡 API 가 페이지 오프셋을
    공개하지 않음) — 호출자가 페이지를 넘기려면 limit 으로 가져온 뒤
    클라이언트 측에서 슬라이스 권장."""
    access = settings.coupang_access_key
    secret = settings.coupang_secret_key
    if not access or not secret:
        raise CoupangError("COUPANG_ACCESS_KEY / SECRET_KEY not configured")
    q = (query or "").strip()
    if not q:
        raise CoupangError("empty query")
    limit = max(1, min(int(display), 50))

    # Coupang API 는 query string 도 서명 대상이라 인코딩이 일치해야 함.
    # httpx 가 자체 인코딩 하기 전에 동일 문자열을 만들어 서명.
    from urllib.parse import urlencode

    params = {"keyword": q, "limit": limit}
    query_str = urlencode(params)
    auth, _ = _signature("GET", "?" + query_str, secret, access)
    url = f"{_API_HOST}{_PATH}?{query_str}"
    headers = {
        "Authorization": auth,
        "Content-Type": "application/json;charset=UTF-8",
    }
    timeout = httpx.Timeout(20.0, connect=5.0)
    async with httpx.AsyncClient(timeout=timeout) as client:
        resp = await client.get(url, headers=headers)
    if resp.status_code >= 400:
        raise CoupangError(
            f"Coupang {resp.status_code}: {resp.text[:200]}"
        )
    data = resp.json()
    if data.get("rCode") not in ("0", 0, None):
        msg = data.get("rMessage") or "unknown error"
        raise CoupangError(f"Coupang rCode={data.get('rCode')}: {msg}")

    out: list[dict] = []
    for item in data.get("data") or []:
        price = item.get("productPrice")
        if isinstance(price, str):
            price = price.replace(",", "")
            price = int(price) if price.isdigit() else None
        out.append(
            {
                "title": item.get("productName") or "",
                "link": item.get("productUrl") or "",
                "image": item.get("productImage") or "",
                "lprice": price,
                "hprice": price,
                "mall": "쿠팡",
                "brand": "",
                "category": item.get("categoryName") or "",
                "productId": str(item.get("productId") or ""),
                "productType": "rocket" if item.get("isRocket") else "",
                "source": "coupang",
            }
        )
    return _sort_items(out, sort)
