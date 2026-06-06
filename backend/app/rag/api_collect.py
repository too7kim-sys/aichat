"""API "list → per-item detail" collection for the `url` RAG source.

Flow: fetch the list URL, find the array of items (top-level list or
a common wrapper key like data/items/results/content), pull
`detail_key` from each item, substitute it into `detail_url_template`'s
{key} placeholder, fetch every detail response, and render them as
Markdown the document chunker can slice per item.

Shared by the indexer (full collection during indexing) and the
preview endpoint (a couple of items for the create form).
"""
from __future__ import annotations

import json
from typing import Any

_ALLOWED_SCHEMES = {"http", "https"}
_FETCH_TIMEOUT = 30
_DETAIL_MAX = 5000           # hard cap on detail fetches per run
_DETAIL_MAX_BYTES = 2 * 1024 * 1024  # per detail response
_LIST_MAX_BYTES = 16 * 1024 * 1024   # the list response itself

# Common keys under which APIs nest their result array.
_ARRAY_WRAPPER_KEYS = ("data", "items", "results", "content", "list", "rows")


class ApiCollectError(RuntimeError):
    pass


def _extract_array(body: Any) -> list:
    """Find the list of items in a parsed JSON body. Accepts a bare
    top-level array, or an object that wraps it under a common key."""
    if isinstance(body, list):
        return body
    if isinstance(body, dict):
        for k in _ARRAY_WRAPPER_KEYS:
            v = body.get(k)
            if isinstance(v, list):
                return v
        # Single object with no obvious array — treat it as one item.
        return [body]
    raise ApiCollectError(
        "목록 응답이 JSON 배열이 아닙니다 (배열 또는 data/items/results "
        "래퍼를 기대)."
    )


def _item_key_value(item: Any, key: str) -> str | None:
    """Pull `key` from an item dict. Supports dotted paths (a.b.c) for
    nested ids. Returns None when missing/unstringifiable."""
    if not isinstance(item, dict):
        return None
    cur: Any = item
    for part in key.split("."):
        if not isinstance(cur, dict) or part not in cur:
            return None
        cur = cur[part]
    if cur is None or isinstance(cur, (dict, list)):
        return None
    return str(cur)


def _build_detail_url(template: str, key_value: str) -> str:
    import urllib.parse

    enc = urllib.parse.quote(key_value, safe="")
    if "{key}" in template:
        return template.replace("{key}", enc)
    # No placeholder — append as a trailing path segment.
    return template.rstrip("/") + "/" + enc


def _to_markdown(items: list[dict], list_url: str, key: str) -> str:
    parts = [
        "# API detail collection",
        "",
        f"- 목록: {list_url}",
        f"- 상세 키: {key}",
        f"- 수집된 항목: {len(items)}건",
        "",
    ]
    for i, rec in enumerate(items, start=1):
        kv = rec.get("_key", "")
        parts.append(f"## Item {i} — {key}={kv}")
        parts.append(f"- **요청 URL**: {rec.get('_url', '')}")
        body = rec.get("_body")
        parts.append("")
        parts.append("```json")
        try:
            parts.append(json.dumps(body, ensure_ascii=False, indent=2))
        except Exception:  # noqa: BLE001
            parts.append(str(body))
        parts.append("```")
        parts.append("")
    return "\n".join(parts)


def collect_api_details(
    list_url: str,
    detail_key: str,
    detail_url_template: str,
    *,
    limit: int = _DETAIL_MAX,
) -> tuple[list[dict], int]:
    """Fetch the list, then each item's detail. Returns
    (records, total_items_in_list). Each record is {_key, _url, _body}.
    The detail fetch is capped at `limit` items (the form passes a
    small number for preview; the indexer passes rag_max_files)."""
    import httpx
    from urllib.parse import urlparse

    if urlparse(list_url).scheme not in _ALLOWED_SCHEMES:
        raise ApiCollectError(f"허용되지 않은 URL 스킴: {list_url}")
    if urlparse(detail_url_template.replace("{key}", "x")).scheme not in _ALLOWED_SCHEMES:
        raise ApiCollectError("상세 URL 템플릿 스킴이 http/https가 아닙니다")

    with httpx.Client(timeout=_FETCH_TIMEOUT, follow_redirects=True) as c:
        try:
            r = c.get(list_url)
        except httpx.HTTPError as exc:
            raise ApiCollectError(f"목록 fetch 실패: {exc}") from exc
        if r.status_code != 200:
            raise ApiCollectError(f"목록 fetch HTTP {r.status_code}")
        if len(r.content) > _LIST_MAX_BYTES:
            raise ApiCollectError("목록 응답이 너무 큽니다")
        try:
            body = r.json()
        except Exception as exc:  # noqa: BLE001
            raise ApiCollectError(f"목록 JSON 파싱 실패: {exc}") from exc

        array = _extract_array(body)
        total = len(array)
        cap = min(limit, total)
        records: list[dict] = []
        for item in array[:cap]:
            kv = _item_key_value(item, detail_key)
            if kv is None:
                continue
            url = _build_detail_url(detail_url_template, kv)
            try:
                dr = c.get(url)
            except httpx.HTTPError as exc:
                records.append(
                    {"_key": kv, "_url": url, "_body": {"error": str(exc)}}
                )
                continue
            if dr.status_code != 200:
                records.append(
                    {"_key": kv, "_url": url,
                     "_body": {"error": f"HTTP {dr.status_code}"}}
                )
                continue
            if len(dr.content) > _DETAIL_MAX_BYTES:
                records.append(
                    {"_key": kv, "_url": url,
                     "_body": {"error": "상세 응답이 너무 큽니다"}}
                )
                continue
            try:
                dbody = dr.json()
            except Exception:  # noqa: BLE001
                dbody = dr.text
            records.append({"_key": kv, "_url": url, "_body": dbody})
    return records, total


def collect_api_details_to_file(
    list_url: str,
    detail_key: str,
    detail_url_template: str,
    dest_path,
    *,
    limit: int = _DETAIL_MAX,
) -> int:
    """Indexer entry point — collect details and write a single
    Markdown file. Returns the number of detail records written."""
    records, _total = collect_api_details(
        list_url, detail_key, detail_url_template, limit=limit,
    )
    md = _to_markdown(records, list_url, detail_key)
    dest_path.write_text(md, encoding="utf-8")
    return len(records)
