"""Ollama embeddings — minimal client tailored to bge-m3."""
from __future__ import annotations

import asyncio
import logging

import httpx

from ..config import settings

log = logging.getLogger("uvicorn.error")


class EmbedError(RuntimeError):
    pass


# bge-m3 context window is 8 192 tokens. For Korean text, ~1 char ≈
# 1 token (some Hangul characters split into 2-3 tokens via BPE); for
# ASCII more like ~4 chars per token. Cap each request at 10 000
# chars to stay well under the limit even for dense Korean — anything
# beyond that gets sliced off here. The chunker still tries to land
# under ~2 KB per chunk; this is the safety net for the corner cases
# (one giant paragraph / a huge minified line / etc.). If the model
# still complains (rare tokenizer collision), the request is halved
# and retried.
_EMBED_MAX_CHARS = 10_000
_EMBED_MIN_RETRY_CHARS = 1_000


async def embed_one(text: str) -> list[float]:
    """Embed a single piece of text via Ollama /api/embeddings.
    Truncates oversized inputs so a single chunk can't fail the
    whole batch with "the input length exceeds the context length".
    """
    if len(text) > _EMBED_MAX_CHARS:
        log.warning(
            "embed_one: truncating %d chars → %d for %s context cap",
            len(text), _EMBED_MAX_CHARS, settings.rag_embed_model,
        )
        text = text[:_EMBED_MAX_CHARS]
    url = f"{settings.ollama_base_url.rstrip('/')}/api/embeddings"
    timeout = httpx.Timeout(connect=10.0, read=60.0, write=30.0, pool=10.0)
    async with httpx.AsyncClient(timeout=timeout) as client:
        # Retry loop — halve the text on every context-overflow until
        # the model accepts it. Lets a dense-Korean chunk that the
        # 10K cap missed still land in the index instead of failing
        # the whole snapshot.
        current = text
        while True:
            resp = await client.post(
                url,
                json={"model": settings.rag_embed_model, "prompt": current},
            )
            if resp.status_code == 200:
                break
            body = (resp.text or "")[:200]
            overflow = (
                resp.status_code == 500
                and "context length" in body.lower()
            )
            if not overflow or len(current) <= _EMBED_MIN_RETRY_CHARS:
                raise EmbedError(
                    f"Ollama embeddings returned {resp.status_code}: {body}"
                )
            shorter = current[: max(_EMBED_MIN_RETRY_CHARS, len(current) // 2)]
            log.warning(
                "embed_one: context overflow on %d chars, retrying with %d",
                len(current), len(shorter),
            )
            current = shorter
        data = resp.json()
    emb = data.get("embedding")
    if not isinstance(emb, list) or len(emb) != settings.rag_embed_dim:
        raise EmbedError(
            f"Unexpected embedding shape from Ollama: len="
            f"{len(emb) if isinstance(emb, list) else 'n/a'}, "
            f"expected {settings.rag_embed_dim}. Did you set the right "
            f"RAG_EMBED_MODEL and RAG_EMBED_DIM, and pull it with "
            f"'ollama pull {settings.rag_embed_model}'?"
        )
    return emb


async def embed_many(texts: list[str], concurrency: int = 4) -> list[list[float]]:
    """Embed a batch with bounded parallelism — Ollama serializes embedding
    requests per model, so 4 in-flight calls is the practical sweet spot."""
    if not texts:
        return []
    sem = asyncio.Semaphore(concurrency)
    results: list[list[float] | None] = [None] * len(texts)

    async def _one(i: int, t: str) -> None:
        async with sem:
            results[i] = await embed_one(t)

    await asyncio.gather(*[_one(i, t) for i, t in enumerate(texts)])
    return [r for r in results if r is not None]
