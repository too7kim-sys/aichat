"""Index a corpus into Qdrant — runs in the background."""
from __future__ import annotations

import asyncio
import hashlib
import logging
import os
import shutil
import subprocess
import tempfile
import uuid
from pathlib import Path
from urllib.parse import urlparse

from qdrant_client.http import models as qm
from sqlalchemy import select

from .. import models
from ..config import settings
from ..database import SessionLocal
from .chunker import chunk_file
from .embed import EmbedError, embed_many
from .vector import collection_name, ensure_collection, get_client

log = logging.getLogger("uvicorn.error")


_ALLOWED_EXT = {
    ".py", ".js", ".ts", ".tsx", ".jsx", ".mjs", ".cjs", ".vue", ".svelte",
    ".java", ".kt", ".rs", ".go", ".c", ".cpp", ".cc", ".h", ".hpp",
    ".cs", ".rb", ".php", ".sh", ".bash", ".zsh", ".sql", ".pl",
    ".css", ".scss", ".sass", ".html", ".htm", ".xml", ".xsd", ".xsl",
    ".jsp", ".jspx", ".tag", ".tld",
    ".json", ".jsonl", ".yaml", ".yml", ".toml", ".ini", ".cfg", ".conf",
    ".properties", ".md", ".markdown", ".txt", ".csv", ".tsv", ".gradle",
    ".groovy", ".scala", ".lua", ".dart", ".swift",
}
_SKIP_DIRS = {
    "node_modules", ".git", ".svn", ".hg", ".venv", "venv", "__pycache__",
    "dist", "build", ".next", ".cache", ".vite", ".turbo", ".gradle",
    ".idea", ".vscode", "target", ".pytest_cache", ".mypy_cache",
    "coverage", ".nuxt", "out", "vendor", "Pods", "DerivedData",
    "obj", "bin",
}
_ALLOWED_GIT_HOSTS = {
    "github.com", "raw.githubusercontent.com", "gitlab.com",
    "bitbucket.org", "codeberg.org", "git.sr.ht",
}
_GIT_CLONE_TIMEOUT = 600  # bigger than the one-off /repo/clone — RAG corpora are larger


def _walk_corpus(root: Path) -> list[Path]:
    """Filter walk for files we'll embed."""
    out: list[Path] = []
    for p in root.rglob("*"):
        if not p.is_file() or p.is_symlink():
            continue
        try:
            rel = p.relative_to(root)
        except ValueError:
            continue
        if any(seg in _SKIP_DIRS for seg in rel.parts):
            continue
        if p.suffix.lower() not in _ALLOWED_EXT:
            continue
        try:
            if p.stat().st_size > settings.rag_max_bytes_per_file:
                continue
        except OSError:
            continue
        out.append(p)
        if len(out) >= settings.rag_max_files:
            log.warning(
                "RAG indexer: hit RAG_MAX_FILES=%d, stopping walk early",
                settings.rag_max_files,
            )
            break
    return out


def _clone_git(url: str, ref: str | None, dest: Path) -> None:
    parsed = urlparse(url)
    if parsed.scheme not in ("http", "https"):
        raise RuntimeError("Only http(s) git URLs are allowed")
    if parsed.hostname not in _ALLOWED_GIT_HOSTS:
        raise RuntimeError(
            f"호스트 미허용: {parsed.hostname}. 허용: "
            f"{', '.join(sorted(_ALLOWED_GIT_HOSTS))}"
        )
    cmd = [
        "git", "clone", "--depth", "1", "--single-branch", "--no-tags",
        "--filter=blob:limit=2m",
    ]
    if ref:
        # Same validation as routers/repo.py — block --upload-pack=… etc.
        import re
        if not re.match(r"^[A-Za-z0-9_][A-Za-z0-9._\-/]{0,119}$", ref):
            raise RuntimeError("ref 형식이 올바르지 않습니다")
        cmd.extend(["--branch", ref])
    cmd.append("--")
    cmd.extend([url, str(dest)])
    env = {
        **os.environ,
        "GIT_TERMINAL_PROMPT": "0",
        "GIT_ASKPASS": "echo",
        "GIT_LFS_SKIP_SMUDGE": "1",
    }
    try:
        proc = subprocess.run(
            cmd, env=env, capture_output=True,
            timeout=_GIT_CLONE_TIMEOUT, check=False,
        )
    except FileNotFoundError as exc:
        raise RuntimeError("git 실행 파일을 찾을 수 없습니다") from exc
    except subprocess.TimeoutExpired as exc:
        raise RuntimeError(f"git clone 타임아웃 ({_GIT_CLONE_TIMEOUT}s)") from exc
    if proc.returncode != 0:
        detail = (proc.stderr or b"").decode("utf-8", errors="replace").strip()
        raise RuntimeError(f"git clone 실패: {detail[:300]}")


async def _update_project(project_id: str, **patch) -> None:
    async with SessionLocal() as db:
        row = await db.scalar(
            select(models.Project).where(models.Project.id == project_id)
        )
        if not row:
            return
        for k, v in patch.items():
            setattr(row, k, v)
        await db.commit()


async def run_indexing(project_id: str) -> None:
    """Background entry point. Catches everything to mark the row failed."""
    workdir: Path | None = None
    cleanup_workdir = False
    try:
        async with SessionLocal() as db:
            project = await db.scalar(
                select(models.Project).where(models.Project.id == project_id)
            )
            if not project:
                return
            source_type = project.source_type
            source_ref = project.source_ref

        await _update_project(
            project_id, status="indexing",
            progress_done=0, progress_total=0, error=None,
        )

        if source_type == "git":
            workdir = Path(tempfile.mkdtemp(prefix="rag-corpus-"))
            cleanup_workdir = True
            _clone_git(source_ref, None, workdir)
            root = workdir
        elif source_type == "folder":
            root = Path(source_ref).resolve()
            if not root.is_dir():
                raise RuntimeError(f"폴더를 찾을 수 없습니다: {root}")
        else:
            raise RuntimeError(f"unknown source_type: {source_type}")

        # 1) Walk the corpus and build chunks.
        files = _walk_corpus(root)
        if not files:
            raise RuntimeError("인덱싱 대상 파일이 없습니다")

        all_chunks = []
        for f in files:
            try:
                body = f.read_text(encoding="utf-8", errors="replace")
            except OSError:
                continue
            rel = f.relative_to(root).as_posix()
            all_chunks.extend(chunk_file(rel, body))

        await _update_project(
            project_id, progress_total=len(all_chunks), file_count=len(files),
        )

        if not all_chunks:
            raise RuntimeError("청크가 생성되지 않았습니다")

        # 2) Drop + recreate the per-project Qdrant collection so re-index
        #    is idempotent and doesn't leave stale vectors behind.
        client = get_client()
        try:
            client.delete_collection(collection_name(project_id))
        except Exception:  # noqa: BLE001
            pass
        cname = ensure_collection(project_id)

        # 3) Embed + upsert in batches.
        BATCH = 32
        done = 0
        for i in range(0, len(all_chunks), BATCH):
            batch = all_chunks[i : i + BATCH]
            try:
                vectors = await embed_many([c.text for c in batch])
            except EmbedError as exc:
                raise RuntimeError(f"임베딩 실패: {exc}") from exc

            points = []
            for chunk, vec in zip(batch, vectors):
                point_id = str(uuid.uuid4())
                points.append(
                    qm.PointStruct(
                        id=point_id,
                        vector=vec,
                        payload={
                            "filename": chunk.filename,
                            "start_line": chunk.start_line,
                            "end_line": chunk.end_line,
                            "text": chunk.text,
                            "hash": hashlib.sha1(
                                chunk.text.encode("utf-8")
                            ).hexdigest(),
                        },
                    )
                )
            client.upsert(collection_name=cname, points=points)
            done += len(batch)
            await _update_project(project_id, progress_done=done)

        await _update_project(
            project_id, status="ready", chunk_count=len(all_chunks),
            progress_done=len(all_chunks),
        )
        log.info(
            "RAG indexed project=%s files=%d chunks=%d",
            project_id, len(files), len(all_chunks),
        )
    except Exception as exc:  # noqa: BLE001
        log.exception("RAG indexing failed for project=%s", project_id)
        await _update_project(project_id, status="failed", error=str(exc)[:500])
    finally:
        if cleanup_workdir and workdir is not None:
            shutil.rmtree(workdir, ignore_errors=True)


def schedule_indexing(project_id: str) -> None:
    """Fire-and-forget — kicks the indexer onto the running event loop."""
    try:
        loop = asyncio.get_running_loop()
    except RuntimeError:
        # Called from sync context (shouldn't happen via FastAPI) — make
        # a one-off loop to schedule onto.
        asyncio.run(run_indexing(project_id))
        return
    task = loop.create_task(run_indexing(project_id))
    _BACKGROUND_INDEX_TASKS.add(task)
    task.add_done_callback(_BACKGROUND_INDEX_TASKS.discard)


# Strong refs so the indexing task isn't garbage-collected mid-run.
_BACKGROUND_INDEX_TASKS: set[asyncio.Task] = set()
