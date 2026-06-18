"""RAG 품질 향상 단계 (#107~#110).

retrieve() 안에서 호출되는 작은 후처리들 — 모두 토글 가능하고,
실패해도 fallback 으로 retrieval 자체는 절대 막지 않는다.

  - rewrite_query: 짧은 질의를 LLM 가 풀어서 검색용 문장 생성
  - llm_rerank: top-N 후보를 LLM 가 0~10 점수 → 재정렬
  - mmr: 같은 파일/유사 청크가 컨텍스트를 잡아먹지 않게 다양성 강제
  - log_retrieval_quality: '인용 0 / 점수 낮음' 케이스를 별도 테이블에 기록
"""
from __future__ import annotations

import json
import logging
import math
import time
from dataclasses import dataclass
from typing import TYPE_CHECKING

import httpx

from ..config import settings

if TYPE_CHECKING:  # 순환 import 방지 — 타입 힌트만 사용.
    from .retriever import RetrievedChunk

log = logging.getLogger("uvicorn.error")


@dataclass
class QualityFlags:
    """retrieve() 한 번 호출당 결정된 토글 묶음.  admin 이 런타임에 끄고
    켤 수 있도록 DB 의 app_settings 를 한 번 읽어 채워 둔다."""

    query_rewrite: bool
    llm_rerank: bool
    mmr: bool


async def load_flags() -> QualityFlags:
    """앱 부팅 시 set 된 app_settings 를 읽어 토글 묶음을 반환.  DB 가
    안 풀려 있는 등 실패 시 env 기본값으로."""
    try:
        from .. import app_settings as _ax
        from ..database import SessionLocal
        async with SessionLocal() as db:
            return QualityFlags(
                query_rewrite=await _ax.get_bool(db, _ax.KEY_RAG_QUERY_REWRITE),
                llm_rerank=await _ax.get_bool(db, _ax.KEY_RAG_LLM_RERANK),
                mmr=await _ax.get_bool(db, _ax.KEY_RAG_MMR),
            )
    except Exception:  # noqa: BLE001
        return QualityFlags(
            query_rewrite=settings.rag_query_rewrite,
            llm_rerank=settings.rag_llm_rerank,
            mmr=settings.rag_mmr,
        )


# ── #107 질의 재작성 ─────────────────────────────────────────
async def rewrite_query(query: str, *, enabled: bool | None = None) -> str | None:
    """LLM 이 짧은 한국어 질의를 검색용으로 풀어서 반환.  실패하거나
    재작성이 의미 없을 때 None 을 돌려주고, 호출자는 원본 그대로 임베딩.

    재작성 결과가 원본보다 짧거나 동일하면 None — 노이즈만 추가될 위험."""
    on = settings.rag_query_rewrite if enabled is None else enabled
    if not on or not query.strip():
        return None
    # 너무 긴 질의는 이미 풍부 — 재작성 불필요.
    if len(query) > 80:
        return None
    model = (
        settings.rag_query_rewrite_model
        or settings.transcription_summary_model
        or "qwen2.5:7b"
    )
    sys = (
        "당신은 검색 질의 확장기.  사용자의 짧은 한국어 질문을 정보 검색에"
        " 적합한 자연어 문장 한 줄로 다시 작성하세요.  새 정보를 만들지"
        " 말고, 원 질문이 함축한 키워드만 풀어 쓰세요.  마크다운/번호/접두어"
        " 없이 한 줄만 출력."
    )
    timeout = httpx.Timeout(8.0, connect=2.0)
    try:
        async with httpx.AsyncClient(timeout=timeout) as client:
            r = await client.post(
                f"{settings.ollama_base_url.rstrip('/')}/api/chat",
                json={
                    "model": model,
                    "stream": False,
                    "options": {"temperature": 0.0},
                    "messages": [
                        {"role": "system", "content": sys},
                        {"role": "user", "content": query},
                    ],
                },
            )
        if r.status_code >= 400:
            return None
        text = ((r.json() or {}).get("message") or {}).get("content") or ""
    except Exception as exc:  # noqa: BLE001
        log.warning("rewrite_query: LLM 실패 (%s) — 원본 사용", exc)
        return None
    rewritten = text.strip().splitlines()[0].strip() if text else ""
    # 한 줄로 끊고 따옴표·꺽쇠 제거.
    rewritten = rewritten.strip("\"' 　<>「」『』")
    if len(rewritten) <= len(query):
        return None
    return rewritten


# ── #108 LLM 재순위 ─────────────────────────────────────────
async def llm_rerank(
    query: str,
    candidates: "list[RetrievedChunk]",
    *,
    top_k: int,
    enabled: bool | None = None,
) -> "list[RetrievedChunk] | None":
    """후보 N개를 LLM 에 한 번 호출해서 (id → score) 매핑 받기.
    응답을 못 파싱하면 None — 호출자는 RRF 결과 그대로 사용."""
    on = settings.rag_llm_rerank if enabled is None else enabled
    if not on or not candidates:
        return None
    pool = candidates[: settings.rag_llm_rerank_pool]
    model = (
        settings.rag_query_rewrite_model
        or settings.transcription_summary_model
        or "qwen2.5:7b"
    )
    # 후보 텍스트를 300자씩 잘라 입력 — LLM 컨텍스트 절약.
    listing = "\n\n".join(
        f"[{i}] {(c.text or '')[:300]}"
        for i, c in enumerate(pool)
    )
    sys = (
        "당신은 검색 결과 채점기.  사용자 질문에 대해 각 후보 청크가"
        " 얼마나 관련 있는지 0~10 정수로 평가한 JSON 객체를 출력하세요."
        ' 형식: {"scores": [{"i": <인덱스>, "s": <0~10>}, ...]}'
        " 마크다운/설명 없이 *순수 JSON* 만."
    )
    user_msg = f"질문: {query}\n\n후보:\n{listing}"
    timeout = httpx.Timeout(15.0, connect=2.0)
    try:
        async with httpx.AsyncClient(timeout=timeout) as client:
            r = await client.post(
                f"{settings.ollama_base_url.rstrip('/')}/api/chat",
                json={
                    "model": model,
                    "stream": False,
                    "options": {"temperature": 0.0},
                    "messages": [
                        {"role": "system", "content": sys},
                        {"role": "user", "content": user_msg},
                    ],
                },
            )
        if r.status_code >= 400:
            return None
        text = ((r.json() or {}).get("message") or {}).get("content") or ""
    except Exception as exc:  # noqa: BLE001
        log.warning("llm_rerank: LLM 실패 (%s) — RRF 결과 사용", exc)
        return None
    # JSON 파싱 + 코드 펜스 제거.
    cleaned = text.strip()
    if cleaned.startswith("```"):
        cleaned = cleaned.strip("`").lstrip("json").strip()
    try:
        data = json.loads(cleaned)
    except Exception:
        return None
    scores: dict[int, float] = {}
    for it in (data.get("scores") or []) if isinstance(data, dict) else []:
        try:
            scores[int(it["i"])] = float(it["s"])
        except Exception:  # noqa: BLE001
            continue
    if not scores:
        return None
    # 점수 기준 내림차순 — 동점이면 원래 순서 유지.
    ranked = sorted(
        enumerate(pool),
        key=lambda kv: (-scores.get(kv[0], -1.0), kv[0]),
    )
    out = [c for _, c in ranked[:top_k]]
    return out


# ── #109 MMR 다양성 ─────────────────────────────────────────
def _text_overlap(a: str, b: str) -> float:
    """단순 자카드 유사도 — 토큰 집합 교집합 / 합집합.  임베딩 코사인이
    더 좋겠지만 비용을 안 늘리려고 자카드로.  현실적으로 같은 청크의
    인접 본문을 잘 잡아낸다."""
    if not a or not b:
        return 0.0
    sa = set(a.split())
    sb = set(b.split())
    if not sa or not sb:
        return 0.0
    inter = len(sa & sb)
    uni = len(sa | sb)
    return inter / uni if uni else 0.0


def mmr_select(
    candidates: "list[RetrievedChunk]",
    *,
    top_k: int,
    lam: float | None = None,
    enabled: bool | None = None,
) -> "list[RetrievedChunk]":
    """Maximal Marginal Relevance.  후보 리스트가 이미 관련성 순으로
    정렬돼 있다고 가정하고 (rank 가 곧 관련성 점수의 proxy), 같은 파일
    + 본문 유사도가 높은 청크가 연속해서 잡히지 않도록 한다."""
    on = settings.rag_mmr if enabled is None else enabled
    if not on or len(candidates) <= top_k:
        return candidates[:top_k]
    lam = settings.rag_mmr_lambda if lam is None else lam
    # 관련성은 vector score (없으면 0) 를 그대로 사용 — 청크가 retriever
    # 에서 chunk_meta.vec_score 를 박아 두므로 모두 동일 스케일.
    picked: list[RetrievedChunk] = []
    pool = list(candidates)
    picked.append(pool.pop(0))
    while pool and len(picked) < top_k:
        best_i = 0
        best_score = -math.inf
        for i, c in enumerate(pool):
            rel = float(c.score or 0.0)
            max_sim = 0.0
            for p in picked:
                if c.filename == p.filename and abs(
                    c.start_line - p.start_line
                ) < 40:
                    # 같은 파일 + 라인 인접 → near-duplicate.
                    sim = 1.0
                else:
                    sim = _text_overlap(c.text or "", p.text or "")
                if sim > max_sim:
                    max_sim = sim
            score = lam * rel - (1 - lam) * max_sim
            if score > best_score:
                best_score = score
                best_i = i
        picked.append(pool.pop(best_i))
    return picked


# ── #110 검색 품질 로그 ─────────────────────────────────────
# 인용을 못 만든 / 점수가 너무 낮은 / 결과 0개 케이스를 별도 테이블에
# 쌓아 admin 이 '검색 약점' 을 찾아 corpus 를 보강할 수 있게 한다.

async def log_retrieval_quality(
    *,
    user_id: str | None,
    project_ids: list[str],
    query: str,
    top_score: float,
    hit_count: int,
    elapsed_ms: int,
) -> None:
    """SearchQualityLog 행을 추가.  실패해도 silently — RAG 본 흐름을
    절대 막지 않는다."""
    from sqlalchemy.exc import SQLAlchemyError

    from .. import models
    from ..database import SessionLocal

    try:
        async with SessionLocal() as db:
            db.add(
                models.SearchQualityLog(
                    user_id=user_id,
                    project_ids=",".join(project_ids[:10]) if project_ids else None,
                    query=query[:500],
                    top_score=float(top_score),
                    hit_count=int(hit_count),
                    elapsed_ms=int(elapsed_ms),
                )
            )
            await db.commit()
    except SQLAlchemyError as exc:
        log.warning("log_retrieval_quality: DB 실패 (%s)", exc)
    except Exception as exc:  # noqa: BLE001
        log.warning("log_retrieval_quality: 예기치 못한 실패 (%s)", exc)


def now_ms() -> int:
    return int(time.monotonic() * 1000)
