"""Kakao Developers Search REST API.

무료 일 300,000 회 (앱당). 한국어 검색 품질이 네이버와 다르게 카카오/
다음 인덱스를 노출 — 두 결과를 같이 쓰면 누락이 줄어든다.

키 발급: https://developers.kakao.com → 내 애플리케이션 → 추가
       → 앱 설정 → "REST API 키" 복사 → .env KAKAO_REST_API_KEY.

엔드포인트 셋을 병렬 호출:
  · /v2/search/web   — 일반 웹 결과
  · /v2/search/blog  — 다음 블로그·티스토리 (사내 정보 풍부)
  · /v2/search/cafe  — 카페/커뮤니티 (잡지식·후기)
"""
from __future__ import annotations

import asyncio
import html
import re

import httpx

from ..config import settings


class KakaoSearchError(RuntimeError):
    pass


_API_BASE = "https://dapi.kakao.com/v2/search"
_TAG_RE = re.compile(r"<[^>]+>")
_TIMEOUT = httpx.Timeout(20.0, connect=5.0)


def _strip(text: str | None) -> str:
    if not text:
        return ""
    return html.unescape(_TAG_RE.sub("", text)).strip()


async def _call(
    client: httpx.AsyncClient, kind: str, query: str, size: int,
) -> dict:
    headers = {"Authorization": f"KakaoAK {settings.kakao_rest_api_key}"}
    resp = await client.get(
        f"{_API_BASE}/{kind}",
        headers=headers,
        params={"query": query, "size": size, "sort": "accuracy"},
    )
    if resp.status_code >= 400:
        raise KakaoSearchError(
            f"Kakao {kind} {resp.status_code}: {resp.text[:300]}"
        )
    return resp.json()


async def search(query: str, per_endpoint: int = 5) -> list[dict]:
    if not settings.kakao_rest_api_key:
        raise KakaoSearchError("KAKAO_REST_API_KEY not configured")
    if not query.strip():
        raise KakaoSearchError("empty query")

    async with httpx.AsyncClient(timeout=_TIMEOUT) as client:
        web, blog, cafe = await asyncio.gather(
            _call(client, "web", query, per_endpoint),
            _call(client, "blog", query, per_endpoint),
            _call(client, "cafe", query, per_endpoint),
            return_exceptions=True,
        )

    items: list[dict] = []
    if not isinstance(web, BaseException):
        for it in web.get("documents") or []:
            items.append({
                "kind": "web",
                "source": "kakao",
                "title": _strip(it.get("title")),
                "link": it.get("url") or "",
                "snippet": _strip(it.get("contents")),
            })
    if not isinstance(blog, BaseException):
        for it in blog.get("documents") or []:
            items.append({
                "kind": "blog",
                "source": "kakao",
                "title": _strip(it.get("title")),
                "link": it.get("url") or "",
                "snippet": _strip(it.get("contents")),
                "pubDate": it.get("datetime"),
            })
    if not isinstance(cafe, BaseException):
        for it in cafe.get("documents") or []:
            items.append({
                "kind": "cafe",
                "source": "kakao",
                "title": _strip(it.get("title")),
                "link": it.get("url") or "",
                "snippet": _strip(it.get("contents")),
                "pubDate": it.get("datetime"),
            })
    return items
