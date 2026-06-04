"""Query-time retrieval — embed the user's prompt, search Qdrant,
group adjacent hits per file, return a system-context-shaped string."""
from __future__ import annotations

import logging
from dataclasses import dataclass

from ..config import settings
from .embed import EmbedError, embed_one
from .vector import collection_name, get_client

log = logging.getLogger("uvicorn.error")


@dataclass
class RetrievedChunk:
    filename: str
    start_line: int
    end_line: int
    text: str
    score: float
    corpus_type: str = "code"


def _merge_adjacent(hits: list[RetrievedChunk]) -> list[RetrievedChunk]:
    """If two hits in the same file overlap or are within 10 lines, merge
    them — the model reads concatenated code more clearly than two near-
    identical snippets."""
    if not hits:
        return []
    by_file: dict[str, list[RetrievedChunk]] = {}
    for h in hits:
        by_file.setdefault(h.filename, []).append(h)
    merged: list[RetrievedChunk] = []
    for fname, items in by_file.items():
        items.sort(key=lambda x: x.start_line)
        cur = items[0]
        for nxt in items[1:]:
            if nxt.start_line <= cur.end_line + 10:
                # Take the higher score, the union of line ranges, and the
                # longer text (which should encompass both originals
                # because the chunker overlaps by design).
                if len(nxt.text) > len(cur.text):
                    text = nxt.text
                else:
                    text = cur.text
                cur = RetrievedChunk(
                    filename=fname,
                    start_line=min(cur.start_line, nxt.start_line),
                    end_line=max(cur.end_line, nxt.end_line),
                    text=text,
                    score=max(cur.score, nxt.score),
                )
            else:
                merged.append(cur)
                cur = nxt
        merged.append(cur)
    merged.sort(key=lambda x: x.score, reverse=True)
    return merged


async def retrieve(project_id: str, query: str) -> list[RetrievedChunk]:
    """Top-K vector search against the project's collection."""
    if not settings.rag_enabled:
        return []
    try:
        qvec = await embed_one(query)
    except EmbedError as exc:
        log.warning("RAG retrieval: embedding failed (%s) — returning empty", exc)
        return []
    client = get_client()
    cname = collection_name(project_id)
    try:
        results = client.search(
            collection_name=cname,
            query_vector=qvec,
            limit=settings.rag_top_k,
            with_payload=True,
        )
    except Exception as exc:  # noqa: BLE001 - collection may not exist yet
        log.warning("RAG retrieval: qdrant search failed (%s)", exc)
        return []
    hits = [
        RetrievedChunk(
            filename=str(r.payload.get("filename", "")),
            start_line=int(r.payload.get("start_line", 0)),
            end_line=int(r.payload.get("end_line", 0)),
            text=str(r.payload.get("text", "")),
            score=float(r.score),
            corpus_type=str(r.payload.get("corpus_type", "code")),
        )
        for r in results
        if r.payload
    ]
    return _merge_adjacent(hits)


_TYPE_PROMPT_HEADER = {
    "code": (
        "[RETRIEVED PROJECT CONTEXT — 소스 코드]\n"
        "사용자 질문은 이 코드베이스에 대한 것입니다. 답변은 청크의 "
        "`path:line`을 인용해야 하며, 보이지 않는 코드를 추측하지 마세요."
    ),
    "document": (
        "[RETRIEVED DOCUMENT CONTEXT — 문서]\n"
        "검색된 청크는 문서 본문입니다. 답변은 청크의 파일명·단락 번호로 "
        "인용하고, 본문에 없는 내용은 단정하지 마세요."
    ),
    "legal": (
        "[RETRIEVED LEGAL CONTEXT — 법령·약관]\n"
        "검색된 청크는 법령/약관 조문입니다. 답변은 `파일명 제N조` 형식으로 "
        "정확히 인용하고, 조문 문구를 임의로 바꾸지 마세요. 해석이 필요하면 "
        "조문 인용 뒤에 \"(해석)\"이라고 명시하세요. 효력 발생일·개정일이 "
        "청크에 보이지 않으면 \"확인 필요\"라고 답하세요."
    ),
    "api": (
        "[RETRIEVED API CONTEXT — API 스펙]\n"
        "검색된 청크는 OpenAPI/Swagger 엔드포인트 정의입니다. 답변에는 "
        "`METHOD /path` 형식으로 인용하고, 청크에 없는 파라미터·응답을 "
        "지어내지 마세요. 예시 호출이 필요하면 청크에 명시된 파라미터만 "
        "사용해 작성하세요."
    ),
}


def format_chunks_for_prompt(chunks: list[RetrievedChunk]) -> str:
    """Render retrieved chunks as a single system-message payload.
    The header is selected by the most-common corpus_type across
    the hits so the model gets the right instruction for the kind
    of material it's about to read."""
    if not chunks:
        return ""
    # Pick the dominant corpus_type to size the header text.
    by_type: dict[str, int] = {}
    for c in chunks:
        by_type[c.corpus_type] = by_type.get(c.corpus_type, 0) + 1
    dominant = max(by_type.items(), key=lambda x: x[1])[0]
    header = _TYPE_PROMPT_HEADER.get(dominant, _TYPE_PROMPT_HEADER["code"])

    parts: list[str] = [header, f"검색된 {len(chunks)}개 청크:", ""]
    for c in chunks:
        parts.append(
            f"--- {c.filename}:{c.start_line}-{c.end_line} "
            f"(score={c.score:.3f}) ---"
        )
        parts.append(c.text)
        parts.append("")
    return "\n".join(parts)
