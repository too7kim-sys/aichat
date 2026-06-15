"""Query-time retrieval — embed the user's prompt, search Qdrant,
group adjacent hits per file, return a system-context-shaped string."""
from __future__ import annotations

import logging
from dataclasses import dataclass

from sqlalchemy import select

from .. import models
from ..config import settings
from ..database import SessionLocal
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
    # 어느 프로젝트에서 인용됐는지 — 사용자가 청크 박스에서 출처를
    # 한눈에 보고 "공유 KB 참조됨" 인지 확인할 수 있게.
    project_id: str | None = None
    project_name: str | None = None
    project_owned: bool = True


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


async def _resolve_snapshot_id(project_id: str) -> str | None:
    """Look up the project's current_snapshot_id. Returns None when the
    project doesn't exist or hasn't been indexed yet."""
    async with SessionLocal() as db:
        proj = await db.scalar(
            select(models.Project).where(models.Project.id == project_id)
        )
        if not proj:
            return None
        return proj.current_snapshot_id


async def retrieve(
    project_id: str,
    query: str,
    snapshot_id: str | None = None,
    *,
    filename_pattern: str | None = None,
    user_id: str | None = None,
) -> list[RetrievedChunk]:
    """Top-K vector search against a project's CURRENT snapshot.

    Pass snapshot_id explicitly to query a historical snapshot
    instead — useful for comparison/audit. When neither the
    snapshot id arg nor a current_snapshot_id is available, returns
    an empty list (chat path skips retrieval cleanly).

    Optional metadata filter:
      filename_pattern — substring (case-insensitive) that must
        appear in payload.filename. Use to scope search to a single
        sub-tree (e.g. "billing/" → 결제 모듈만).
    user_id — 호출자의 id. 청크에 owned vs shared 표시를 정확히 하는
      데 사용 (auto-search 가 아닌 explicit-link 경로에서도 동일한
      UI 노출).
    """
    if not settings.rag_enabled:
        return []
    target_snapshot = snapshot_id or await _resolve_snapshot_id(project_id)
    if not target_snapshot:
        return []
    # 프로젝트 메타 (이름·소유자·공유 여부) 한 번 가져와서 청크마다 박음.
    proj_meta: dict | None = None
    async with SessionLocal() as db:
        row = (
            await db.execute(
                select(
                    models.Project.name,
                    models.Project.user_id,
                    models.Project.is_shared,
                ).where(models.Project.id == project_id)
            )
        ).first()
        if row:
            proj_meta = {
                "name": row[0],
                "owner_id": row[1],
                "is_shared": bool(row[2]),
            }
    try:
        qvec = await embed_one(query)
    except EmbedError as exc:
        log.warning("RAG retrieval: embedding failed (%s) — returning empty", exc)
        return []
    client = get_client()
    cname = collection_name(target_snapshot)
    # filename 필터는 Qdrant payload 인덱스가 없을 수 있어 서버측에서
    # 후처리 — 큰 collection 에서는 top_k 를 넉넉히 받아 거른 뒤 자른다.
    # (전체 청크 수가 십만 단위까지는 이 방식이 단순하고 충분히 빠르다.)
    pool_k = settings.rag_top_k * 5

    # 1) Vector — Qdrant 코사인 유사도 top-pool.
    try:
        vec_results = client.search(
            collection_name=cname,
            query_vector=qvec,
            limit=pool_k,
            with_payload=True,
        )
    except Exception as exc:  # noqa: BLE001 - collection may not exist yet
        log.warning("RAG retrieval: qdrant search failed (%s)", exc)
        return []

    # 2) BM25 — SQLite FTS5 미러. 실패해도 vector 만으로 계속.
    bm25_results: list[tuple[str, str, float]] = []
    try:
        from . import fts as _fts
        bm25_results = _fts.search(
            target_snapshot, query,
            limit=pool_k,
            filename_pattern=filename_pattern,
        )
    except Exception as exc:  # noqa: BLE001
        log.warning("RAG retrieval: BM25 failed (%s) — vector only", exc)

    # 3) Reciprocal Rank Fusion 으로 두 랭킹 합치기.
    # final_score = sum(1 / (RRF_K + rank))  per run that contains the id
    # k=60 은 BM25/dense hybrid 표준 값.
    RRF_K = 60
    chunk_score: dict[str, float] = {}
    chunk_meta: dict[str, dict] = {}  # id → payload dict (filename, lines, text)
    needle = (filename_pattern or "").lower() or None

    for rank, r in enumerate(vec_results, start=1):
        if not r.payload:
            continue
        fn = str(r.payload.get("filename", ""))
        if needle and needle not in fn.lower():
            continue
        cid = str(r.id)
        chunk_score[cid] = chunk_score.get(cid, 0.0) + 1.0 / (RRF_K + rank)
        chunk_meta[cid] = {
            "filename": fn,
            "start_line": int(r.payload.get("start_line", 0)),
            "end_line": int(r.payload.get("end_line", 0)),
            "text": str(r.payload.get("text", "")),
            "corpus_type": str(r.payload.get("corpus_type", "code")),
            "vec_score": float(r.score),
        }

    for rank, (cid, fn, _bm) in enumerate(bm25_results, start=1):
        chunk_score[cid] = chunk_score.get(cid, 0.0) + 1.0 / (RRF_K + rank)
        if cid not in chunk_meta:
            # BM25 가 발견한 청크가 vector top-pool 에 없을 때 — 그 청크
            # 의 본문은 따로 한 번 더 fetch.
            try:
                pts = client.retrieve(
                    collection_name=cname,
                    ids=[cid],
                    with_payload=True,
                )
            except Exception:  # noqa: BLE001
                pts = []
            if pts and pts[0].payload:
                p = pts[0].payload
                chunk_meta[cid] = {
                    "filename": str(p.get("filename", fn)),
                    "start_line": int(p.get("start_line", 0)),
                    "end_line": int(p.get("end_line", 0)),
                    "text": str(p.get("text", "")),
                    "corpus_type": str(p.get("corpus_type", "code")),
                    "vec_score": 0.0,
                }

    # 4) RRF 점수로 정렬 → top-K.
    ranked = sorted(chunk_score.items(), key=lambda kv: kv[1], reverse=True)
    final = ranked[: settings.rag_top_k]
    hits: list[RetrievedChunk] = []
    for cid, _rrf in final:
        m = chunk_meta.get(cid)
        if not m:
            continue
        # 표시용 score 는 원래 의미를 보존하려고 vector score 를 그대로
        # 들고 간다 (citation chip 임계값이 vector 기준이라).
        hits.append(
            RetrievedChunk(
                filename=m["filename"],
                start_line=m["start_line"],
                end_line=m["end_line"],
                project_id=project_id,
                project_name=proj_meta["name"] if proj_meta else None,
                project_owned=(
                    bool(proj_meta and user_id and proj_meta["owner_id"] == user_id)
                    or bool(proj_meta and not proj_meta["is_shared"])
                ),
                text=m["text"],
                score=m["vec_score"],
                corpus_type=m["corpus_type"],
            )
        )
    return _merge_adjacent(hits)


async def retrieve_many(
    project_ids: list[str],
    query: str,
    *,
    min_score: float = 0.0,
    top_k: int | None = None,
    user_id: str | None = None,
) -> list[RetrievedChunk]:
    """Question-driven multi-project retrieval. Embeds the query ONCE,
    searches every given project's current snapshot, pools the hits,
    score-gates them with `min_score`, and returns the global top-K.

    This is what powers "권한 있는 지식베이스를 채팅에 연결하지 않아도
    질문 기반으로 자동 활용" — irrelevant projects simply contribute
    low-scoring chunks that fall below the gate, so they cost a search
    but never pollute the context."""
    if not settings.rag_enabled or not project_ids:
        return []
    limit = top_k or settings.rag_top_k
    try:
        qvec = await embed_one(query)
    except EmbedError as exc:
        log.warning("RAG multi-retrieval: embedding failed (%s)", exc)
        return []

    # Resolve each project's current snapshot + meta in one DB round-trip.
    async with SessionLocal() as db:
        rows = (
            await db.execute(
                select(
                    models.Project.id,
                    models.Project.current_snapshot_id,
                    models.Project.name,
                    models.Project.user_id,
                    models.Project.is_shared,
                )
                .where(models.Project.id.in_(project_ids))
            )
        ).all()
    meta_by_snap = {
        snap: {
            "project_id": pid,
            "project_name": name,
            "owner_id": owner_id,
            "is_shared": bool(is_shared),
        }
        for pid, snap, name, owner_id, is_shared in rows
        if snap
    }
    if not meta_by_snap:
        return []

    client = get_client()
    pooled: list[RetrievedChunk] = []
    # 진단용 — 프로젝트별로 max score / hits over gate 를 로깅. 운영자가
    # "공유 KB 가 자동 검색에 잡혔는데 왜 청크가 0인지" 즉시 파악 가능.
    diag: list[str] = []
    for snap, meta in meta_by_snap.items():
        cname = collection_name(snap)
        try:
            results = client.search(
                collection_name=cname,
                query_vector=qvec,
                limit=limit,
                with_payload=True,
            )
        except Exception as exc:  # noqa: BLE001 - collection may be absent
            log.warning("RAG multi-retrieval: search failed on %s (%s)", cname, exc)
            diag.append(f"{meta['project_name'] or snap}=ERR")
            continue
        max_score = max((float(r.score) for r in results), default=0.0)
        kept = 0
        for r in results:
            if not r.payload:
                continue
            if float(r.score) < min_score:
                continue
            kept += 1
            pooled.append(
                RetrievedChunk(
                    filename=str(r.payload.get("filename", "")),
                    start_line=int(r.payload.get("start_line", 0)),
                    end_line=int(r.payload.get("end_line", 0)),
                    text=str(r.payload.get("text", "")),
                    score=float(r.score),
                    corpus_type=str(r.payload.get("corpus_type", "code")),
                    project_id=meta["project_id"],
                    project_name=meta["project_name"],
                    # user_id 가 주어졌으면 소유자 매칭, 아니면 안전하게
                    # "공유" 로 표시 (auto-search 경로의 기본값과 일치).
                    project_owned=(
                        bool(user_id) and meta["owner_id"] == user_id
                    ),
                )
            )
        diag.append(
            f"{meta['project_name'] or snap}={kept}/{len(results)} "
            f"top={max_score:.3f}"
        )
    log.info(
        "RAG multi-retrieval: query=%r min_score=%.2f → %s",
        query[:60], min_score, " ".join(diag),
    )
    merged = _merge_adjacent(pooled)
    return merged[:limit]


_USE_CHUNKS_DIRECTIVE = (
    "⚠️ 중요: 아래 청크는 사용자 질문에 답하기 위해 시스템이 자동 검색해 "
    "준비한 자료입니다. 청크 본문에 답이 있다면 반드시 그 내용을 우선 "
    "근거로 답변하세요. 답변 본문에 인용한 청크의 출처를 한 번 이상 "
    "명시해야 하고, 청크가 질문과 관련 없으면 답변 첫 줄에 "
    "'검색된 자료는 이 질문과 직접 관련이 없습니다' 라고 분명히 적고 "
    "그 다음 일반 지식으로 답하세요. 청크를 봤다는 사실을 숨기지 마세요.\n\n"
)


_TYPE_PROMPT_HEADER = {
    "code": (
        "[RETRIEVED PROJECT CONTEXT — 소스 코드]\n"
        + _USE_CHUNKS_DIRECTIVE +
        "사용자 질문은 이 코드베이스에 대한 것입니다. 답변은 청크의 "
        "`path:line`을 인용해야 하며, 보이지 않는 코드를 추측하지 마세요."
    ),
    "document": (
        "[RETRIEVED DOCUMENT CONTEXT — 문서]\n"
        + _USE_CHUNKS_DIRECTIVE +
        "검색된 청크는 문서 본문입니다. 답변은 청크의 파일명·단락 번호로 "
        "인용하고, 본문에 없는 내용은 단정하지 마세요."
    ),
    "api": (
        "[RETRIEVED API CONTEXT — API 스펙]\n"
        + _USE_CHUNKS_DIRECTIVE +
        "검색된 청크는 OpenAPI/Swagger 엔드포인트 정의입니다. 답변에는 "
        "`METHOD /path` 형식으로 인용하고, 청크에 없는 파라미터·응답을 "
        "지어내지 마세요. 예시 호출이 필요하면 청크에 명시된 파라미터만 "
        "사용해 작성하세요."
    ),
    "db": (
        "[RETRIEVED DATABASE CONTEXT — DB 스키마]\n"
        + _USE_CHUNKS_DIRECTIVE +
        "검색된 청크는 데이터베이스 스키마(테이블/뷰/인덱스 등)입니다. "
        "답변에는 `테이블명.컬럼명` 형식으로 인용하고, 청크에 없는 컬럼·"
        "제약조건·관계를 지어내지 마세요. 쿼리 예시를 작성할 때는 청크에 "
        "보이는 컬럼만 사용하세요. 컬럼 타입·NULL 가능 여부·기본값은 "
        "청크 본문에서 확인 가능한 범위 안에서만 단정하세요."
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
