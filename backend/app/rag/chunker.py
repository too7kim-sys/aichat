"""Chunkers, one per corpus type.

Public entry point: chunk_for_type(corpus_type, filename, body) → list[Chunk].
Each chunker emits a list of overlapping windows whose text is what
gets embedded by bge-m3 and stored in Qdrant. The strategy differs by
corpus because retrieval quality depends on whether we slice on
syntactic boundaries (code: line windows, legal: 조 boundaries),
semantic boundaries (document: paragraphs / headings), or structural
ones (API: one endpoint per chunk).
"""
from __future__ import annotations

import logging
import re
from dataclasses import dataclass

from ..config import settings

log = logging.getLogger("uvicorn.error")


@dataclass
class Chunk:
    filename: str
    start_line: int  # 1-indexed, inclusive (line number for code,
    end_line: int    # paragraph index for prose, "0/0" if N/A)
    text: str        # what gets embedded; includes a header line for context


# ── code: line windows (existing behaviour) ───────────────────────────

def chunk_code(filename: str, body: str) -> list[Chunk]:
    lines = body.splitlines()
    n = len(lines)
    if n == 0:
        return []

    win = max(20, settings.rag_chunk_lines)
    overlap = max(0, min(win - 10, settings.rag_chunk_overlap))
    step = max(1, win - overlap)

    out: list[Chunk] = []
    i = 0
    while i < n:
        end = min(i + win, n)
        body_lines = lines[i:end]
        header = f"// {filename} (lines {i + 1}-{end})"
        text = header + "\n" + "\n".join(body_lines)
        out.append(
            Chunk(filename=filename, start_line=i + 1, end_line=end, text=text)
        )
        if end == n:
            break
        i += step
    return out


# ── document: paragraph windows with markdown-heading context ─────────

_HEADING_RE = re.compile(r"^(#{1,6})\s+(.+?)\s*$", re.M)


def chunk_document(filename: str, body: str) -> list[Chunk]:
    """Group consecutive paragraphs into ~2 KB chunks. Markdown
    headings (#, ##, ...) are preserved at the top of every chunk
    that falls under them, so a chunk lifted out of context still
    advertises its section. Overlap by carrying the trailing
    paragraph forward when it fits."""

    target_chars = 2000
    overlap_chars = 250

    # Normalise CR/LF, split on blank-line boundaries.
    paragraphs = re.split(r"\n\s*\n+", body.replace("\r\n", "\n"))

    # Track the most recent heading chain so we can prepend it.
    current_heading = ""

    chunks: list[Chunk] = []
    buf_paragraphs: list[str] = []
    buf_chars = 0
    para_idx = 0
    chunk_start_para = 0

    def flush():
        nonlocal buf_paragraphs, buf_chars, chunk_start_para
        if not buf_paragraphs:
            return
        header_lines = [f"// {filename} (paragraphs {chunk_start_para + 1}-{para_idx})"]
        if current_heading:
            header_lines.append(f"# {current_heading}")
        text = "\n".join(header_lines) + "\n\n" + "\n\n".join(buf_paragraphs).strip()
        chunks.append(
            Chunk(
                filename=filename,
                start_line=chunk_start_para + 1,
                end_line=para_idx,
                text=text,
            )
        )
        # Carry the tail as overlap.
        tail_chars = 0
        tail: list[str] = []
        for p in reversed(buf_paragraphs):
            if tail_chars + len(p) > overlap_chars and tail:
                break
            tail.insert(0, p)
            tail_chars += len(p)
        buf_paragraphs = list(tail)
        buf_chars = sum(len(p) for p in buf_paragraphs)
        chunk_start_para = para_idx - len(buf_paragraphs)

    for raw_para in paragraphs:
        para = raw_para.strip()
        if not para:
            continue
        para_idx += 1
        # Update the running heading when we see a markdown header.
        h = _HEADING_RE.match(para)
        if h:
            current_heading = h.group(2).strip()
            # Include the heading line in the buffer so the chunk reads
            # naturally — `# Section\n\nbody…`.
        if buf_chars + len(para) > target_chars and buf_paragraphs:
            flush()
        buf_paragraphs.append(para)
        buf_chars += len(para)

    if buf_paragraphs:
        flush()

    return chunks


# ── legal: Korean law / regulation, 조-boundary chunker ───────────────

# Catch 제\d+조 / 제 \d+ 조 with optional subtitle in parens.
_JO_RE = re.compile(
    r"(?:^|\n)\s*제\s*(\d+)\s*조(?:의\s*\d+)?\s*(?:\([^)]+\))?", re.U
)
# Higher-level structure markers for context.
_PYEN_RE = re.compile(r"^\s*제\s*\d+\s*편", re.M | re.U)
_JANG_RE = re.compile(r"^\s*제\s*\d+\s*장", re.M | re.U)
_JEOL_RE = re.compile(r"^\s*제\s*\d+\s*절", re.M | re.U)


def chunk_legal(filename: str, body: str) -> list[Chunk]:
    """Split on 제N조 boundaries. Each 조 becomes one chunk; the chunk
    text includes the current 편/장/절 headings as context so a
    retrieved 조 carries its hierarchy with it. Falls back to the
    document chunker when no 조 markers are found (e.g., a 시행세칙
    that uses a different style)."""

    text = body.replace("\r\n", "\n")
    matches = list(_JO_RE.finditer(text))
    if not matches:
        return chunk_document(filename, body)

    chunks: list[Chunk] = []
    for i, m in enumerate(matches):
        start = m.start()
        end = matches[i + 1].start() if i + 1 < len(matches) else len(text)
        jo_body = text[start:end].strip()
        if not jo_body:
            continue

        # Walk back from `start` to find the most recent 편/장/절 lines
        # so we can prepend them as context. Track the LAST hit per
        # marker type — a 제3조 sitting inside "제2장 처리원칙" should
        # carry that 장 forward even though "제1장 통칙" appears earlier
        # in the file.
        prefix_window = text[:start]
        last_by_marker: dict[str, str] = {}
        for label_re, marker in (
            (_PYEN_RE, "편"),
            (_JANG_RE, "장"),
            (_JEOL_RE, "절"),
        ):
            for hit in label_re.finditer(prefix_window):
                line_end = prefix_window.find("\n", hit.end())
                if line_end < 0:
                    line_end = len(prefix_window)
                last_by_marker[marker] = (
                    prefix_window[hit.start():line_end].strip()
                )

        prefix_parts = [
            last_by_marker[m]
            for m in ("편", "장", "절")
            if m in last_by_marker
        ]
        header_lines = [f"// {filename} (제{m.group(1)}조)"]
        header_lines.extend(prefix_parts)
        chunk_text = "\n".join(header_lines) + "\n\n" + jo_body

        # We don't have meaningful line numbers — use the 조 ordinal so
        # the retriever can still display something sensible.
        chunks.append(
            Chunk(
                filename=filename,
                start_line=i + 1,
                end_line=i + 1,
                text=chunk_text,
            )
        )

    return chunks


# ── api: one chunk per OpenAPI endpoint ───────────────────────────────

def _try_parse_openapi(body: str, ext: str) -> dict | None:
    try:
        if ext in (".yaml", ".yml"):
            import yaml
            data = yaml.safe_load(body)
        elif ext == ".json":
            import json
            data = json.loads(body)
        else:
            return None
    except Exception:  # noqa: BLE001
        return None
    if not isinstance(data, dict):
        return None
    # OpenAPI 3.x has "openapi"; Swagger 2.0 has "swagger".
    if "openapi" in data or "swagger" in data:
        return data
    return None


def chunk_api(filename: str, body: str) -> list[Chunk]:
    """Endpoint-per-chunk for OpenAPI / Swagger specs. Each chunk
    bundles the path + HTTP method + summary + description + a brief
    parameter / request / response summary. For non-spec API docs
    (markdown READMEs, plain text), fall through to the document
    chunker so they still get indexed."""

    ext = ("." + filename.rsplit(".", 1)[1].lower()) if "." in filename else ""
    spec = _try_parse_openapi(body, ext)
    if spec is None:
        return chunk_document(filename, body)

    info = spec.get("info") or {}
    title = info.get("title") or filename
    version = info.get("version") or "?"
    base_paths = spec.get("paths") or {}

    chunks: list[Chunk] = []
    chunk_idx = 0
    for path, methods in base_paths.items():
        if not isinstance(methods, dict):
            continue
        for method, op in methods.items():
            if method.lower() not in {
                "get", "post", "put", "patch", "delete", "head", "options",
            }:
                continue
            if not isinstance(op, dict):
                continue
            summary = (op.get("summary") or "").strip()
            description = (op.get("description") or "").strip()
            tags = op.get("tags") or []

            param_lines: list[str] = []
            for p in op.get("parameters") or []:
                if not isinstance(p, dict):
                    continue
                name = p.get("name", "?")
                where = p.get("in", "?")
                required = "(required)" if p.get("required") else ""
                ptype = (p.get("schema") or {}).get("type", "")
                pdesc = (p.get("description") or "").strip().splitlines()[:1]
                pdesc_str = pdesc[0] if pdesc else ""
                param_lines.append(
                    f"  - {name} [{where} {ptype}] {required} {pdesc_str}".rstrip()
                )

            request_body = op.get("requestBody")
            req_summary = ""
            if isinstance(request_body, dict):
                content = request_body.get("content") or {}
                req_summary = "  ".join(content.keys())

            responses = op.get("responses") or {}
            response_summary = ", ".join(str(k) for k in responses.keys())

            parts = [
                f"// {filename} ({title} {version})",
                f"{method.upper()} {path}",
            ]
            if tags:
                parts.append(f"tags: {', '.join(map(str, tags))}")
            if summary:
                parts.append(f"summary: {summary}")
            if description:
                parts.append("description:")
                parts.append(description)
            if param_lines:
                parts.append("parameters:")
                parts.extend(param_lines)
            if req_summary:
                parts.append(f"requestBody: {req_summary}")
            if response_summary:
                parts.append(f"responses: {response_summary}")

            chunk_idx += 1
            chunks.append(
                Chunk(
                    filename=f"{filename}#{method.upper()} {path}",
                    start_line=chunk_idx,
                    end_line=chunk_idx,
                    text="\n".join(parts),
                )
            )

    if not chunks:
        # No paths found despite parsing — treat as a document so the
        # info block at least gets indexed.
        return chunk_document(filename, body)
    return chunks


# ── db: one chunk per CREATE TABLE / VIEW / PROCEDURE ────────────────

_DDL_OBJECT_RE = re.compile(
    r"""
    CREATE\s+
    (?:OR\s+REPLACE\s+)?
    (?P<kind>TABLE|VIEW|MATERIALIZED\s+VIEW|INDEX|UNIQUE\s+INDEX|
              FUNCTION|PROCEDURE|TYPE|TRIGGER)\s+
    (?:IF\s+NOT\s+EXISTS\s+)?
    (?P<name>[a-zA-Z_][\w.\[\]\"`]*)
    """,
    re.IGNORECASE | re.VERBOSE,
)


def _strip_sql_comments(body: str) -> str:
    """Drop -- line comments and /* */ block comments while preserving
    string literals. Cheap pass so the boundary scanner doesn't trip
    on commented-out semicolons."""
    out = []
    i = 0
    n = len(body)
    while i < n:
        c = body[i]
        # /* ... */
        if c == "/" and i + 1 < n and body[i + 1] == "*":
            j = body.find("*/", i + 2)
            i = j + 2 if j >= 0 else n
            continue
        # -- line comment
        if c == "-" and i + 1 < n and body[i + 1] == "-":
            j = body.find("\n", i + 2)
            i = j if j >= 0 else n
            continue
        # 'string' or "ident" — copy as-is to preserve content
        if c in ("'", '"'):
            quote = c
            j = i + 1
            while j < n:
                if body[j] == "\\" and j + 1 < n:
                    j += 2
                    continue
                if body[j] == quote:
                    j += 1
                    break
                j += 1
            out.append(body[i:j])
            i = j
            continue
        out.append(c)
        i += 1
    return "".join(out)


def _sql_statements(body: str) -> list[tuple[int, int, str]]:
    """Split into (start_offset, end_offset, text) statements on top-level
    semicolons. Naive but works for the vast majority of DDL dumps."""
    cleaned = _strip_sql_comments(body)
    stmts: list[tuple[int, int, str]] = []
    start = 0
    paren = 0
    in_str: str | None = None
    i = 0
    n = len(cleaned)
    while i < n:
        c = cleaned[i]
        if in_str:
            if c == "\\" and i + 1 < n:
                i += 2
                continue
            if c == in_str:
                in_str = None
            i += 1
            continue
        if c in ("'", '"'):
            in_str = c
        elif c == "(":
            paren += 1
        elif c == ")":
            paren = max(0, paren - 1)
        elif c == ";" and paren == 0:
            chunk = cleaned[start : i + 1].strip()
            if chunk:
                stmts.append((start, i + 1, chunk))
            start = i + 1
        i += 1
    tail = cleaned[start:].strip()
    if tail:
        stmts.append((start, n, tail))
    return stmts


def chunk_db(filename: str, body: str) -> list[Chunk]:
    """SQL DDL chunker — one chunk per CREATE TABLE / VIEW / PROCEDURE.

    For each top-level DDL statement, we keep the original text and
    look up the matching CREATE pattern to label the chunk. ALTER
    TABLE and INSERT statements that reference an already-emitted
    table are appended to that table's chunk so the indexed
    knowledge of a table includes its constraints and seed data.
    Files that contain no DDL fall back to the document chunker so
    plain queries / notebooks still get indexed.
    """
    statements = _sql_statements(body)
    if not statements:
        return chunk_document(filename, body)

    # First pass: emit one chunk per CREATE statement, capture name.
    by_table: dict[str, list[str]] = {}
    chunks: list[Chunk] = []
    chunk_lookup: dict[str, int] = {}  # table name → chunks index
    chunk_idx = 0
    has_ddl = False

    for _start, _end, stmt in statements:
        m = _DDL_OBJECT_RE.match(stmt)
        if m:
            has_ddl = True
            kind = " ".join(m.group("kind").upper().split())
            name = m.group("name").strip().strip('"').strip("`").strip("[]")
            chunk_idx += 1
            text = (
                f"// {filename}\n"
                f"-- {kind}: {name}\n\n"
                f"{stmt}"
            )
            chunks.append(
                Chunk(
                    filename=f"{filename}#{name}",
                    start_line=chunk_idx,
                    end_line=chunk_idx,
                    text=text,
                )
            )
            chunk_lookup[name.lower()] = len(chunks) - 1
            by_table.setdefault(name, []).append(stmt)
        else:
            # ALTER TABLE foo ... / CREATE INDEX ... ON foo / INSERT INTO foo …
            alter_re = re.match(
                r"^\s*(?:ALTER\s+TABLE|INSERT\s+INTO|UPDATE|DELETE\s+FROM)\s+"
                r"([a-zA-Z_][\w.\[\]\"`]*)",
                stmt, re.IGNORECASE,
            )
            target: str | None = None
            if alter_re:
                target = (
                    alter_re.group(1).strip().strip('"').strip("`").strip("[]")
                )
            else:
                index_re = re.match(
                    r"^\s*CREATE\s+(?:UNIQUE\s+)?INDEX\s+\S+\s+ON\s+"
                    r"([a-zA-Z_][\w.\[\]\"`]*)",
                    stmt, re.IGNORECASE,
                )
                if index_re:
                    target = (
                        index_re.group(1).strip().strip('"').strip("`").strip("[]")
                    )
            if target and target.lower() in chunk_lookup:
                idx = chunk_lookup[target.lower()]
                chunks[idx] = Chunk(
                    filename=chunks[idx].filename,
                    start_line=chunks[idx].start_line,
                    end_line=chunks[idx].end_line,
                    text=chunks[idx].text + "\n\n" + stmt,
                )

    if not has_ddl:
        return chunk_document(filename, body)
    return chunks


# ── public dispatcher ────────────────────────────────────────────────

_CHUNKERS = {
    "code": chunk_code,
    "document": chunk_document,
    "legal": chunk_legal,
    "api": chunk_api,
    "db": chunk_db,
}


def chunk_for_type(
    corpus_type: str, filename: str, body: str
) -> list[Chunk]:
    fn = _CHUNKERS.get(corpus_type, chunk_code)
    return fn(filename, body)


# Backwards-compatible name (old callers used chunk_file).
def chunk_file(filename: str, body: str) -> list[Chunk]:
    return chunk_code(filename, body)
