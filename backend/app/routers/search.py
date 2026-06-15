"""Global chat search — single endpoint that scans every message the
caller owns and returns short snippets the UI can render in a result
list. Matches against both message content and the attachment summary
column so a user can find "where did I attach quarterly-report.pdf"
in addition to plain text lookups.

Scope is the requesting user's sessions only — the join on
`sessions.user_id` prevents cross-tenant disclosure.
"""
from datetime import datetime
from typing import Awaitable, Callable, Literal

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel
from sqlalchemy import or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from .. import models
from ..auth import get_current_user
from ..config import settings
from ..database import get_db
from ..search import coupang as coupang_search
from ..search import eleven_st as eleven_search
from ..search import naver as naver_search

router = APIRouter(prefix="/api/search", tags=["search"])


class MessageSearchResult(BaseModel):
    message_id: str
    session_id: str
    session_title: str
    role: Literal["user", "assistant"]
    snippet: str
    # Where the query actually matched on the row. "attachment" means
    # the body didn't contain the query but the attachments_summary
    # JSON column did — i.e., the user is searching for a filename.
    # Lets the frontend group results into a "첨부 파일" section.
    match_in: Literal["content", "attachment"]
    created_at: datetime


def _make_snippet(content: str, query: str, width: int = 140) -> str:
    """Return a short window of `content` centred on the first match
    of `query` (case-insensitive). Adds leading/trailing ellipses
    when the window doesn't cover the whole string."""
    if not content:
        return ""
    if not query:
        return content[:width] + ("…" if len(content) > width else "")
    idx = content.lower().find(query.lower())
    if idx < 0:
        # Match was probably in attachments_summary, not the body —
        # surface the first slice of body so the row still has
        # context to render.
        return content[:width] + ("…" if len(content) > width else "")
    pad_left = 50
    pad_right = width - pad_left - len(query)
    if pad_right < 0:
        pad_right = 0
    start = max(0, idx - pad_left)
    end = min(len(content), idx + len(query) + pad_right)
    return (
        ("…" if start > 0 else "")
        + content[start:end]
        + ("…" if end < len(content) else "")
    )


@router.get("/messages", response_model=list[MessageSearchResult])
async def search_messages(
    q: str = "",
    limit: int = 50,
    user: models.User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    query = (q or "").strip()
    # Two-character floor stops trivial "a" / single-char queries from
    # walking the full message table on every keystroke.
    if len(query) < 2:
        return []
    if limit < 1:
        limit = 50
    if limit > 200:
        limit = 200
    like = f"%{query}%"
    stmt = (
        select(models.Message, models.Session.title)
        .join(models.Session, models.Session.id == models.Message.session_id)
        .where(models.Session.user_id == user.id)
        .where(
            or_(
                models.Message.content.ilike(like),
                models.Message.attachments_summary.ilike(like),
            )
        )
        .order_by(models.Message.created_at.desc())
        .limit(limit)
    )
    rows = (await db.execute(stmt)).all()
    qlow = query.lower()
    out: list[MessageSearchResult] = []
    for m, title in rows:
        body_match = qlow in (m.content or "").lower()
        out.append(
            MessageSearchResult(
                message_id=m.id,
                session_id=m.session_id,
                session_title=(title or "(제목 없음)"),
                role=m.role if m.role in ("user", "assistant") else "user",
                snippet=_make_snippet(m.content or "", query),
                match_in="content" if body_match else "attachment",
                created_at=m.created_at,
            )
        )
    return out


class ShopItem(BaseModel):
    title: str
    link: str
    image: str
    lprice: int | None = None
    hprice: int | None = None
    mall: str
    brand: str = ""
    category: str = ""
    productId: str = ""
    # 어느 OpenAPI 에서 왔는지 — naver / eleven_st / coupang.
    source: str = "naver"


class ProviderStatus(BaseModel):
    name: str
    enabled: bool
    count: int = 0
    error: str | None = None


class ShopResponse(BaseModel):
    items: list[ShopItem]
    sort: Literal["sim", "date", "asc", "dsc"]
    query: str
    providers: list[ProviderStatus]


def _aggregator_sort(items: list[dict], sort: str) -> list[dict]:
    if sort == "asc":
        return sorted(items, key=lambda r: (r.get("lprice") or 10**12))
    if sort == "dsc":
        return sorted(items, key=lambda r: -(r.get("lprice") or 0))
    # sim / date 는 각 provider 내부 순서를 살리면서 round-robin 으로
    # 섞어 한쪽 결과가 전부 위에 몰리지 않게 함.
    if sort in ("sim", "date"):
        buckets: dict[str, list[dict]] = {}
        for it in items:
            buckets.setdefault(it.get("source") or "?", []).append(it)
        out: list[dict] = []
        while any(buckets.values()):
            for k in list(buckets.keys()):
                if buckets[k]:
                    out.append(buckets[k].pop(0))
        return out
    return items


@router.get("/shop", response_model=ShopResponse)
async def search_shop(
    q: str = Query("", description="검색어"),
    sort: Literal["sim", "date", "asc", "dsc"] = Query(
        "sim", description="sim=정확도, date=최신, asc=낮은가격, dsc=높은가격"
    ),
    display: int = Query(30, ge=1, le=100, description="provider 당 결과 개수"),
    start: int = Query(1, ge=1, le=1000, description="페이지 시작 위치 (1~1000)"),
    mall: str = Query("", description="쇼핑몰 이름 필터 (부분일치, 대소문자 무시)"),
    sources: str = Query(
        "all",
        description="쉼표 구분 provider 목록. all=설정된 모든 곳. "
        "naver / eleven_st / coupang 중에서 선택.",
    ),
    _user: models.User = Depends(get_current_user),
):
    """쇼핑 검색 — Naver / 11번가 / 쿠팡 OpenAPI 를 병렬 호출, 결과
    합치기. 각 provider 의 키가 .env 에 있을 때만 활성. 모두 비활성
    이거나 모두 실패하면 503.
    """
    import asyncio

    query = (q or "").strip()
    if len(query) < 2:
        return ShopResponse(items=[], sort=sort, query=query, providers=[])

    requested = {s.strip().lower() for s in sources.split(",") if s.strip()}
    if "all" in requested or not requested:
        requested = {"naver", "eleven_st", "coupang"}

    # 각 provider 의 활성 여부 — 키가 .env 에 있어야 호출.
    ShopFn = Callable[..., Awaitable[list[dict]]]
    plan: list[tuple[str, ShopFn, bool]] = [
        (
            "naver",
            naver_search.search_shop,
            bool(settings.naver_client_id and settings.naver_client_secret),
        ),
        (
            "eleven_st",
            eleven_search.search_shop,
            bool(settings.eleven_st_partner_key),
        ),
        (
            "coupang",
            coupang_search.search_shop,
            bool(settings.coupang_access_key and settings.coupang_secret_key),
        ),
    ]

    async def _call(name: str, fn) -> tuple[str, list[dict] | BaseException]:
        try:
            return name, await fn(query, display=display, start=start, sort=sort)
        except Exception as exc:  # noqa: BLE001
            return name, exc

    tasks = [
        _call(name, fn)
        for name, fn, ok in plan
        if ok and name in requested
    ]

    providers: list[ProviderStatus] = [
        ProviderStatus(name=name, enabled=ok)
        for name, _, ok in plan
        if name in requested
    ]
    if not tasks:
        raise HTTPException(
            status_code=503,
            detail=(
                "활성화된 쇼핑 provider 가 없습니다 — .env 에 "
                "NAVER_CLIENT_ID/SECRET, ELEVEN_ST_PARTNER_KEY, "
                "COUPANG_ACCESS_KEY/SECRET_KEY 중 하나 이상을 설정해 주세요."
            ),
        )

    results = await asyncio.gather(*tasks)

    merged: list[dict] = []
    success = 0
    for name, res in results:
        slot = next((p for p in providers if p.name == name), None)
        if isinstance(res, BaseException):
            if slot:
                slot.error = f"{type(res).__name__}: {res}"
            continue
        success += 1
        for r in res:
            r.setdefault("source", name)
        merged.extend(res)
        if slot:
            slot.count = len(res)

    if success == 0:
        # 모든 provider 가 실패 — 가장 구체적인 에러를 503 으로 노출.
        errs = "; ".join(
            f"{p.name}={p.error}" for p in providers if p.error
        ) or "unknown"
        raise HTTPException(status_code=503, detail=f"쇼핑 검색 실패: {errs}")

    mall_q = mall.strip().lower()
    if mall_q:
        merged = [
            r for r in merged if mall_q in (r.get("mall") or "").lower()
        ]
    merged = _aggregator_sort(merged, sort)
    items = [ShopItem(**r) for r in merged]
    return ShopResponse(items=items, sort=sort, query=query, providers=providers)
