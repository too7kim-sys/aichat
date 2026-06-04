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
from .chunker import chunk_for_type
from .embed import EmbedError, embed_many
from .vector import collection_name, ensure_collection, get_client

log = logging.getLogger("uvicorn.error")


_EXTS_CODE = {
    ".py", ".js", ".ts", ".tsx", ".jsx", ".mjs", ".cjs", ".vue", ".svelte",
    ".java", ".kt", ".rs", ".go", ".c", ".cpp", ".cc", ".h", ".hpp",
    ".cs", ".rb", ".php", ".sh", ".bash", ".zsh", ".sql", ".pl",
    ".css", ".scss", ".sass", ".html", ".htm", ".xml", ".xsd", ".xsl",
    ".jsp", ".jspx", ".tag", ".tld",
    ".json", ".jsonl", ".yaml", ".yml", ".toml", ".ini", ".cfg", ".conf",
    ".properties", ".md", ".markdown", ".txt", ".csv", ".tsv", ".gradle",
    ".groovy", ".scala", ".lua", ".dart", ".swift",
}
_EXTS_DOCUMENT = {
    ".pdf", ".docx", ".md", ".markdown", ".txt", ".html", ".htm", ".rtf",
    ".log", ".csv", ".tsv",
}
_EXTS_API = {
    ".json", ".yaml", ".yml", ".md", ".markdown",
}
_EXTS_DB = {
    ".sql", ".ddl", ".md", ".markdown",
}

_EXTS_BY_TYPE = {
    "code": _EXTS_CODE,
    "document": _EXTS_DOCUMENT,
    "api": _EXTS_API,
    "db": _EXTS_DB,
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


def _walk_corpus(root: Path, corpus_type: str) -> list[Path]:
    """Filter walk for files we'll embed, using the per-type
    extension allowlist."""
    allowed = _EXTS_BY_TYPE.get(corpus_type, _EXTS_CODE)
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
        if p.suffix.lower() not in allowed:
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


_HTML_TAG_RE = None  # lazily compiled


def _read_text_for_indexing(path: Path) -> str | None:
    """Decode the file into UTF-8 text for chunking. Routes through
    the existing files.extract helpers for PDF and DOCX so the
    indexer benefits from the same parsing pipeline as the chat
    composer attachments. Returns None if the file can't be read."""
    ext = path.suffix.lower()
    try:
        blob = path.read_bytes()
    except OSError:
        return None
    try:
        if ext == ".pdf":
            from ..files.extract import _extract_pdf
            text, _method = _extract_pdf(blob)
            return text
        if ext == ".docx":
            from ..files.extract import _extract_docx
            return _extract_docx(blob)
        # Everything else: try UTF-8 with Korean fallbacks.
        for enc in ("utf-8", "utf-8-sig", "cp949", "euc-kr", "latin-1"):
            try:
                text = blob.decode(enc)
                break
            except UnicodeDecodeError:
                continue
        else:
            text = blob.decode("utf-8", errors="replace")
        if ext in {".html", ".htm"}:
            # Cheap HTML→text: drop tags, normalise whitespace. Avoids
            # pulling in bs4 just for indexing.
            global _HTML_TAG_RE
            if _HTML_TAG_RE is None:
                import re
                _HTML_TAG_RE = re.compile(r"<[^>]+>")
            text = _HTML_TAG_RE.sub(" ", text)
            text = "\n".join(line.strip() for line in text.splitlines())
        return text
    except Exception as exc:  # noqa: BLE001 - keep the indexer rolling
        log.warning("RAG indexer: failed to read %s: %s", path, exc)
        return None


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


# === url source — fetch a single OpenAPI / spec file over HTTP(S) ====

_URL_FETCH_TIMEOUT = 30  # seconds
_URL_FETCH_MAX_BYTES = 10 * 1024 * 1024  # 10 MB cap on a single spec
_ALLOWED_URL_SCHEMES = {"http", "https"}


def _fetch_url_to_dir(url: str, dest: Path) -> None:
    """HTTP GET the URL and stage the body as a single file in dest.
    The filename is taken from the URL path so the chunker's file-type
    routing still works (e.g. openapi.yaml stays a YAML doc)."""
    from urllib.parse import urlparse
    import httpx

    parsed = urlparse(url)
    if parsed.scheme not in _ALLOWED_URL_SCHEMES:
        raise RuntimeError(f"허용되지 않은 URL 스킴: {parsed.scheme}")
    # Reuse the last path segment as the filename; fall back to spec.json
    # for endpoints like https://api.example.com/openapi (no extension).
    leaf = parsed.path.rsplit("/", 1)[-1] or "spec"
    if "." not in leaf:
        # Guess by content-type after fetch — for now default to .json.
        leaf += ".json"
    try:
        with httpx.Client(timeout=_URL_FETCH_TIMEOUT, follow_redirects=True) as c:
            resp = c.get(url)
    except httpx.HTTPError as exc:
        raise RuntimeError(f"URL fetch 실패: {exc}") from exc
    if resp.status_code != 200:
        raise RuntimeError(f"URL fetch HTTP {resp.status_code}")
    body = resp.content
    if len(body) > _URL_FETCH_MAX_BYTES:
        raise RuntimeError(
            f"URL 응답이 너무 큽니다: {len(body):,} bytes (limit "
            f"{_URL_FETCH_MAX_BYTES:,})"
        )
    # Bias the extension toward what the server actually sent us when
    # the URL itself didn't make it clear.
    ctype = (resp.headers.get("content-type") or "").lower()
    if "yaml" in ctype and not leaf.endswith((".yaml", ".yml")):
        leaf = leaf.rsplit(".", 1)[0] + ".yaml"
    elif "json" in ctype and not leaf.endswith(".json"):
        leaf = leaf.rsplit(".", 1)[0] + ".json"
    (dest / leaf).write_bytes(body)


# === connection source — reflect a live DB schema =====================

_ALLOWED_DB_SCHEMES = {
    "sqlite", "postgresql", "postgres", "mysql", "mariadb",
}


def _reflect_db_to_dir(connection_string: str, dest: Path) -> None:
    """Connect to the given DB, reflect every table in the default
    schema into a synthetic CREATE TABLE DDL dump, and write it to
    a single file under dest. The db chunker then splits it the
    same way it would a hand-written .sql file."""
    from urllib.parse import urlparse
    from sqlalchemy import create_engine
    from sqlalchemy.schema import MetaData, CreateTable

    parsed = urlparse(connection_string)
    scheme = (parsed.scheme or "").split("+")[0]
    if scheme not in _ALLOWED_DB_SCHEMES:
        raise RuntimeError(
            f"허용되지 않은 DB 스킴: {scheme}. "
            f"허용: {', '.join(sorted(_ALLOWED_DB_SCHEMES))}"
        )
    try:
        engine = create_engine(
            connection_string, connect_args={"connect_timeout": 10}
            if scheme in {"postgresql", "postgres", "mysql", "mariadb"}
            else {},
        )
    except TypeError:
        # SQLite et al don't support connect_timeout in connect_args.
        engine = create_engine(connection_string)
    try:
        meta = MetaData()
        with engine.connect() as conn:
            meta.reflect(bind=conn)
            parts: list[str] = [
                f"-- DB schema reflected at {connection_string.split('@')[-1]}",
                f"-- {len(meta.tables)} tables",
                "",
            ]
            for tname, tbl in meta.tables.items():
                try:
                    ddl = str(CreateTable(tbl).compile(conn))
                except Exception as exc:  # noqa: BLE001
                    ddl = f"-- (DDL generation failed for {tname}: {exc})"
                parts.append(ddl.rstrip() + ";")
                parts.append("")  # blank line between tables
    finally:
        engine.dispose()
    (dest / "schema.sql").write_text("\n".join(parts), encoding="utf-8")


# === sftp source — download a tree of documents from a SFTP server ===

_SFTP_CONNECT_TIMEOUT = 15  # seconds
_SFTP_MAX_TREE_DEPTH = 8


def _fetch_sftp_to_dir(connection_url: str, dest: Path, corpus_type: str) -> None:
    """Connect to an SFTP server, walk the remote tree from the path
    embedded in the URL, and download every file whose extension is
    in the corpus's allowlist. Result is staged under dest so the
    regular folder walker / chunker pipeline takes over."""
    import stat
    from urllib.parse import unquote, urlparse
    import paramiko

    parsed = urlparse(connection_url)
    if parsed.scheme != "sftp":
        raise RuntimeError(f"SFTP URL이 아닙니다: {parsed.scheme}")
    host = parsed.hostname
    if not host:
        raise RuntimeError("SFTP URL에 호스트가 없습니다")
    if not parsed.username:
        raise RuntimeError("SFTP URL에 사용자명이 없습니다")
    user = unquote(parsed.username)
    password = unquote(parsed.password) if parsed.password else None
    port = parsed.port or 22
    remote_root = parsed.path or "/"
    allowed_exts = _EXTS_BY_TYPE.get(corpus_type, _EXTS_DOCUMENT)

    transport = paramiko.Transport((host, port))
    transport.banner_timeout = _SFTP_CONNECT_TIMEOUT
    sftp: paramiko.SFTPClient | None = None
    file_count = 0
    try:
        try:
            transport.connect(username=user, password=password)
        except paramiko.SSHException as exc:
            raise RuntimeError(f"SFTP 인증 실패: {exc}") from exc
        except OSError as exc:
            raise RuntimeError(
                f"SFTP 연결 실패 ({host}:{port}): {exc}"
            ) from exc
        sftp = paramiko.SFTPClient.from_transport(transport)
        if sftp is None:
            raise RuntimeError("SFTP 채널을 열 수 없습니다")

        def walk(remote: str, local: Path, depth: int) -> None:
            nonlocal file_count
            if depth > _SFTP_MAX_TREE_DEPTH:
                log.warning("SFTP walk: max depth hit at %s", remote)
                return
            try:
                entries = sftp.listdir_attr(remote)  # type: ignore[union-attr]
            except IOError as exc:
                log.warning("SFTP listdir %s failed: %s", remote, exc)
                return
            for entry in entries:
                name = entry.filename
                if name.startswith("."):  # dotfiles like .git, .DS_Store
                    continue
                rpath = f"{remote.rstrip('/')}/{name}"
                mode = entry.st_mode or 0
                if stat.S_ISDIR(mode):
                    sub = local / name
                    sub.mkdir(exist_ok=True)
                    walk(rpath, sub, depth + 1)
                elif stat.S_ISREG(mode):
                    ext_dot = (
                        "." + name.rsplit(".", 1)[1].lower()
                        if "." in name
                        else ""
                    )
                    if ext_dot not in allowed_exts:
                        continue
                    if (entry.st_size or 0) > settings.rag_max_bytes_per_file:
                        log.info(
                            "SFTP skip oversize %s (%d bytes)",
                            rpath, entry.st_size,
                        )
                        continue
                    if file_count >= settings.rag_max_files:
                        log.warning(
                            "SFTP walk: hit RAG_MAX_FILES=%d, stopping",
                            settings.rag_max_files,
                        )
                        return
                    try:
                        sftp.get(rpath, str(local / name))  # type: ignore[union-attr]
                        file_count += 1
                    except IOError as exc:
                        log.warning("SFTP get %s failed: %s", rpath, exc)

        walk(remote_root, dest, 0)
        if file_count == 0:
            raise RuntimeError(
                f"SFTP 경로에서 인덱싱 가능한 파일을 찾지 못했습니다: {remote_root}"
            )
        log.info("SFTP fetch: %d files from %s%s", file_count, host, remote_root)
    finally:
        if sftp is not None:
            try:
                sftp.close()
            except Exception:  # noqa: BLE001
                pass
        try:
            transport.close()
        except Exception:  # noqa: BLE001
            pass


async def _update_snapshot(snapshot_id: str, **patch) -> None:
    """Mirror status onto the snapshot row AND the parent project so
    the UI can show the live status without an extra join."""
    async with SessionLocal() as db:
        snap = await db.scalar(
            select(models.ProjectSnapshot).where(
                models.ProjectSnapshot.id == snapshot_id
            )
        )
        if not snap:
            return
        for k, v in patch.items():
            setattr(snap, k, v)
        # If this snapshot is the current one for its project, also
        # mirror onto the project row.
        proj = await db.scalar(
            select(models.Project).where(models.Project.id == snap.project_id)
        )
        if proj and proj.current_snapshot_id == snap.id:
            for k, v in patch.items():
                if hasattr(proj, k):
                    setattr(proj, k, v)
        await db.commit()


async def run_indexing(snapshot_id: str) -> None:
    """Background entry point. Catches everything to mark the snapshot
    (and mirrored project row) failed on error.

    The collection name follows the snapshot id, not the project id,
    so re-indexing always builds a fresh collection and we can keep
    every historical snapshot side-by-side until the user purges them.
    """
    workdir: Path | None = None
    cleanup_workdir = False
    project_id: str | None = None
    try:
        async with SessionLocal() as db:
            snap = await db.scalar(
                select(models.ProjectSnapshot).where(
                    models.ProjectSnapshot.id == snapshot_id
                )
            )
            if not snap:
                return
            project_id = snap.project_id
            project = await db.scalar(
                select(models.Project).where(models.Project.id == project_id)
            )
            if not project:
                return
            source_type = project.source_type
            source_ref = project.source_ref
            corpus_type = project.corpus_type or "code"

        await _update_snapshot(
            snapshot_id, status="indexing",
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
        elif source_type == "url":
            # API spec hosted at an HTTP(S) endpoint — fetch it and
            # stage as a single-file corpus so the regular walker /
            # chunker pipeline kicks in unchanged.
            workdir = Path(tempfile.mkdtemp(prefix="rag-corpus-"))
            cleanup_workdir = True
            _fetch_url_to_dir(source_ref, workdir)
            root = workdir
        elif source_type == "connection":
            # Live database — connect, reflect every table into a
            # synthetic CREATE TABLE DDL dump, then chunk via the db
            # chunker. Output stays on disk for the duration of the
            # indexing run only.
            workdir = Path(tempfile.mkdtemp(prefix="rag-corpus-"))
            cleanup_workdir = True
            _reflect_db_to_dir(source_ref, workdir)
            root = workdir
        elif source_type == "sftp":
            # SFTP folder of documents — connect, walk the remote
            # path, download matching files (per-corpus extension
            # allowlist) into a tempdir, then run the regular folder
            # pipeline over it.
            workdir = Path(tempfile.mkdtemp(prefix="rag-corpus-"))
            cleanup_workdir = True
            _fetch_sftp_to_dir(source_ref, workdir, corpus_type)
            root = workdir
        else:
            raise RuntimeError(f"unknown source_type: {source_type}")

        # 1) Walk the corpus and build chunks (per-type allowlist +
        #    per-type chunker).
        files = _walk_corpus(root, corpus_type)
        if not files:
            raise RuntimeError(
                f"인덱싱 대상 파일이 없습니다 (corpus_type={corpus_type})"
            )

        all_chunks = []
        for f in files:
            body = _read_text_for_indexing(f)
            if not body:
                continue
            rel = f.relative_to(root).as_posix()
            all_chunks.extend(chunk_for_type(corpus_type, rel, body))

        await _update_snapshot(
            snapshot_id, progress_total=len(all_chunks), file_count=len(files),
        )

        if not all_chunks:
            raise RuntimeError("청크가 생성되지 않았습니다")

        # 2) Drop + recreate THIS snapshot's collection. Older
        #    snapshots' collections are untouched — they stay
        #    queryable until the user explicitly purges them.
        client = get_client()
        try:
            client.delete_collection(collection_name(snapshot_id))
        except Exception:  # noqa: BLE001
            pass
        cname = ensure_collection(snapshot_id)

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
                            "corpus_type": corpus_type,
                            "hash": hashlib.sha1(
                                chunk.text.encode("utf-8")
                            ).hexdigest(),
                        },
                    )
                )
            client.upsert(collection_name=cname, points=points)
            done += len(batch)
            await _update_snapshot(snapshot_id, progress_done=done)

        await _update_snapshot(
            snapshot_id, status="ready", chunk_count=len(all_chunks),
            progress_done=len(all_chunks),
        )
        log.info(
            "RAG indexed snapshot=%s project=%s files=%d chunks=%d",
            snapshot_id, project_id, len(files), len(all_chunks),
        )
    except Exception as exc:  # noqa: BLE001
        log.exception(
            "RAG indexing failed for snapshot=%s project=%s",
            snapshot_id, project_id,
        )
        await _update_snapshot(
            snapshot_id, status="failed", error=str(exc)[:500]
        )
    finally:
        if cleanup_workdir and workdir is not None:
            shutil.rmtree(workdir, ignore_errors=True)


def schedule_indexing(snapshot_id: str) -> None:
    """Fire-and-forget — kicks the indexer onto the running event loop."""
    try:
        loop = asyncio.get_running_loop()
    except RuntimeError:
        asyncio.run(run_indexing(snapshot_id))
        return
    task = loop.create_task(run_indexing(snapshot_id))
    _BACKGROUND_INDEX_TASKS.add(task)
    task.add_done_callback(_BACKGROUND_INDEX_TASKS.discard)


# Strong refs so the indexing task isn't garbage-collected mid-run.
_BACKGROUND_INDEX_TASKS: set[asyncio.Task] = set()
