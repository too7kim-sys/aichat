"""Ollama embeddings — minimal client tailored to bge-m3."""
from __future__ import annotations

import asyncio
import logging

import httpx

from ..config import settings

log = logging.getLogger("uvicorn.error")


class EmbedError(RuntimeError):
    pass


async def embed_one(text: str) -> list[float]:
    """Embed a single piece of text via Ollama /api/embeddings.

    Truncates oversized inputs at the caller — bge-m3 handles up to 8K
    tokens (~24KB of ASCII). For the chunker's 200-line windows this is
    comfortable headroom.
    """
    url = f"{settings.ollama_base_url.rstrip('/')}/api/embeddings"
    timeout = httpx.Timeout(connect=10.0, read=60.0, write=30.0, pool=10.0)
    async with httpx.AsyncClient(timeout=timeout) as client:
        resp = await client.post(
            url,
            json={"model": settings.rag_embed_model, "prompt": text},
        )
        if resp.status_code != 200:
            body = (resp.text or "")[:200]
            raise EmbedError(
                f"Ollama embeddings returned {resp.status_code}: {body}"
            )
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
