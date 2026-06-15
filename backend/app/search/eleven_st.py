"""11번가 OpenAPI shop search.

Free, requires a partner key from https://openapi.11st.co.kr.
The endpoint returns XML; we parse out the fields the chat UI cares
about (image, price, mall name, link) and surface them in the same
shape as Naver shop items so the aggregator can mix freely.

Pricing reference (2024~):
    GET http://openapi.11st.co.kr/openapi/OpenApiService.tmall
        ?key=<PARTNER_KEY>
        &apiCode=ProductSearch
        &keyword=<query>
        &pageNum=1
        &pageSize=20
        &sortCd=CP   (CP=인기, SP=판매많은, NP=최신, LP=낮은가격, HP=높은가격)

API response is XML with <Product> elements containing
ProductName, ProductPrice, ProductImage300, BuyUrl, SellerNick, etc.
"""
from __future__ import annotations

import html
import re
import xml.etree.ElementTree as ET

import httpx

from ..config import settings

_API_URL = "http://openapi.11st.co.kr/openapi/OpenApiService.tmall"

# Naver sort 코드와 1:1 매핑.  asc=낮은가격→LP, dsc=높은가격→HP,
# date=최신→NP, sim=정확도→CP (인기).  표준 매핑이 다른 면이 있으니
# 호출자가 그대로 넘기지 않고 한 번 변환.
_SORT_MAP = {
    "sim": "CP",
    "date": "NP",
    "asc": "LP",
    "dsc": "HP",
}

_HTML_TAG_RE = re.compile(r"<[^>]+>")


class ElevenStError(RuntimeError):
    pass


def _strip(text: str | None) -> str:
    if not text:
        return ""
    return html.unescape(_HTML_TAG_RE.sub("", text)).strip()


def _text(el: ET.Element | None, default: str = "") -> str:
    if el is None or el.text is None:
        return default
    return el.text.strip()


def _int_or_none(s: str) -> int | None:
    s = (s or "").strip().replace(",", "")
    return int(s) if s.isdigit() else None


async def search_shop(
    query: str,
    *,
    display: int = 30,
    start: int = 1,
    sort: str = "sim",
) -> list[dict]:
    """11번가 상품 검색.  결과를 Naver 와 같은 dict shape 로 반환.
    `start` 는 페이지 단위가 아니라 절대 row, 11번가 API 는 pageNum
    을 받으므로 내부에서 변환.
    """
    if not settings.eleven_st_partner_key:
        raise ElevenStError("ELEVEN_ST_PARTNER_KEY not configured")
    q = (query or "").strip()
    if not q:
        raise ElevenStError("empty query")
    page_size = max(1, min(int(display), 100))
    page_num = max(1, (max(1, int(start)) - 1) // page_size + 1)
    sort_code = _SORT_MAP.get(sort, "CP")

    params = {
        "key": settings.eleven_st_partner_key,
        "apiCode": "ProductSearch",
        "keyword": q,
        "pageNum": page_num,
        "pageSize": page_size,
        "sortCd": sort_code,
        "option": "Categories",
    }
    timeout = httpx.Timeout(20.0, connect=5.0)
    async with httpx.AsyncClient(timeout=timeout) as client:
        resp = await client.get(_API_URL, params=params)
    if resp.status_code >= 400:
        raise ElevenStError(
            f"11번가 {resp.status_code}: {resp.text[:200]}"
        )
    # 11번가는 항상 200 을 주고 응답 본문 안 ResultCode 로 에러를 알린다.
    # 잘못된 키면 ResultCode != 0 + ResultMsg 에 한국어 에러.
    try:
        root = ET.fromstring(resp.text)
    except ET.ParseError as exc:
        raise ElevenStError(f"11번가 XML parse: {exc}") from exc

    result_code = _text(root.find(".//ResultCode"))
    if result_code and result_code not in ("0", "00", ""):
        msg = _text(root.find(".//ResultMsg")) or "unknown error"
        raise ElevenStError(f"11번가 ResultCode={result_code}: {msg}")

    out: list[dict] = []
    for prod in root.findall(".//Product"):
        title = _strip(_text(prod.find("ProductName")))
        link = _text(prod.find("DetailPageUrl")) or _text(prod.find("BuyUrl"))
        image = (
            _text(prod.find("ProductImage300"))
            or _text(prod.find("ProductImage200"))
            or _text(prod.find("ProductImage100"))
        )
        price = _int_or_none(_text(prod.find("ProductPrice")))
        # SaleStatus 가 'OnSale' 이 아니어도 결과로 들어옴 — 그대로 둠.
        mall = _text(prod.find("SellerNick")) or "11번가"
        brand = _text(prod.find("Brand"))
        category = _text(prod.find("Category"))
        product_id = _text(prod.find("ProductCode"))
        out.append(
            {
                "title": title,
                "link": link,
                "image": image,
                "lprice": price,
                "hprice": price,
                "mall": mall,
                "brand": brand,
                "category": category,
                "productId": product_id,
                "productType": "",
                "source": "eleven_st",
            }
        )
    return out
