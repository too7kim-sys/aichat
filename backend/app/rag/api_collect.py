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


def _strip_ns(tag: str) -> str:
    """ElementTree prefixes tags with `{namespace}` — drop that so the
    detail-key lookup sees the bare element name like the user wrote
    it in the form."""
    return tag.split("}", 1)[-1] if "}" in tag else tag


def _xml_to_dict(elem):
    """Convert an ElementTree element into a JSON-like dict.
    Attributes are prefixed with @, the text content lives under
    #text when the element also has children. Elements with multiple
    same-tag siblings become a list under that tag."""
    children = list(elem)
    if not children:
        text = (elem.text or "").strip()
        if elem.attrib:
            out = {f"@{k}": v for k, v in elem.attrib.items()}
            if text:
                out["#text"] = text
            return out
        return text or None

    result: dict = {f"@{k}": v for k, v in elem.attrib.items()}
    if (elem.text or "").strip():
        result["#text"] = elem.text.strip()
    for child in children:
        tag = _strip_ns(child.tag)
        sub = _xml_to_dict(child)
        if tag in result:
            cur = result[tag]
            if isinstance(cur, list):
                cur.append(sub)
            else:
                result[tag] = [cur, sub]
        else:
            result[tag] = sub
    return result


def _find_xml_list(elem) -> list | None:
    """Locate the first node whose children are 2+ same-tag siblings —
    that's the list of items in most XML APIs (RSS <item>, Atom
    <entry>, custom <article>, etc.). Returns the converted-to-dict
    items, or None if no list-shaped node exists."""
    children = list(elem)
    if len(children) >= 2:
        tags = {_strip_ns(c.tag) for c in children}
        if len(tags) == 1:
            return [_xml_to_dict(c) for c in children]
    for c in children:
        found = _find_xml_list(c)
        if found is not None:
            return found
    return None


def _parse_response(body: bytes, ctype: str) -> tuple[object | None, bool]:
    """Return (parsed, is_xml). Tries JSON first, then XML."""
    if not body:
        return None, False
    if "xml" not in ctype:
        # JSON is the common case — try it before falling through.
        try:
            return json.loads(body), False
        except Exception:  # noqa: BLE001
            pass
    # XML path — sniff or content-type hint.
    head = body.lstrip()[:5]
    if "xml" in ctype or head.startswith(b"<?xml") or head[:1] == b"<":
        try:
            import xml.etree.ElementTree as ET
            root = ET.fromstring(body)
        except Exception:  # noqa: BLE001
            return None, True
        items = _find_xml_list(root)
        if items is not None:
            return items, True
        # No list shape found — return the whole document as a single
        # dict so _extract_array can still wrap it as "1 item".
        return {_strip_ns(root.tag): _xml_to_dict(root)}, True
    return None, False


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
    # SSRF 차단 — 사용자가 내부망 metadata / 관리 API 를 corpus 로
    # 빼돌리지 못하게 막는다. 리다이렉트도 매 hop 마다 재검증.
    from ..security import UnsafeTargetError, ensure_public_url
    try:
        ensure_public_url(list_url)
        ensure_public_url(detail_url_template.replace("{key}", "x"))
    except UnsafeTargetError as exc:
        raise ApiCollectError(f"URL 차단됨: {exc}") from exc

    with httpx.Client(timeout=_FETCH_TIMEOUT, follow_redirects=False) as c:
        try:
            r = c.get(list_url)
        except httpx.HTTPError as exc:
            raise ApiCollectError(f"목록 fetch 실패: {exc}") from exc
        if r.status_code != 200:
            raise ApiCollectError(f"목록 fetch HTTP {r.status_code}")
        if len(r.content) > _LIST_MAX_BYTES:
            raise ApiCollectError("목록 응답이 너무 큽니다")
        list_ctype = (r.headers.get("content-type") or "").lower()
        parsed, _is_xml = _parse_response(r.content, list_ctype)
        if parsed is None:
            raise ApiCollectError(
                f"목록 응답 파싱 실패 (Content-Type={list_ctype or '없음'}). "
                "JSON 또는 XML 응답을 기대합니다."
            )
        array = _extract_array(parsed)
        total = len(array)
        cap = min(limit, total)
        records: list[dict] = []
        for item in array[:cap]:
            kv = _item_key_value(item, detail_key)
            if kv is None:
                continue
            url = _build_detail_url(detail_url_template, kv)
            # 키가 사용자 데이터에서 왔으니 매 detail URL 재검증 — 키에
            # `@internal-host/` 같은 걸 끼워 host 부분을 휘젓는 시도 방어.
            try:
                ensure_public_url(url)
            except UnsafeTargetError as exc:
                records.append(
                    {"_key": kv, "_url": url, "_body": {"error": str(exc)}}
                )
                continue
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
            detail_ctype = (dr.headers.get("content-type") or "").lower()
            dbody, _ = _parse_response(dr.content, detail_ctype)
            if dbody is None:
                # Last resort — keep the raw text so the embedder
                # still sees something instead of a stub.
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
