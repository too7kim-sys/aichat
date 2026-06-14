"""Wikipedia Search (한국어 + 영어) — 키 불필요·무료.

사실 확인용으로 LLM 답변의 hallucination 을 줄이는 데 효과적. 한국어
위키를 우선 시도하고 결과가 없으면 영어 위키 fallback.

MediaWiki REST API 사용:
  GET https://ko.wikipedia.org/w/rest.php/v1/search/page?q=...&limit=...
"""
from __future__ import annotations

import httpx


class WikipediaError(RuntimeError):
    pass


_TIMEOUT = httpx.Timeout(10.0, connect=5.0)


async def _query_lang(
    client: httpx.AsyncClient, lang: str, query: str, limit: int,
) -> list[dict]:
    url = f"https://{lang}.wikipedia.org/w/rest.php/v1/search/page"
    resp = await client.get(url, params={"q": query, "limit": limit})
    if resp.status_code >= 400:
        return []
    data = resp.json()
    out: list[dict] = []
    for p in data.get("pages") or []:
        title = (p.get("title") or "").strip()
        if not title:
            continue
        excerpt = (p.get("excerpt") or "").replace(
            "<span class=\"searchmatch\">", ""
        ).replace("</span>", "")
        # 한 문장으로 잘라낸 미리보기.
        out.append({
            "kind": "wiki",
            "source": f"wikipedia-{lang}",
            "title": title,
            "link": f"https://{lang}.wikipedia.org/wiki/" + title.replace(" ", "_"),
            "snippet": excerpt,
        })
    return out


async def search(query: str, max_results: int = 5) -> list[dict]:
    if not query.strip():
        raise WikipediaError("empty query")
    async with httpx.AsyncClient(
        timeout=_TIMEOUT,
        headers={"User-Agent": "aichat-bot/1.0 (closed-network deployment)"},
        follow_redirects=True,
    ) as client:
        # 한국어 우선
        items = await _query_lang(client, "ko", query, max_results)
        if not items:
            items = await _query_lang(client, "en", query, max_results)
        return items
