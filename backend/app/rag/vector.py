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


def _local_collection_dir(project_id: str) -> Path | None:
    """Best-effort guess for the on-disk dir of a collection in
    Qdrant's local persistent mode. Returns None when the deployment
    is using a remote server (storage isn't ours to manage)."""
    if settings.rag_qdrant_url:
        return None
    base = Path(settings.rag_qdrant_path).resolve()
    cname = collection_name(project_id)
    # qdrant-client local layout: <base>/collection/<name>/...  Try both
    # "collection" and "collections" — the directory name has changed
    # between versions of the lib.
    for variant in ("collection", "collections"):
        candidate = base / variant / cname
        if candidate.exists():
            return candidate
    return None


def _dir_size(path: Path) -> int:
    total = 0
    for f in path.rglob("*"):
        try:
            if f.is_file():
                total += f.stat().st_size
        except OSError:
            continue
    return total


def drop_collection(project_id: str) -> int:
    """Delete the collection from Qdrant and wipe any local-mode files
    it left behind. Returns the number of bytes freed on disk (0 when
    running against a remote Qdrant or when nothing was there)."""
    name = collection_name(project_id)
    client = get_client()
    # Snapshot the on-disk size before deletion so we can report what
    # was freed; the directory disappears after delete_collection in
    # well-behaved local mode but we also defensively rmtree below.
    local_dir = _local_collection_dir(project_id)
    bytes_before = _dir_size(local_dir) if local_dir else 0
    try:
        client.delete_collection(name)
    except Exception as exc:  # noqa: BLE001
        log.warning(
            "Qdrant delete_collection(%s) failed: %s — will still wipe local files",
            name, exc,
        )
    # Defense in depth: if the local-mode directory survived the API
    # call (older qdrant-client versions, partial writes, ...), nuke it
    # explicitly so the user actually gets disk back.
    if local_dir and local_dir.exists():
        import shutil

        shutil.rmtree(local_dir, ignore_errors=True)
    if local_dir and local_dir.exists():
        log.warning(
            "Qdrant local dir %s persisted after rmtree; manual cleanup needed",
            local_dir,
        )
    return bytes_before


def storage_usage_bytes() -> int:
    """Total bytes consumed by the local Qdrant data directory across
    every collection. Returns 0 in remote-server mode."""
    if settings.rag_qdrant_url:
        return 0
    base = Path(settings.rag_qdrant_path).resolve()
    if not base.exists():
        return 0
    return _dir_size(base)
