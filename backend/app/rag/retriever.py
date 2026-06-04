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
        )
        for r in results
        if r.payload
    ]
    return _merge_adjacent(hits)


def format_chunks_for_prompt(chunks: list[RetrievedChunk]) -> str:
    """Render retrieved chunks as a single system-message payload."""
    if not chunks:
        return ""
    parts: list[str] = [
        "[RETRIEVED PROJECT CONTEXT]",
        f"검색된 {len(chunks)}개 청크가 아래에 있습니다. 사용자 질문은 "
        "이 프로젝트에 대한 것이며, 답변은 이 청크들의 `path:line`을 "
        "인용해야 합니다. 청크에 보이지 않는 코드는 추측하지 마세요.",
        "",
    ]
    for c in chunks:
        parts.append(
            f"--- {c.filename}:{c.start_line}-{c.end_line} "
            f"(score={c.score:.3f}) ---"
        )
        parts.append(c.text)
        parts.append("")
    return "\n".join(parts)
