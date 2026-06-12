"""SQLite FTS5 mirror of indexed chunks for BM25 lexical search.

Vector search (Qdrant) finds semantically similar chunks but loses on
exact term matches — Korean noun searches, product codes, error IDs.
We mirror each chunk into a FTS5 virtual table on indexing, run BM25
in parallel with vector search on retrieval, and combine the two
rankings with Reciprocal Rank Fusion (RRF) so each side covers the
other's blind spot.

Schema lives in the main aichat DB (not a separate file) so it's
backed up alongside everything else and gets the same WAL.
"""
from __future__ import annotations

import logging
import sqlite3
import threading
from contextlib import contextmanager
from pathlib import Path

from ..config import settings

log = logging.getLogger("uvicorn.error")

_lock = threading.Lock()
_initialized = False


def _db_path() -> str:
    # database_url 가 "sqlite+aiosqlite:///./aichat.db" 같은 형식.
    url = settings.database_url
    if "sqlite" not in url:
        return ""
    if ":///" in url:
        return url.split(":///", 1)[1]
    return url


@contextmanager
def _conn():
    """Synchronous connection — FTS5 calls happen from the indexer
    thread (a thread-pool executor) and from retrieve which runs on
    the event loop; we use a fresh connection per call to keep things
    simple. SQLite handles concurrent readers fine; writes are short."""
    path = _db_path()
    if not path:
        raise RuntimeError("FTS only supported with SQLite database")
    p = Path(path).expanduser().resolve()
    p.parent.mkdir(parents=True, exist_ok=True)
    c = sqlite3.connect(str(p), timeout=10)
    try:
        c.execute("PRAGMA journal_mode=WAL")
        yield c
        c.commit()
    finally:
        c.close()


def ensure_schema() -> None:
    """Create the FTS5 virtual table on first use. Trigram tokenizer
    handles Korean/CJK without word-boundary heuristics (unicode61 fails
    miserably on '결제로직')."""
    global _initialized
    if _initialized:
        return
    with _lock:
        if _initialized:
            return
        with _conn() as c:
            # trigram 토크나이저는 SQLite 3.34+ 부터 표준 빌드에 포함.
            # 본문에 한국어가 많으니 trigram 이 BM25 결과 품질이 가장
            # 안정적. content='' 로 contentless 테이블 — 우리는 별도
            # 의 chunk_id 만 검색용으로 가지고, 본문은 Qdrant payload
            # 에서 다시 가져온다 (디스크 중복 X).
            c.execute(
                """
                CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts USING fts5(
                    chunk_id UNINDEXED,
                    snapshot_id UNINDEXED,
                    filename UNINDEXED,
                    text,
                    tokenize='trigram'
                )
                """
            )
        _initialized = True
        log.info("RAG FTS5: schema ready")


def add_chunks(
    snapshot_id: str,
    rows: list[tuple[str, str, str]],  # (chunk_id, filename, text)
) -> None:
    """Batched insert. Called by the indexer after each Qdrant upsert.
    파일명도 한 줄 prefix 로 indexed text 에 포함 — "billing" 같은
    경로 키워드로도 BM25 매칭이 잡히게."""
    if not rows:
        return
    ensure_schema()
    with _conn() as c:
        c.executemany(
            "INSERT INTO chunks_fts(chunk_id, snapshot_id, filename, text) "
            "VALUES(?, ?, ?, ?)",
            [
                (cid, snapshot_id, fn, f"{fn}\n{txt}")
                for cid, fn, txt in rows
            ],
        )


def drop_snapshot(snapshot_id: str) -> int:
    """Snapshot 삭제 시 호출. 반환은 지운 행 수."""
    ensure_schema()
    with _conn() as c:
        cur = c.execute(
            "DELETE FROM chunks_fts WHERE snapshot_id = ?",
            (snapshot_id,),
        )
        return cur.rowcount or 0


def search(
    snapshot_id: str,
    query: str,
    *,
    limit: int = 50,
    filename_pattern: str | None = None,
) -> list[tuple[str, str, float]]:
    """BM25 검색. Returns list of (chunk_id, filename, score) sorted by
    relevance (lower BM25 = more relevant, so we negate for "higher
    = better" downstream consistency)."""
    ensure_schema()
    # FTS5 의 query 문법은 일반 텍스트면 그대로 단어 매칭. 특수문자만
    # 따옴표 처리해서 안전한 쿼리로 정규화.
    safe = _sanitize_query(query)
    if not safe:
        return []
    sql = (
        "SELECT chunk_id, filename, bm25(chunks_fts) AS score "
        "FROM chunks_fts WHERE chunks_fts MATCH ? AND snapshot_id = ? "
    )
    args: list = [safe, snapshot_id]
    if filename_pattern:
        sql += "AND lower(filename) LIKE ? "
        args.append(f"%{filename_pattern.lower()}%")
    sql += "ORDER BY score LIMIT ?"
    args.append(limit)
    with _conn() as c:
        try:
            rows = c.execute(sql, args).fetchall()
        except sqlite3.OperationalError as exc:
            log.warning("FTS5 search failed: %s — query=%r", exc, safe)
            return []
    # BM25: 낮을수록 더 관련 — 1 / (1 + score) 로 0~1 범위 정규화해
    # RRF 와 자연스럽게 합쳐지게.
    return [
        (cid, fn, 1.0 / (1.0 + float(score)))
        for cid, fn, score in rows
    ]


def _sanitize_query(q: str) -> str:
    """FTS5 MATCH 문법에 안전한 형태로. NEAR/" 같은 연산자를 사용자가
    의도치 않게 넣어 SQL 에러 나는 걸 막는다. 단어 단위로 따옴표 감싸기."""
    parts = [w.strip() for w in q.split() if w.strip()]
    if not parts:
        return ""
    # 따옴표는 \" 로 escape, 단어 자체를 phrase 로 처리.
    quoted = []
    for w in parts[:20]:  # 20단어 cap
        w = w.replace('"', '""')
        quoted.append(f'"{w}"')
    return " ".join(quoted)
