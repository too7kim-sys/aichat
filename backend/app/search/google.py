"""Google Custom Search JSON API client.

Free tier: 100 queries/day. Set up at
https://programmablesearchengine.google.com/ (enable "Search the entire
web") to get the cx ID, and create an API key at
https://console.cloud.google.com/ with the Custom Search API enabled.
"""
from __future__ import annotations

import html
import httpx

from ..config import settings

_URL = "https://www.googleapis.com/customsearch/v1"


class GoogleSearchError(RuntimeError):
    pass


async def search(query: str, num: int = 5) -> dict:
    """Return {items, errors}. Items use kind='google'."""
    if not settings.google_api_key or not settings.google_cse_id:
        raise GoogleSearchError(
            "GOOGLE_API_KEY / GOOGLE_CSE_ID not configured"
        )
    if not query.strip():
        raise GoogleSearchError("empty query")

    timeout = httpx.Timeout(15.0, connect=5.0)
    async with httpx.AsyncClient(timeout=timeout) as client:
        resp = await client.get(
            _URL,
            params={
                "key": settings.google_api_key,
                "cx": settings.google_cse_id,
                "q": query,
                "num": max(1, min(num, 10)),
                # Per-language / per-region biasing is left to the
                # Programmable Search Engine config (Search engine ->
                # Edit -> Language / Region) so English queries don't
                # get filtered to zero results here.
            },
        )
    if resp.status_code >= 400:
        raise GoogleSearchError(
            f"Google CSE {resp.status_code}: {resp.text[:300]}"
        )

    body = resp.json()
    items: list[dict] = []
    for item in body.get("items") or []:
        # CSE sometimes embeds a thumbnail in pagemap; pluck the first.
        pagemap = item.get("pagemap") or {}
        thumb_url = None
        for key in ("cse_thumbnail", "cse_image"):
            arr = pagemap.get(key)
            if arr:
                src = arr[0].get("src")
                if src:
                    thumb_url = src
                    break

        items.append(
            {
                "kind": "google",
                "title": html.unescape(item.get("title") or ""),
                "link": item.get("link") or "",
                "snippet": html.unescape(item.get("snippet") or ""),
                "image": thumb_url,
                "displayLink": item.get("displayLink") or "",
            }
        )
    return {"items": items, "errors": []}
