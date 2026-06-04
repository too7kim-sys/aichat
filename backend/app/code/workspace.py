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
