"""Tavily web search client.

Tavily is an LLM-oriented search API: results come pre-summarized and ready
to inject as context. https://docs.tavily.com/
"""
from __future__ import annotations

import httpx

from ..config import settings

_ENDPOINT = "https://api.tavily.com/search"


class TavilyError(RuntimeError):
    pass


async def search(
    query: str, max_results: int = 5, include_answer: bool = True
) -> dict:
    """Call Tavily and return the raw response dict.

    Raises TavilyError if the key is missing or the API rejects the call.
    """
    api_key = settings.tavily_api_key
    if not api_key:
        raise TavilyError("TAVILY_API_KEY not configured")

    payload = {
        "api_key": api_key,
        "query": query,
        "max_results": max_results,
        "include_answer": include_answer,
        "search_depth": "basic",
    }
    async with httpx.AsyncClient(timeout=httpx.Timeout(20.0, connect=5.0)) as client:
        resp = await client.post(_ENDPOINT, json=payload)
        if resp.status_code >= 400:
            raise TavilyError(f"Tavily {resp.status_code}: {resp.text[:300]}")
        return resp.json()


def format_as_context(result: dict) -> str:
    """Render Tavily response into a system-message friendly block."""
    lines: list[str] = ["[Web search results]"]
    answer = result.get("answer")
    if answer:
        lines.append(f"Summary: {answer}")
    for i, item in enumerate(result.get("results") or [], start=1):
        title = item.get("title") or "(no title)"
        url = item.get("url") or ""
        content = (item.get("content") or "").strip()
        if len(content) > 500:
            content = content[:500] + "..."
        lines.append(f"\n[{i}] {title}\n{url}\n{content}")
    return "\n".join(lines)
