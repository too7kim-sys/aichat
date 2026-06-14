"""Multi-provider web search aggregator.

활성화된 모든 무료 검색 소스를 병렬 호출 → 결과 합치기. 각 소스의 키
유무 / .env 토글에 따라 자동 enable. 한 곳이 실패해도 나머지 결과는
유지 (best-effort).

지원:
  · Naver Open API   (NAVER_CLIENT_ID/SECRET): webkr + news + shop
  · Kakao Search     (KAKAO_REST_API_KEY): web + blog + cafe
  · DuckDuckGo       (키 불필요): instant answer + related topics
  · Wikipedia        (키 불필요): ko 우선, en fallback

추가 무료 쇼핑 소스 (현재 시점에 공식 API 무료 + REST 형태가 있는 곳)
는 Naver shop 외에는 거의 없으므로 그쪽은 Naver 가 단독 담당.
"""
from __future__ import annotations

import asyncio
import logging

from ..config import settings
from . import duckduckgo, kakao, naver, wikipedia

log = logging.getLogger("uvicorn.error")


class SearchError(RuntimeError):
    pass


# 외부 노출용 alias — 옛 import 경로 호환.
NaverSearchError = naver.NaverSearchError


async def search(query: str) -> dict:
    """모든 활성 소스 병렬 호출. 반환은 {items, errors, providers}.

    providers 는 어떤 소스가 활성/실패였는지 1줄 요약 — 운영 가시성용.
    """
    # 활성 여부 자동 감지 — .env 키가 비어 있으면 그 소스는 건너뜀.
    enabled = {
        "naver": bool(settings.naver_client_id and settings.naver_client_secret),
        "kakao": bool(settings.kakao_rest_api_key),
        # DuckDuckGo / Wikipedia 는 외부망에 도달만 가능하면 동작.
        # 명시적 토글로 끄고 싶으면 .env 에 false.
        "duckduckgo": settings.search_duckduckgo_enabled,
        "wikipedia": settings.search_wikipedia_enabled,
    }

    async def _run(name: str, coro):
        try:
            return name, await coro
        except Exception as exc:  # noqa: BLE001 - 한 소스 실패는 비치명
            return name, exc

    tasks = []
    if enabled["naver"]:
        tasks.append(_run("naver", naver.search(query)))
    if enabled["kakao"]:
        tasks.append(_run("kakao", kakao.search(query)))
    if enabled["duckduckgo"]:
        tasks.append(_run("duckduckgo", duckduckgo.search(query)))
    if enabled["wikipedia"]:
        tasks.append(_run("wikipedia", wikipedia.search(query)))

    if not tasks:
        raise SearchError(
            "활성화된 검색 소스가 없습니다. NAVER_CLIENT_* / KAKAO_REST_API_KEY "
            "/ SEARCH_DUCKDUCKGO_ENABLED / SEARCH_WIKIPEDIA_ENABLED 중 하나를 "
            "확인하세요."
        )

    results = await asyncio.gather(*tasks)

    items: list[dict] = []
    errors: list[str] = []
    providers_summary: list[str] = []
    for name, res in results:
        if isinstance(res, BaseException):
            errors.append(f"{name}: {res}")
            providers_summary.append(f"{name}=❌")
            continue
        # Naver 는 dict {items, errors} 반환, 나머지는 list 반환.
        if name == "naver":
            new_items = res.get("items") or []
            for sub_err in res.get("errors") or []:
                errors.append(f"naver: {sub_err}")
            # source 필드 채우기 (Naver 는 source 없이 kind 만 가짐).
            for it in new_items:
                it.setdefault("source", "naver")
        else:
            new_items = res or []
        items.extend(new_items)
        providers_summary.append(f"{name}={len(new_items)}")

    if not items and errors:
        raise SearchError("; ".join(errors))

    log.info(
        "search query=%r providers=%s total=%d",
        query[:60], " ".join(providers_summary), len(items),
    )
    return {"items": items, "errors": errors, "providers": providers_summary}


def format_as_context(result: dict) -> str:
    """결과 리스트를 한 system message 본문으로 렌더."""
    items = result.get("items") or []
    if not items:
        return "[Web search results]\n(no results)"
    # 같은 source 끼리 묶어서 가독성 ↑
    by_source: dict[str, list[dict]] = {}
    for it in items:
        by_source.setdefault(it.get("source") or "?", []).append(it)

    lines = ["[Web search results — 다중 소스]"]
    idx = 1
    for src, group in by_source.items():
        lines.append(f"\n── {src.upper()} ({len(group)}) ──")
        for item in group:
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
                lines.append(f"\n[{idx}] (shop) {title}\n{link}\n{extras}  {snippet}")
            else:
                lines.append(f"\n[{idx}] ({kind}) {title}\n{link}\n{snippet}")
            idx += 1
    return "\n".join(lines)


__all__ = ["SearchError", "NaverSearchError", "search", "format_as_context"]
