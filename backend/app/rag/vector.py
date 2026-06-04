"""Lazy-loaded Qdrant client + collection helpers.

Local mode keeps everything in-process and persists to a folder on
disk — no docker, no server. Set RAG_QDRANT_URL in .env to point at a
remote Qdrant server instead, without code changes.
"""
from __future__ import annotations

import logging
from pathlib import Path

from qdrant_client import QdrantClient
from qdrant_client.http import models as qm

from ..config import settings

log = logging.getLogger("uvicorn.error")

_client: QdrantClient | None = None


def get_client() -> QdrantClient:
    global _client
    if _client is not None:
        return _client
    if settings.rag_qdrant_url:
        _client = QdrantClient(url=settings.rag_qdrant_url)
        log.info("Qdrant: connected to remote %s", settings.rag_qdrant_url)
    else:
        path = Path(settings.rag_qdrant_path).resolve()
        path.mkdir(parents=True, exist_ok=True)
        _client = QdrantClient(path=str(path))
        log.info("Qdrant: local persistent client at %s", path)
    return _client


def collection_name(project_id: str) -> str:
    return f"proj_{project_id.replace('-', '')}"


def ensure_collection(project_id: str) -> str:
    """Idempotently create the per-project collection. Returns its name."""
    name = collection_name(project_id)
    client = get_client()
    existing = {c.name for c in client.get_collections().collections}
    if name in existing:
        return name
    client.create_collection(
        collection_name=name,
        vectors_config=qm.VectorParams(
            size=settings.rag_embed_dim,
            distance=qm.Distance.COSINE,
        ),
    )
    # Index payload fields the retriever filters on.
    client.create_payload_index(name, "filename", qm.PayloadSchemaType.KEYWORD)
    return name


def drop_collection(project_id: str) -> None:
    name = collection_name(project_id)
    client = get_client()
    try:
        client.delete_collection(name)
    except Exception:  # noqa: BLE001 - collection may not exist
        pass
