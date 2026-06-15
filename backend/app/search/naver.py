"""Naver Search Open API client.

Free tier: 25,000 calls/day per Application. webkr + news are issued in
parallel for each query, merged into a single result list. HTML tags
(<b>...</b>) and entities in Naver's snippets are stripped so the
LLM gets clean text.

Register an app at https://developers.naver.com/ and put the issued
Client ID / Secret into NAVER_CLIENT_ID / NAVER_CLIENT_SECRET.
"""
from __future__ import annotations

import asyncio
import html
import re

import httpx

from ..config import settings

_API_BASE = "https://openapi.naver.com/v1/search"
_TAG_RE = re.compile(r"<[^>]+>")


class NaverSearchError(RuntimeError):
    pass


def _strip(text: str | None) -> str:
    if not text:
        return ""
    return html.unescape(_TAG_RE.sub("", text)).strip()


async def _call(
    client: httpx.AsyncClient, kind: str, query: str, display: int
) -> dict:
    url = f"{_API_BASE}/{kind}.json"
    headers = {
        "X-Naver-Client-Id": settings.naver_client_id,
        "X-Naver-Client-Secret": settings.naver_client_secret,
    }
    resp = await client.get(
        url,
        headers=headers,
        params={"query": query, "display": display, "sort": "sim"},
    )
    if resp.status_code >= 400:
        raise NaverSearchError(
            f"Naver {kind} {resp.status_code}: {resp.text[:300]}"
        )
    return resp.json()


async def search(query: str, per_endpoint: int = 5) -> dict:
    """Return {items, errors}. items merges webkr + news + shop with `kind`."""
    if not settings.naver_client_id or not settings.naver_client_secret:
        raise NaverSearchError(
            "NAVER_CLIENT_ID / NAVER_CLIENT_SECRET not configured"
        )
    if not query.strip():
        raise NaverSearchError("empty query")

    timeout = httpx.Timeout(20.0, connect=5.0)
    async with httpx.AsyncClient(timeout=timeout) as client:
        webkr, news, shop = await asyncio.gather(
            _call(client, "webkr", query, per_endpoint),
            _call(client, "news", query, per_endpoint),
            _call(client, "shop", query, per_endpoint),
            return_exceptions=True,
        )

    items: list[dict] = []
    errors: list[str] = []

    if isinstance(webkr, BaseException):
        errors.append(f"webkr: {webkr}")
    else:
        for item in webkr.get("items") or []:
            items.append(
                {
                    "kind": "web",
                    "title": _strip(item.get("title")),
                    "link": item.get("link") or "",
                    "snippet": _strip(item.get("description")),
                }
            )

    if isinstance(news, BaseException):
        errors.append(f"news: {news}")
    else:
        for item in news.get("items") or []:
            items.append(
                {
                    "kind": "news",
                    "title": _strip(item.get("title")),
                    "link": item.get("link") or item.get("originallink") or "",
                    "snippet": _strip(item.get("description")),
                    "pubDate": item.get("pubDate"),
                }
            )

    if isinstance(shop, BaseException):
        errors.append(f"shop: {shop}")
    else:
        for item in shop.get("items") or []:
            lprice = item.get("lprice") or ""
            hprice = item.get("hprice") or ""
            items.append(
                {
                    "kind": "shop",
                    "title": _strip(item.get("title")),
                    "link": item.get("link") or "",
                    "snippet": _strip(item.get("category4") or item.get("category3") or ""),
                    "image": item.get("image") or "",
                    "lprice": int(lprice) if lprice.isdigit() else None,
                    "hprice": int(hprice) if hprice.isdigit() else None,
                    "mall": item.get("mallName") or "",
                    "brand": item.get("brand") or "",
                }
            )

    if not items and errors:
        # All endpoints failed — bubble up so the caller can surface the
        # reason instead of silently sending an empty context.
        raise NaverSearchError("; ".join(errors))
    return {"items": items, "errors": errors}


async def search_shop(
    query: str,
    *,
    display: int = 30,
    start: int = 1,
    sort: str = "sim",
) -> list[dict]:
    """쇼핑 전용 단일 호출 — 쇼핑 브라우저 모달용. sort 값:
    sim (정확도), date (최신), asc (낮은가격), dsc (높은가격).

    /v1/search/shop.json 응답을 그대로 가공해 가격·이미지·몰명 등
    구조화 dict 리스트로 반환. 빈 결과면 빈 리스트.
    """
    if not settings.naver_client_id or not settings.naver_client_secret:
        raise NaverSearchError(
            "NAVER_CLIENT_ID / NAVER_CLIENT_SECRET not configured"
        )
    if not query.strip():
        raise NaverSearchError("empty query")
    if sort not in {"sim", "date", "asc", "dsc"}:
        sort = "sim"
    # Naver shop 한도: display 100, start ≤ 1000.
    display = max(1, min(int(display), 100))
    start = max(1, min(int(start), 1000))
    url = f"{_API_BASE}/shop.json"
    headers = {
        "X-Naver-Client-Id": settings.naver_client_id,
        "X-Naver-Client-Secret": settings.naver_client_secret,
    }
    timeout = httpx.Timeout(20.0, connect=5.0)
    async with httpx.AsyncClient(timeout=timeout) as client:
        resp = await client.get(
            url,
            headers=headers,
            params={
                "query": query,
                "display": display,
                "start": start,
                "sort": sort,
            },
        )
    if resp.status_code >= 400:
        raise NaverSearchError(
            f"Naver shop {resp.status_code}: {resp.text[:300]}"
        )
    data = resp.json()
    out: list[dict] = []
    for item in data.get("items") or []:
        lprice = str(item.get("lprice") or "")
        hprice = str(item.get("hprice") or "")
        out.append(
            {
                "title": _strip(item.get("title")),
                "link": item.get("link") or "",
                "image": item.get("image") or "",
                "lprice": int(lprice) if lprice.isdigit() else None,
                "hprice": int(hprice) if hprice.isdigit() else None,
                "mall": item.get("mallName") or "",
                "brand": item.get("brand") or "",
                "category": " > ".join(
                    [
                        c
                        for c in (
                            item.get("category1"),
                            item.get("category2"),
                            item.get("category3"),
                            item.get("category4"),
                        )
                        if c
                    ]
                ),
                "productId": item.get("productId") or "",
                "productType": item.get("productType") or "",
            }
        )
    return out
