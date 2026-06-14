"""DuckDuckGo Instant Answer + HTML 백업 검색.

키 불필요·무료·rate limit 명시 없음 (보수적으로 쓰는 한). 한국어 검색
품질은 평이하지만 영문 / 사실 확인용으로 유용. 폐쇄망에서도 외부 망
접근이 열려 있으면 작동.

호출 두 가지를 시도:
  1. Instant Answer API (api.duckduckgo.com) — AbstractText / RelatedTopics
  2. HTML 검색 결과 파싱 (html.duckduckgo.com) — 위가 빈 경우만
"""
from __future__ import annotations

import html
import re

import httpx


class DuckDuckGoError(RuntimeError):
    pass


_TAG_RE = re.compile(r"<[^>]+>")
_TIMEOUT = httpx.Timeout(10.0, connect=5.0)


def _strip(text: str | None) -> str:
    if not text:
        return ""
    return html.unescape(_TAG_RE.sub("", text)).strip()


async def search(query: str, max_results: int = 8) -> list[dict]:
    if not query.strip():
        raise DuckDuckGoError("empty query")
    items: list[dict] = []

    # 1) Instant Answer
    async with httpx.AsyncClient(timeout=_TIMEOUT, follow_redirects=True) as client:
        try:
            resp = await client.get(
                "https://api.duckduckgo.com/",
                params={
                    "q": query,
                    "format": "json",
                    "no_redirect": "1",
                    "no_html": "1",
                    "skip_disambig": "1",
                },
            )
            if resp.status_code == 200:
                data = resp.json()
                # 메인 abstract.
                abstract = _strip(data.get("AbstractText"))
                if abstract:
                    items.append({
                        "kind": "web",
                        "source": "duckduckgo",
                        "title": _strip(data.get("Heading")) or query,
                        "link": data.get("AbstractURL") or "",
                        "snippet": abstract,
                    })
                # 관련 항목들.
                for r in (data.get("RelatedTopics") or [])[:max_results]:
                    if isinstance(r, dict) and r.get("Text"):
                        items.append({
                            "kind": "web",
                            "source": "duckduckgo",
                            "title": _strip(r.get("Text")).split(" - ")[0],
                            "link": r.get("FirstURL") or "",
                            "snippet": _strip(r.get("Text")),
                        })
        except (httpx.HTTPError, ValueError):
            # API 실패 — HTML 파싱 fallback 까지 만들지 않고 깨끗하게 빈 결과.
            pass

    return items[:max_results]
