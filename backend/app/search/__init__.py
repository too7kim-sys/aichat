"""Web search wrapper around the Naver Open API.

Wraps naver.search/format_as_context with a generic name so chat.py
doesn't have to know which provider is in use; this also keeps the
surface ready for future providers via the aggregator pattern.
"""
from __future__ import annotations

import logging

from .naver import NaverSearchError, search as _naver_search

log = logging.getLogger("uvicorn.error")


class SearchError(RuntimeError):
    pass


async def search(query: str) -> dict:
    try:
        result = await _naver_search(query)
    except NaverSearchError as exc:
        raise SearchError(f"naver: {exc}") from exc
    log.info(
        "search query=%r results=%d",
        query[:60],
        len(result.get("items") or []),
    )
    return result


def format_as_context(result: dict) -> str:
    """Render the result list into a system-message block."""
    lines = ["[Web search results]"]
    for i, item in enumerate(result.get("items") or [], start=1):
        kind = item.get("kind") or "web"
        title = item.get("title") or "(no title)"
        link = item.get("link") or ""
        snippet = item.get("snippet") or ""
        if len(snippet) > 400:
            snippet = snippet[:400] + "..."
        if kind == "shop":
            mall = item.get("mall") or ""
            lprice = item.get("lprice")
            price_str = f"{lprice:,}원" if lprice else "가격정보 없음"
            extras = f"[{mall}] {price_str}".strip()
            lines.append(f"\n[{i}] (shop) {title}\n{link}\n{extras}  {snippet}")
        else:
            lines.append(f"\n[{i}] ({kind}) {title}\n{link}\n{snippet}")
    return "\n".join(lines)


__all__ = ["SearchError", "NaverSearchError", "search", "format_as_context"]
