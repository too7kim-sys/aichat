"""Filesystem + git ops for code workspaces.

Phase 1 scope:
  - clone_repo(): authenticated git clone into a per-user dir
  - sync_repo():  git fetch + reset --hard origin/<branch>
  - walk_tree():  build a nested tree for the file browser
  - read_file():  safe text read with size limits
  - remove_repo(): rm -rf the working dir

Phase 2+ will add diff/apply/commit/push.
"""
from __future__ import annotations

import asyncio
import logging
import os
import re
import shutil
import subprocess
from pathlib import Path
from urllib.parse import quote, urlparse

from ..config import settings

log = logging.getLogger("uvicorn.error")

_REF_RE = re.compile(r"^[A-Za-z0-9_][A-Za-z0-9._\-/]{0,119}$")

# Same skip patterns the RAG indexer uses — saves the tree walker
# from reporting every node_modules/.git/build directory.
_SKIP_DIRS = {
    ".git", ".svn", ".hg",
    "node_modules", ".venv", "venv", "__pycache__",
    "dist", "build", ".next", ".cache", ".vite", ".turbo", ".gradle",
    ".idea", ".vscode", "target", ".pytest_cache", ".mypy_cache",
    "coverage", ".nuxt", "out", "vendor", "Pods", "DerivedData",
    "obj", "bin",
}
_TEXT_EXTS = {
    ".py", ".js", ".ts", ".tsx", ".jsx", ".mjs", ".cjs", ".vue", ".svelte",
    ".java", ".kt", ".rs", ".go", ".c", ".cpp", ".cc", ".h", ".hpp",
    ".cs", ".rb", ".php", ".sh", ".bash", ".zsh", ".sql", ".pl",
    ".css", ".scss", ".sass", ".html", ".htm", ".xml", ".xsd", ".xsl",
    ".jsp", ".jspx", ".tag", ".tld",
    ".json", ".jsonl", ".yaml", ".yml", ".toml", ".ini", ".cfg", ".conf",
    ".properties", ".md", ".markdown", ".txt", ".csv", ".tsv", ".gradle",
    ".groovy", ".scala", ".lua", ".dart", ".swift",
    ".dockerfile", ".env", ".gitignore", ".gitattributes",
}


# ── URL + path helpers ────────────────────────────────────────────────

def _validate_git_url(git_url: str) -> tuple[str, str]:
    """Return (scheme, hostname). Raises ValueError if the URL is
    rejected by the host allow-list or the scheme is unsupported."""
    parsed = urlparse(git_url)
    if parsed.scheme not in ("http", "https"):
        raise ValueError(
            "현재 phase 1은 http(s) git URL만 지원합니다 (ssh:// 는 phase 2)"
        )
    if not parsed.hostname:
        raise ValueError("Git URL에 호스트가 없습니다")
    allowed = settings.workspace_allowed_host_list
    if allowed and parsed.hostname not in allowed:
        raise ValueError(
            f"호스트 미허용: {parsed.hostname}. 허용 목록: {', '.join(allowed)}"
        )
    return parsed.scheme, parsed.hostname


def _auth_url(git_url: str, username: str | None, token: str | None) -> str:
    """Embed credentials into the URL when present. Both fields are
    URL-encoded so passwords containing /:@? still parse correctly."""
    if not (username or token):
        return git_url
    parsed = urlparse(git_url)
    if not parsed.scheme.startswith("http"):
        return git_url
    auth = ""
    if username and token:
        auth = f"{quote(username, safe='')}:{quote(token, safe='')}@"
    elif token:
        # GitHub PATs go in the password slot of a fake "x-access-token"
        # user; many internal servers accept token-only auth the same way.
        auth = f"x-access-token:{quote(token, safe='')}@"
    elif username:
        auth = f"{quote(username, safe='')}@"
    rebuilt = f"{parsed.scheme}://{auth}{parsed.netloc.split('@')[-1]}{parsed.path}"
    if parsed.query:
        rebuilt += f"?{parsed.query}"
    return rebuilt


def workspace_path_for(user_id: str, workspace_id: str) -> Path:
    base = Path(settings.workspace_dir).resolve()
    return (base / user_id / workspace_id).resolve()


# ── Clone / sync ──────────────────────────────────────────────────────

def _run_git(cmd: list[str], cwd: Path | None, timeout: int) -> tuple[int, bytes]:
    """Sync subprocess.run on Windows + POSIX. Returns
    (returncode, stderr). Same env hardening as the RAG indexer."""
    env = {
        **os.environ,
        "GIT_TERMINAL_PROMPT": "0",
        "GIT_ASKPASS": "echo",
        "GIT_LFS_SKIP_SMUDGE": "1",
    }
    try:
        proc = subprocess.run(
            cmd,
            env=env,
            cwd=str(cwd) if cwd else None,
            capture_output=True,
            timeout=timeout,
            check=False,
        )
        return proc.returncode, proc.stderr or b""
    except FileNotFoundError:
        return -2, b"git executable not found on server PATH"
    except subprocess.TimeoutExpired as exc:
        return -1, (exc.stderr or b"") if isinstance(exc.stderr, bytes) else b""


def clone_repo(
    dest: Path,
    git_url: str,
    branch: str,
    username: str | None,
    token: str | None,
) -> None:
    """Run by the background task that's kicked from the create-
    workspace API endpoint."""
    _validate_git_url(git_url)
    if branch and not _REF_RE.match(branch):
        raise ValueError(
            "branch 형식이 올바르지 않습니다 (영문/숫자/._-/만 허용)"
        )

    if dest.exists():
        shutil.rmtree(dest, ignore_errors=True)
    dest.parent.mkdir(parents=True, exist_ok=True)

    url = _auth_url(git_url, username, token)
    cmd = [
        "git", "clone",
        "--depth", str(settings.workspace_clone_depth),
        "--single-branch",
    ]
    if branch:
        cmd.extend(["--branch", branch])
    cmd.append("--")
    cmd.extend([url, str(dest)])

    rc, stderr = _run_git(cmd, cwd=None, timeout=600)
    if rc == -2:
        raise RuntimeError("서버에 git이 설치되어 있지 않습니다")
    if rc == -1:
        raise RuntimeError("git clone 타임아웃 (600초)")
    if rc != 0:
        # Mask any leaked credentials in the stderr before re-raising.
        detail = stderr.decode("utf-8", errors="replace")
        if token:
            detail = detail.replace(quote(token, safe=""), "***")
        raise RuntimeError(f"git clone 실패: {detail.strip()[:300]}")


def sync_repo(
    dest: Path,
    git_url: str,
    branch: str,
    username: str | None,
    token: str | None,
) -> None:
    """git fetch + hard-reset to origin/<branch>. We use --hard so any
    Phase-2 local edits the user accidentally left behind don't block
    the sync; once Phase 2 lands a `--no-discard-edits` switch this
    will get smarter."""
    if not (dest / ".git").exists():
        # Treat as a fresh clone instead of trying to recover.
        clone_repo(dest, git_url, branch, username, token)
        return
    if branch and not _REF_RE.match(branch):
        raise ValueError("branch 형식이 올바르지 않습니다")

    # Update the remote URL in case the user rotated their token.
    new_url = _auth_url(git_url, username, token)
    _run_git(["git", "remote", "set-url", "origin", new_url], cwd=dest, timeout=10)

    rc, stderr = _run_git(
        ["git", "fetch", "--depth", str(settings.workspace_clone_depth), "origin"],
        cwd=dest,
        timeout=300,
    )
    if rc != 0:
        detail = stderr.decode("utf-8", errors="replace")
        if token:
            detail = detail.replace(quote(token, safe=""), "***")
        raise RuntimeError(f"git fetch 실패: {detail.strip()[:300]}")

    target = f"origin/{branch}" if branch else "FETCH_HEAD"
    rc, stderr = _run_git(["git", "reset", "--hard", target], cwd=dest, timeout=60)
    if rc != 0:
        detail = stderr.decode("utf-8", errors="replace")
        raise RuntimeError(f"git reset 실패: {detail.strip()[:300]}")


# ── Tree walk ─────────────────────────────────────────────────────────

def walk_tree(root: Path) -> tuple[list[dict], int, int]:
    """Build a nested list[ {name, path, kind, size, children} ].
    Returns (tree, file_count, total_size_bytes)."""
    file_count = 0
    total_size = 0
    max_files = settings.workspace_max_files

    def visit(d: Path, rel: str) -> list[dict]:
        nonlocal file_count, total_size
        items: list[dict] = []
        try:
            entries = sorted(d.iterdir(), key=lambda p: (not p.is_dir(), p.name.lower()))
        except OSError:
            return items
        for entry in entries:
            if entry.is_symlink():
                continue
            if entry.name in _SKIP_DIRS:
                continue
            entry_rel = f"{rel}/{entry.name}" if rel else entry.name
            if entry.is_dir():
                children = visit(entry, entry_rel)
                if children:
                    items.append({
                        "name": entry.name,
                        "path": entry_rel,
                        "kind": "dir",
                        "size": 0,
                        "children": children,
                    })
                continue
            if file_count >= max_files:
                continue
            try:
                size = entry.stat().st_size
            except OSError:
                continue
            file_count += 1
            total_size += size
            items.append({
                "name": entry.name,
                "path": entry_rel,
                "kind": "file",
                "size": size,
                "children": [],
            })
        return items

    tree = visit(root, "")
    return tree, file_count, total_size


# ── Bulk collect — for "click workspace → start chat" ────────────────

# Caps tuned for code review: a typical Java/Python/TS service has
# dozens of source files plus a long tail of config. The previous
# "smallest first" sort kept controllers + services + DAOs OUT of
# the bundle in favour of pom.xml, .properties, and empty POJOs,
# which meant the model never saw the actual business logic — and
# vulnerability questions came back as generic examples. We now
# walk source code FIRST and only fall back to scripts / templates /
# config when there's still room.
_BULK_MAX_FILES = 80
_BULK_MAX_BYTES_PER_FILE = 200 * 1024
_BULK_MAX_TOTAL_BYTES = int(2.5 * 1024 * 1024)

# Higher tier wins. The match is "first tier whose set contains the
# extension". Anything outside every tier still inside _TEXT_EXTS is
# treated as tier 99 (very last resort).
_FILE_TIERS: list[set[str]] = [
    # Tier 0: real source code — what the model actually needs to
    # see for a vulnerability / review answer.
    {
        ".py", ".java", ".kt", ".rs", ".go", ".c", ".cpp", ".cc", ".h",
        ".hpp", ".cs", ".rb", ".php", ".ts", ".tsx", ".jsx", ".js",
        ".mjs", ".cjs", ".vue", ".svelte", ".swift", ".scala",
        ".groovy", ".dart", ".lua", ".pl",
    },
    # Tier 1: queries + shell scripts (also high-risk for injection
    # and command-execution review).
    {".sql", ".sh", ".bash", ".zsh"},
    # Tier 2: server-rendered templates — JSP / HTML / XML with
    # potential XSS surface.
    {".jsp", ".jspx", ".html", ".htm", ".xml", ".xsd", ".xsl",
     ".tag", ".tld"},
    # Tier 3: stylesheets (much lower risk but occasionally useful).
    {".css", ".scss", ".sass"},
    # Tier 4: config files — picked LAST so they don't crowd out
    # source code under the cap.
    {".json", ".jsonl", ".yaml", ".yml", ".toml", ".ini", ".cfg",
     ".conf", ".properties", ".gradle"},
    # Tier 5: docs.
    {".md", ".markdown", ".txt", ".csv", ".tsv"},
]
# Path hints that bump a candidate's priority within its tier — code
# review almost always cares more about auth/controller/dao layers
# than DTOs or generated stubs.
_NAME_HINTS_BOOST = (
    "auth", "controller", "service", "dao", "mapper", "repository",
    "security", "login", "session", "password", "token", "api",
    "endpoint", "handler", "route", "middleware",
)
_PATH_HINTS_PENALTY = (
    # Directory matches only — "/example" without a trailing slash
    # used to false-positive on Java's "com.example" package, which
    # ranks the actual application code BELOW config files. Same
    # caveat for "/sample" vs sampler libraries, etc.
    "/test/", "/tests/", "/__tests__/", "/spec/", "/specs/",
    "/example/", "/examples/", "/sample/", "/samples/",
    "/mocks/", "/__mocks__/",
    "/docs/", "/generated/", "/build/", "/dist/", "/vendor/",
    ".test.", ".spec.", ".min.",
)


def _tier_of(ext: str) -> int:
    for i, group in enumerate(_FILE_TIERS):
        if ext in group:
            return i
    return 99


def _name_boost(rel_path: str) -> int:
    """Lower number == higher priority. Returns a small adjustment
    that tips the sort within a tier toward security-relevant files."""
    lower = rel_path.lower()
    boost = 0
    if any(h in lower for h in _NAME_HINTS_BOOST):
        boost -= 1
    if any(h in lower for h in _PATH_HINTS_PENALTY):
        boost += 2
    return boost


def collect_workspace_files(root: Path) -> dict:
    """Walk the workspace and return a representative slice + manifest
    metadata. Picking order:
      1. tier (source code → ... → docs)
      2. name/path hint (auth/controller/dao first, tests/examples last)
      3. larger source files first inside the same tier so a real
         service implementation wins over an empty marker class.

    The result is what gets stuffed into the chat as attachments on
    every turn of a code-focused session, so the priority directly
    drives whether vulnerability questions touch real code or fall
    back to generic boilerplate."""
    all_candidates: list[tuple[int, int, int, Path]] = []
    total_files_in_repo = 0

    def visit(d: Path) -> None:
        nonlocal total_files_in_repo
        try:
            entries = list(d.iterdir())
        except OSError:
            return
        for entry in entries:
            if entry.is_symlink():
                continue
            if entry.name in _SKIP_DIRS:
                continue
            if entry.is_dir():
                visit(entry)
                continue
            if not entry.is_file():
                continue
            total_files_in_repo += 1
            try:
                size = entry.stat().st_size
            except OSError:
                continue
            if size == 0 or size > _BULK_MAX_BYTES_PER_FILE:
                continue
            ext = entry.suffix.lower()
            if ext not in _TEXT_EXTS:
                continue
            try:
                rel = entry.relative_to(root).as_posix()
            except ValueError:
                continue
            tier = _tier_of(ext) + _name_boost(rel)
            # Bigger source files inside the same tier rank higher —
            # they're more likely to hold the actual logic the
            # reviewer needs to see.
            inv_size = -size
            all_candidates.append((tier, inv_size, size, entry))

    visit(root)
    all_candidates.sort(key=lambda x: (x[0], x[1]))

    files: list[dict] = []
    total_bytes = 0
    for _tier, _inv, size, path in all_candidates:
        if len(files) >= _BULK_MAX_FILES:
            break
        if total_bytes + size > _BULK_MAX_TOTAL_BYTES:
            continue  # try smaller files later in the loop
        try:
            blob = path.read_bytes()
        except OSError:
            continue
        if b"\x00" in blob[:8192]:
            continue
        for enc in ("utf-8", "utf-8-sig", "cp949", "euc-kr", "latin-1"):
            try:
                text = blob.decode(enc)
                break
            except UnicodeDecodeError:
                continue
        else:
            text = blob.decode("utf-8", errors="replace")
        try:
            rel = path.relative_to(root).as_posix()
        except ValueError:
            continue
        files.append({"path": rel, "text": text, "size": size})
        total_bytes += size

    return {
        "files": files,
        "truncated": len(files) < total_files_in_repo,
        "total_files": len(files),
        "total_size": total_bytes,
        "total_files_in_repo": total_files_in_repo,
    }


# ── File read ─────────────────────────────────────────────────────────

_MAX_VIEW_BYTES = 2 * 1024 * 1024  # 2 MB cap for the file viewer


def read_file(root: Path, rel_path: str) -> dict:
    # Defence in depth — make sure the requested path is inside `root`
    # and doesn't escape via ".." or absolute paths.
    target = (root / rel_path).resolve()
    try:
        target.relative_to(root)
    except ValueError:
        raise ValueError("workspace 범위를 벗어난 경로입니다")
    if not target.exists() or not target.is_file():
        raise FileNotFoundError(rel_path)
    size = target.stat().st_size
    if size > _MAX_VIEW_BYTES:
        return {
            "path": rel_path,
            "text": f"[파일이 너무 큽니다: {size:,} bytes — viewer 한도 "
                    f"{_MAX_VIEW_BYTES:,}]",
            "size": size,
            "truncated": True,
            "method": "too-large",
        }
    ext = target.suffix.lower()
    blob = target.read_bytes()
    if ext not in _TEXT_EXTS and b"\x00" in blob[:8192]:
        return {
            "path": rel_path,
            "text": "[binary content — viewer skipped]",
            "size": size,
            "truncated": False,
            "method": "binary-skipped",
        }
    for enc in ("utf-8", "utf-8-sig", "cp949", "euc-kr", "latin-1"):
        try:
            text = blob.decode(enc)
            break
        except UnicodeDecodeError:
            continue
    else:
        text = blob.decode("utf-8", errors="replace")
    return {
        "path": rel_path,
        "text": text,
        "size": size,
        "truncated": False,
        "method": "text",
    }


# ── Background task helpers ───────────────────────────────────────────

_BACKGROUND_TASKS: set[asyncio.Task] = set()


async def _run_in_thread(func, *args):
    return await asyncio.get_running_loop().run_in_executor(None, func, *args)


def remove_repo(local_path: str) -> int:
    """rm -rf the working copy. Returns the bytes freed (best effort)."""
    if not local_path:
        return 0
    p = Path(local_path)
    if not p.exists():
        return 0
    total = 0
    for f in p.rglob("*"):
        try:
            if f.is_file():
                total += f.stat().st_size
        except OSError:
            continue
    shutil.rmtree(p, ignore_errors=True)
    return total
