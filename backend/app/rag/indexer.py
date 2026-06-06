"""Index a corpus into Qdrant — runs in the background."""
from __future__ import annotations

import asyncio
import hashlib
import logging
import os
import re
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
from datetime import datetime, timezone

from .chunker import chunk_for_type
from .embed import EmbedError, embed_many
from .vector import (
    collection_name,
    delete_chunks_by_filename,
    ensure_collection,
    get_client,
)

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
    "mssql", "tibero", "cubrid", "altibase",
}


# Max rows / runtime we accept from the user-supplied SELECT during
# indexing. The cap is wide enough for a normal "load all 우편번호"
# style dataset but stops a runaway SELECT from a billion-row table
# from drowning the indexer.
_SQL_QUERY_MAX_ROWS = 50_000
_SQL_QUERY_TIMEOUT_S = 60


def _is_select_only(sql: str) -> bool:
    """Allow only SELECT / WITH (CTE) statements. Strips comments and
    leading whitespace first so a `-- header\nSELECT …` still passes,
    but a `DELETE FROM …` immediately fails."""
    if not sql or not sql.strip():
        return False
    cleaned_lines: list[str] = []
    for line in sql.split("\n"):
        # Drop full-line and trailing `--` comments.
        idx = line.find("--")
        if idx >= 0:
            line = line[:idx]
        if line.strip():
            cleaned_lines.append(line)
    cleaned = " ".join(cleaned_lines).strip()
    # Drop /* … */ comment blocks before classifying.
    cleaned = re.sub(r"/\*.*?\*/", " ", cleaned, flags=re.DOTALL).strip()
    if not cleaned:
        return False
    first_word = re.split(r"\s+", cleaned, maxsplit=1)[0].lower()
    if first_word in {"select", "with"}:
        # Reject any DML/DDL piggybacked after a semicolon.
        rest = cleaned[len(first_word):]
        # Strip a single trailing semicolon — common harmless idiom.
        rest = rest.rstrip().rstrip(";")
        if ";" in rest:
            return False
        return True
    return False


def _format_rows_as_markdown(
    rows: list[dict], query: str, total: int, truncated: bool,
) -> str:
    """Render the row set as Markdown — one '##' section per row with
    key/value pairs underneath. Easier for the embedder than a wide
    table because each row becomes its own chunkable block, which
    aligns with the document chunker's paragraph-window strategy."""
    parts: list[str] = []
    parts.append("# DB query results")
    parts.append("")
    parts.append("```sql")
    parts.append(query.strip())
    parts.append("```")
    parts.append("")
    parts.append(
        f"- 총 {total}행 조회"
        + (f" (최대 {_SQL_QUERY_MAX_ROWS}행 cap 적용)" if truncated else "")
    )
    parts.append("")
    if not rows:
        parts.append("(결과 행 없음)")
        return "\n".join(parts)
    for i, row in enumerate(rows, start=1):
        parts.append(f"## Row {i}")
        for k, v in row.items():
            # Compact value representation; long strings keep their
            # line breaks so the chunker can still slice them cleanly.
            if v is None:
                shown = "(null)"
            elif isinstance(v, (bytes, bytearray)):
                try:
                    shown = v.decode("utf-8", errors="replace")
                except Exception:  # noqa: BLE001
                    shown = f"<{len(v)} bytes>"
            else:
                shown = str(v)
            parts.append(f"- **{k}**: {shown}")
        parts.append("")
    return "\n".join(parts)


def _run_user_sql(
    engine, sql: str,
) -> tuple[list[dict], int, bool]:
    """Run the (already-validated) SELECT and return up to
    _SQL_QUERY_MAX_ROWS rows as dicts, plus the actual fetched count
    and a `truncated` flag indicating whether the cap was hit."""
    from sqlalchemy import text

    rows: list[dict] = []
    with engine.connect() as conn:
        result = conn.execution_options(
            stream_results=True, max_row_buffer=1000,
        ).execute(text(sql))
        keys = list(result.keys())
        truncated = False
        for record in result:
            d = {k: v for k, v in zip(keys, record)}
            rows.append(d)
            if len(rows) >= _SQL_QUERY_MAX_ROWS:
                truncated = True
                break
    return rows, len(rows), truncated


def _reflect_db_to_dir(connection_string: str, dest: Path, sql_query: str | None = None) -> None:
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
        (dest / "schema.sql").write_text("\n".join(parts), encoding="utf-8")

        # Optional user query — execute and dump rows as markdown so
        # the embedder sees them alongside the schema dump.
        if sql_query and sql_query.strip():
            if not _is_select_only(sql_query):
                raise RuntimeError(
                    "안전을 위해 SELECT/WITH 문만 허용됩니다. "
                    "DML/DDL은 인덱싱 SQL로 사용할 수 없습니다."
                )
            try:
                rows, fetched, truncated = _run_user_sql(engine, sql_query)
            except Exception as exc:  # noqa: BLE001
                raise RuntimeError(f"사용자 SQL 실행 실패: {exc}") from exc
            md = _format_rows_as_markdown(
                rows, sql_query, total=fetched, truncated=truncated,
            )
            (dest / "query_results.md").write_text(md, encoding="utf-8")
    finally:
        engine.dispose()


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
            sql_query = project.sql_query
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
            _reflect_db_to_dir(source_ref, workdir, sql_query=sql_query)
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

        # Populate the per-file inventory so future incremental runs
        # can compute a proper hash diff. Wipe any stale rows for this
        # snapshot first in case a previous failed run left some.
        async with SessionLocal() as db:
            existing = await db.execute(
                select(models.IndexedFile).where(
                    models.IndexedFile.snapshot_id == snapshot_id
                )
            )
            for r in existing.scalars():
                await db.delete(r)
            chunks_per_file: dict[str, int] = {}
            for c in all_chunks:
                # Chunk filename may include "#endpoint" for the API
                # chunker; strip back to the parent file so we can
                # rehash + diff against the actual source file.
                base = c.filename.split("#", 1)[0]
                chunks_per_file[base] = chunks_per_file.get(base, 0) + 1
            for f in files:
                try:
                    rel = f.relative_to(root).as_posix()
                except ValueError:
                    continue
                if rel not in chunks_per_file:
                    continue
                try:
                    file_hash = _sha256_file(f)
                    size = f.stat().st_size
                except OSError:
                    continue
                db.add(
                    models.IndexedFile(
                        snapshot_id=snapshot_id,
                        filename=rel,
                        file_hash=file_hash,
                        size=size,
                        chunk_count=chunks_per_file[rel],
                    )
                )
            await db.commit()

        await _update_snapshot(
            snapshot_id, status="ready", chunk_count=len(all_chunks),
            progress_done=len(all_chunks),
        )
        # Stamp last_indexed_at on the parent project so the
        # scheduler knows when it last ran.
        async with SessionLocal() as db:
            proj_row = await db.scalar(
                select(models.Project).where(
                    models.Project.id == project_id
                )
            )
            if proj_row:
                proj_row.last_indexed_at = datetime.now(timezone.utc)
                await db.commit()

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


# === Incremental indexing — only re-embed changed files =============

def _sha256_file(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as f:
        for buf in iter(lambda: f.read(64 * 1024), b""):
            h.update(buf)
    return h.hexdigest()


async def run_incremental(project_id: str) -> dict:
    """Re-walk the project's source, diff each file against the
    indexed_files table for the current snapshot, and only re-embed
    files whose hash actually changed. Removed files have their
    chunks deleted from Qdrant. The current snapshot id is reused —
    incremental updates DON'T create a new snapshot, they keep the
    existing collection fresh.

    Returns a small summary dict so the scheduler can log it."""
    workdir: Path | None = None
    cleanup_workdir = False
    summary = {"added": 0, "updated": 0, "removed": 0, "unchanged": 0}
    try:
        async with SessionLocal() as db:
            proj = await db.scalar(
                select(models.Project).where(models.Project.id == project_id)
            )
            if not proj or not proj.current_snapshot_id:
                return summary
            snapshot_id = proj.current_snapshot_id
            source_type = proj.source_type
            source_ref = proj.source_ref
            sql_query = proj.sql_query
            corpus_type = proj.corpus_type or "code"
            # Mark indexing so a parallel scheduled run / manual
            # button doesn't double-trigger.
            proj.status = "indexing"
            proj.error = None
            await db.commit()

        # Load the previous file inventory.
        async with SessionLocal() as db:
            rows = await db.execute(
                select(models.IndexedFile).where(
                    models.IndexedFile.snapshot_id == snapshot_id
                )
            )
            prev_files: dict[str, models.IndexedFile] = {
                r.filename: r for r in rows.scalars()
            }

        # Stage the corpus the same way run_indexing does.
        if source_type == "git":
            workdir = Path(tempfile.mkdtemp(prefix="rag-corpus-"))
            cleanup_workdir = True
            _clone_git(source_ref, None, workdir)
            root = workdir
        elif source_type == "folder":
            root = Path(source_ref).resolve()
        elif source_type == "url":
            workdir = Path(tempfile.mkdtemp(prefix="rag-corpus-"))
            cleanup_workdir = True
            _fetch_url_to_dir(source_ref, workdir)
            root = workdir
        elif source_type == "connection":
            workdir = Path(tempfile.mkdtemp(prefix="rag-corpus-"))
            cleanup_workdir = True
            _reflect_db_to_dir(source_ref, workdir, sql_query=sql_query)
            root = workdir
        elif source_type == "sftp":
            workdir = Path(tempfile.mkdtemp(prefix="rag-corpus-"))
            cleanup_workdir = True
            _fetch_sftp_to_dir(source_ref, workdir, corpus_type)
            root = workdir
        else:
            raise RuntimeError(f"unknown source_type: {source_type}")

        files = _walk_corpus(root, corpus_type)
        ensure_collection(snapshot_id)  # idempotent
        client = get_client()
        cname = collection_name(snapshot_id)

        seen: set[str] = set()
        for f in files:
            rel = f.relative_to(root).as_posix()
            seen.add(rel)
            try:
                file_hash = _sha256_file(f)
                size = f.stat().st_size
            except OSError:
                continue
            prev = prev_files.get(rel)
            if prev and prev.file_hash == file_hash:
                summary["unchanged"] += 1
                continue

            body = _read_text_for_indexing(f)
            if not body:
                continue
            new_chunks = chunk_for_type(corpus_type, rel, body)
            if not new_chunks:
                continue

            # Replace any previous chunks for this filename in Qdrant.
            if prev is not None:
                delete_chunks_by_filename(snapshot_id, rel)

            # Embed and upsert the new chunks for this file.
            try:
                vectors = await embed_many([c.text for c in new_chunks])
            except EmbedError as exc:
                log.warning("Incremental embed failed for %s: %s", rel, exc)
                continue

            points = []
            for chunk, vec in zip(new_chunks, vectors):
                points.append(
                    qm.PointStruct(
                        id=str(uuid.uuid4()),
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

            async with SessionLocal() as db:
                if prev is not None:
                    # Re-fetch in this session and update.
                    row = await db.scalar(
                        select(models.IndexedFile).where(
                            models.IndexedFile.id == prev.id
                        )
                    )
                    if row:
                        row.file_hash = file_hash
                        row.size = size
                        row.chunk_count = len(new_chunks)
                        row.indexed_at = datetime.now(timezone.utc)
                else:
                    db.add(
                        models.IndexedFile(
                            snapshot_id=snapshot_id,
                            filename=rel,
                            file_hash=file_hash,
                            size=size,
                            chunk_count=len(new_chunks),
                        )
                    )
                await db.commit()
            summary["updated" if prev is not None else "added"] += 1

        # Anything previously indexed but no longer present → remove.
        for rel, prev in prev_files.items():
            if rel in seen:
                continue
            delete_chunks_by_filename(snapshot_id, rel)
            async with SessionLocal() as db:
                row = await db.scalar(
                    select(models.IndexedFile).where(
                        models.IndexedFile.id == prev.id
                    )
                )
                if row:
                    await db.delete(row)
                    await db.commit()
            summary["removed"] += 1

        # Update aggregates on the snapshot + mirror onto project,
        # plus stamp last_indexed_at so the scheduler doesn't fire
        # again immediately.
        async with SessionLocal() as db:
            total_files = await db.scalar(
                select(func.count(models.IndexedFile.id)).where(
                    models.IndexedFile.snapshot_id == snapshot_id
                )
            )
            total_chunks = await db.scalar(
                select(func.coalesce(func.sum(models.IndexedFile.chunk_count), 0))
                .where(models.IndexedFile.snapshot_id == snapshot_id)
            )
            snap = await db.scalar(
                select(models.ProjectSnapshot).where(
                    models.ProjectSnapshot.id == snapshot_id
                )
            )
            if snap:
                snap.status = "ready"
                snap.file_count = int(total_files or 0)
                snap.chunk_count = int(total_chunks or 0)
                snap.progress_done = snap.chunk_count
                snap.progress_total = snap.chunk_count
            proj = await db.scalar(
                select(models.Project).where(models.Project.id == project_id)
            )
            if proj:
                proj.status = "ready"
                proj.file_count = int(total_files or 0)
                proj.chunk_count = int(total_chunks or 0)
                proj.progress_done = proj.chunk_count
                proj.progress_total = proj.chunk_count
                proj.error = None
                proj.last_indexed_at = datetime.now(timezone.utc)
            await db.commit()

        log.info(
            "RAG incremental project=%s added=%d updated=%d removed=%d unchanged=%d",
            project_id, summary["added"], summary["updated"],
            summary["removed"], summary["unchanged"],
        )
        return summary
    except Exception as exc:  # noqa: BLE001
        log.exception("RAG incremental failed for project=%s", project_id)
        async with SessionLocal() as db:
            proj = await db.scalar(
                select(models.Project).where(models.Project.id == project_id)
            )
            if proj:
                proj.status = "failed"
                proj.error = str(exc)[:500]
                await db.commit()
        return summary
    finally:
        if cleanup_workdir and workdir is not None:
            shutil.rmtree(workdir, ignore_errors=True)


# === Scheduler loop — wakes every minute, kicks due projects ========

async def scheduler_loop(poll_seconds: int = 60) -> None:
    """Background task launched from FastAPI's lifespan. Each tick
    looks for projects with schedule_interval_minutes > 0 whose
    last_indexed_at is older than that interval and triggers an
    incremental update. Crashes inside a single project's run are
    caught so one bad source doesn't break the whole loop."""
    log.info("RAG scheduler started (poll=%ds)", poll_seconds)
    while True:
        try:
            await asyncio.sleep(poll_seconds)
            await _scheduler_tick()
        except asyncio.CancelledError:
            log.info("RAG scheduler cancelled")
            return
        except Exception as exc:  # noqa: BLE001
            log.exception("RAG scheduler tick failed: %s", exc)


def _due_for_refresh(
    interval_min: int,
    last_indexed_at: datetime | None,
    now_utc: datetime,
) -> bool:
    """Wall-clock aligned schedule decision.

    Sub-day intervals (< 1440 min) fire on boundaries measured from
    local midnight: a 60-min interval is due once per :00 hour, a
    30-min one at :00 / :30, etc. We compute the start of the current
    boundary slot and fire if the last run predates it — so the job
    lands at the top of the slot (within one poll tick) regardless of
    when the previous run finished, instead of drifting forward.

    Day-or-longer intervals fire once at rag_daily_refresh_hour local
    time ("새벽"), and only after at least N days have elapsed since
    the last run (N = interval // 1440)."""
    from datetime import timedelta

    offset = timedelta(hours=settings.rag_tz_offset_hours)
    local = now_utc + offset
    last = last_indexed_at
    if last is not None and last.tzinfo is None:
        last = last.replace(tzinfo=timezone.utc)

    if interval_min < 1440:
        since_midnight = local.hour * 60 + local.minute
        slot = (since_midnight // interval_min) * interval_min
        # Start of the current boundary slot, expressed back in UTC.
        local_midnight = local.replace(
            hour=0, minute=0, second=0, microsecond=0
        )
        boundary_local = local_midnight + timedelta(minutes=slot)
        boundary_utc = boundary_local - offset
        return last is None or last < boundary_utc

    # Day-or-longer interval — daily "새벽" run, every N days.
    days = max(1, interval_min // 1440)
    if local.hour < settings.rag_daily_refresh_hour:
        return False  # before today's 새벽 window
    target_local = local.replace(
        hour=settings.rag_daily_refresh_hour,
        minute=0, second=0, microsecond=0,
    )
    target_utc = target_local - offset
    if last is None:
        return True
    if last >= target_utc:
        return False  # already ran in today's window
    # Enforce the multi-day spacing (1h slack for run duration).
    if (now_utc - last).total_seconds() < days * 86400 - 3600:
        return False
    return True


async def _scheduler_tick() -> None:
    async with SessionLocal() as db:
        rows = await db.execute(
            select(models.Project).where(
                models.Project.schedule_interval_minutes > 0,
                models.Project.status != "indexing",
                models.Project.current_snapshot_id.is_not(None),
            )
        )
        candidates = list(rows.scalars())

    now = datetime.now(timezone.utc)
    for proj in candidates:
        if not _due_for_refresh(
            proj.schedule_interval_minutes, proj.last_indexed_at, now
        ):
            continue
        log.info(
            "RAG scheduler firing project=%s (interval=%d min)",
            proj.id, proj.schedule_interval_minutes,
        )
        task = asyncio.get_running_loop().create_task(
            run_incremental(proj.id)
        )
        _BACKGROUND_INDEX_TASKS.add(task)
        task.add_done_callback(_BACKGROUND_INDEX_TASKS.discard)


def schedule_incremental(project_id: str) -> None:
    """Manual trigger version of incremental — same as scheduled, but
    on demand from a button."""
    try:
        loop = asyncio.get_running_loop()
    except RuntimeError:
        asyncio.run(run_incremental(project_id))
        return
    task = loop.create_task(run_incremental(project_id))
    _BACKGROUND_INDEX_TASKS.add(task)
    task.add_done_callback(_BACKGROUND_INDEX_TASKS.discard)


# Strong refs so the indexing task isn't garbage-collected mid-run.
_BACKGROUND_INDEX_TASKS: set[asyncio.Task] = set()
