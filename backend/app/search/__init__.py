"""Aggregated web search across all configured providers.

Currently fans out to Naver Open API (webkr + news + shop) and Google
Custom Search in parallel via asyncio.gather. Providers that aren't
configured (missing env vars) raise their own *SearchError, which the
aggregator records under `errors` instead of aborting — the rest of
the providers' hits are still returned. Only when no provider produced
any result does SearchError get raised to the caller.
"""
from __future__ import annotations

import asyncio

from .google import GoogleSearchError, search as _google_search
from .naver import NaverSearchError, search as _naver_search


class SearchError(RuntimeError):
    pass


async def search(query: str) -> dict:
    tasks = {
        "naver": asyncio.create_task(_naver_search(query)),
        "google": asyncio.create_task(_google_search(query)),
    }
    results = await asyncio.gather(*tasks.values(), return_exceptions=True)

    items: list[dict] = []
    errors: list[str] = []
    for name, outcome in zip(tasks.keys(), results, strict=True):
        if isinstance(outcome, BaseException):
            errors.append(f"{name}: {outcome}")
        else:
            items.extend(outcome.get("items") or [])
            errors.extend(outcome.get("errors") or [])

    if not items:
        raise SearchError("; ".join(errors) or "no search providers configured")
    return {"items": items, "errors": errors}


def format_as_context(result: dict) -> str:
    """Render the merged result list into a system-message block."""
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


__all__ = [
    "SearchError",
    "NaverSearchError",
    "GoogleSearchError",
    "search",
    "format_as_context",
]
