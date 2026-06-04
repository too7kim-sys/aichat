"""Filesystem + git ops for code workspaces.

Phase 1 scope:
  - clone_repo(): authenticated git clone into a per-user dir
  - sync_repo():  git fetch + reset --hard origin/<branch>
  - walk_tree():  build a nested tree for the file browser
  - read_file():  safe text read with size limits
  - remove_repo(): rm -rf the working dir

Phase 2 (LLM patch flow):
  - apply_file_write():   write LLM-generated content to a workspace file
  - git_status_porcelain(): list dirty files (M/A/D/??)
  - git_diff():           textual diff (working tree vs HEAD)
  - git_commit():         add + commit with explicit author identity
  - git_push():           push to origin using the stored credentials
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


def validate_local_folder(raw: str) -> Path:
    """For the "local folder" workspace source. Resolve the supplied
    path (expanding `~`), confirm it sits inside one of the configured
    allow-list roots, and return the resolved absolute Path.

    Raises ValueError with a user-facing message on any failure. The
    feature is intentionally disabled by default — an empty allow-list
    means we refuse to register any local folder, so a misconfigured
    server can't be tricked into exposing /etc or /home.
    """
    s = (raw or "").strip()
    if not s:
        raise ValueError("폴더 경로를 입력하세요")
    roots = settings.workspace_local_root_list
    if not roots:
        raise ValueError(
            "로컬 폴더 소스가 비활성화되어 있습니다. "
            "관리자에게 WORKSPACE_LOCAL_ROOTS 환경변수 설정을 요청하세요."
        )
    # Expand ~ first, then resolve symlinks. We resolve(strict=False) so
    # the error for a missing directory is our own clearer message
    # below, not a cryptic PermissionError from pathlib.
    expanded = Path(os.path.expanduser(s))
    if not expanded.is_absolute():
        raise ValueError("절대 경로를 입력하세요 (예: /home/user/projects/foo)")
    resolved = expanded.resolve()
    allowed = False
    for root in roots:
        root_path = Path(root).resolve()
        try:
            resolved.relative_to(root_path)
            allowed = True
            break
        except ValueError:
            continue
    if not allowed:
        raise ValueError(
            "허용된 루트 안의 경로만 등록할 수 있습니다. "
            f"허용 루트: {', '.join(roots)}"
        )
    if not resolved.exists():
        raise ValueError(f"존재하지 않는 경로입니다: {resolved}")
    if not resolved.is_dir():
        raise ValueError(f"폴더가 아닙니다: {resolved}")
    return resolved


def is_git_workdir(root: Path) -> bool:
    """True iff `root/.git` exists. Used to decide whether commit/push
    are meaningful for a local-folder source (they're only enabled
    when the registered directory is actually a git working tree)."""
    return (root / ".git").exists()


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


# ── Phase 2 — apply / status / diff / commit / push ───────────────────

_MAX_PATCH_BYTES = 2 * 1024 * 1024  # one applied file capped at 2 MB


def _safe_resolve(root: Path, rel_path: str) -> Path:
    """Resolve <root>/<rel_path> and refuse anything that escapes root
    via "..", absolute paths, symlinks. Also blocks writing under
    `.git/` so a hostile patch can't rewrite git internals."""
    rel = (rel_path or "").strip().lstrip("/\\")
    if not rel:
        raise ValueError("경로가 비어 있습니다")
    if len(rel) > 500:
        raise ValueError("경로가 너무 깁니다")
    target = (root / rel).resolve()
    try:
        target.relative_to(root)
    except ValueError:
        raise ValueError("workspace 범위를 벗어난 경로입니다")
    parts = {p.lower() for p in target.relative_to(root).parts}
    if ".git" in parts:
        raise ValueError(".git 내부는 수정할 수 없습니다")
    return target


def apply_file_write(root: Path, rel_path: str, content: str) -> dict:
    """Overwrite (or create) `rel_path` with `content`. Returns
    {path, size, created} for the UI. The file content is written as
    UTF-8 with a trailing newline preserved if the caller included it.

    No git operation runs here — staging happens at commit time, so
    `git status` will report the file as modified/untracked until the
    user actually commits it."""
    encoded = content.encode("utf-8")
    if len(encoded) > _MAX_PATCH_BYTES:
        raise ValueError(
            f"파일이 너무 큽니다: {len(encoded):,}B > {_MAX_PATCH_BYTES:,}B"
        )
    target = _safe_resolve(root, rel_path)
    created = not target.exists()
    target.parent.mkdir(parents=True, exist_ok=True)
    # Atomic write — write to a temp sibling then rename, so a crash
    # mid-write doesn't leave a half-truncated source file behind.
    tmp = target.with_suffix(target.suffix + ".aichat-tmp")
    try:
        tmp.write_bytes(encoded)
        os.replace(tmp, target)
    finally:
        if tmp.exists():
            try:
                tmp.unlink()
            except OSError:
                pass
    return {
        "path": rel_path,
        "size": len(encoded),
        "created": created,
    }


# Single-letter codes from `git status --porcelain` that we surface to
# the UI. Anything else (renamed, copied, unmerged, etc.) is reported
# verbatim — those are rare and the user can read the raw status text.
_STATUS_LABELS = {
    "M": "modified",
    "A": "added",
    "D": "deleted",
    "R": "renamed",
    "C": "copied",
    "U": "unmerged",
    "?": "untracked",
    "!": "ignored",
}


def _parse_status_line(line: str) -> dict | None:
    """Parse one porcelain v1 record. Returns {path, x, y, status,
    label} or None for malformed lines."""
    if len(line) < 4 or line[2] != " ":
        return None
    x, y = line[0], line[1]
    rest = line[3:]
    # Renames look like `R  old -> new` — keep the new path so the
    # user sees what they'll commit.
    if " -> " in rest:
        rest = rest.split(" -> ", 1)[1]
    rest = rest.strip().strip('"')
    if not rest:
        return None
    primary = x.strip() or y.strip() or "?"
    return {
        "path": rest,
        "x": x,
        "y": y,
        "status": primary,
        "label": _STATUS_LABELS.get(primary, primary),
    }


def git_status_porcelain(root: Path) -> list[dict]:
    """List dirty files as `[{path, x, y, status, label}, ...]`.
    Empty list = clean working tree."""
    if not (root / ".git").exists():
        raise RuntimeError("이 워크스페이스는 git 저장소가 아닙니다")
    rc, stderr = _run_git(
        ["git", "status", "--porcelain=v1", "--no-renames"],
        cwd=root,
        timeout=30,
    )
    # _run_git only returns stderr; we need stdout, so run it again
    # capturing stdout directly. (Keeping _run_git as-is to avoid
    # touching the clone/sync codepath that's already in production.)
    proc = subprocess.run(
        ["git", "status", "--porcelain=v1", "--no-renames"],
        cwd=str(root),
        env={
            **os.environ,
            "GIT_TERMINAL_PROMPT": "0",
            "GIT_ASKPASS": "echo",
            "GIT_LFS_SKIP_SMUDGE": "1",
            "LC_ALL": "C",
        },
        capture_output=True,
        timeout=30,
        check=False,
    )
    if proc.returncode != 0:
        raise RuntimeError(
            f"git status 실패: {(proc.stderr or b'').decode('utf-8', 'replace').strip()[:200]}"
        )
    out = proc.stdout.decode("utf-8", errors="replace")
    entries: list[dict] = []
    for line in out.splitlines():
        parsed = _parse_status_line(line)
        if parsed:
            entries.append(parsed)
    return entries


def git_diff(root: Path, rel_path: str | None = None) -> str:
    """Diff of the working tree against HEAD. If `rel_path` is given,
    scope the diff to that single path. Returns the raw text — empty
    string means no changes for that scope.

    We include `--no-color` and `--text` so binary files don't dump
    Git's `Binary files differ` placeholder mid-stream (still possible
    for actual binary blobs but no terminal escapes).

    The result is capped at 256 KB so a thousand-line diff doesn't
    blow up the response payload."""
    if not (root / ".git").exists():
        raise RuntimeError("이 워크스페이스는 git 저장소가 아닙니다")
    cmd = ["git", "diff", "--no-color", "--text", "HEAD", "--"]
    if rel_path:
        safe = _safe_resolve(root, rel_path)
        cmd.append(safe.relative_to(root).as_posix())
    proc = subprocess.run(
        cmd,
        cwd=str(root),
        env={
            **os.environ,
            "GIT_TERMINAL_PROMPT": "0",
            "GIT_PAGER": "cat",
            "LC_ALL": "C",
        },
        capture_output=True,
        timeout=60,
        check=False,
    )
    if proc.returncode not in (0, 1):
        # `git diff` returns 1 if differences exist when --exit-code
        # is on; without --exit-code 0 is the normal value, but some
        # git versions still return 1 for "diff present". Treat 0/1
        # as success.
        raise RuntimeError(
            f"git diff 실패: {(proc.stderr or b'').decode('utf-8', 'replace').strip()[:200]}"
        )
    text = proc.stdout.decode("utf-8", errors="replace")
    cap = 256 * 1024
    if len(text) > cap:
        text = text[:cap] + f"\n\n[…잘림: 총 {len(proc.stdout):,} bytes, {cap:,} bytes 표시]"
    return text


def _git_identity_args(author_name: str, author_email: str) -> list[str]:
    """Build the `-c user.name=… -c user.email=…` args so commits are
    attributed to the chat user instead of whatever happens to be
    configured globally on the server (or worse: nothing, which makes
    `git commit` refuse to run)."""
    name = (author_name or "").strip() or "aichat user"
    email = (author_email or "").strip() or "aichat@localhost"
    # Disallow newlines/control chars — git would reject them anyway,
    # but we want a clean error instead of a cryptic one.
    if any(c in name for c in "\r\n") or any(c in email for c in "\r\n"):
        raise ValueError("author 정보에 줄바꿈을 포함할 수 없습니다")
    return [
        "-c", f"user.name={name[:120]}",
        "-c", f"user.email={email[:120]}",
        "-c", "commit.gpgsign=false",
    ]


def git_commit(
    root: Path,
    message: str,
    paths: list[str] | None,
    author_name: str,
    author_email: str,
) -> dict:
    """Stage `paths` (or everything dirty if None/empty) and create a
    commit. Returns {committed: bool, sha, summary, files: [paths]}.

    Behaviour:
      - empty message → ValueError
      - clean tree    → {committed: False, ...}
      - per-path safety: each entry is run through `_safe_resolve` so
        a hostile path can't reach outside the workspace.
    """
    if not (root / ".git").exists():
        raise RuntimeError("이 워크스페이스는 git 저장소가 아닙니다")
    msg = (message or "").strip()
    if not msg:
        raise ValueError("커밋 메시지가 비어 있습니다")
    if len(msg) > 4000:
        raise ValueError("커밋 메시지가 너무 깁니다 (4000자 한도)")

    # Validate paths first — fail fast if any is suspicious.
    rel_paths: list[str] = []
    if paths:
        for p in paths:
            safe = _safe_resolve(root, p)
            rel_paths.append(safe.relative_to(root).as_posix())

    if rel_paths:
        rc, stderr = _run_git(
            ["git", "add", "--", *rel_paths], cwd=root, timeout=60
        )
    else:
        rc, stderr = _run_git(["git", "add", "-A"], cwd=root, timeout=60)
    if rc != 0:
        raise RuntimeError(
            f"git add 실패: {stderr.decode('utf-8', 'replace').strip()[:200]}"
        )

    # Check whether anything is actually staged before committing —
    # `git commit` would otherwise error out with exit 1.
    proc = subprocess.run(
        ["git", "diff", "--cached", "--name-only"],
        cwd=str(root),
        env={**os.environ, "LC_ALL": "C"},
        capture_output=True,
        timeout=30,
        check=False,
    )
    staged = [
        l.strip() for l in proc.stdout.decode("utf-8", "replace").splitlines() if l.strip()
    ]
    if not staged:
        return {"committed": False, "sha": None, "summary": None, "files": []}

    identity = _git_identity_args(author_name, author_email)
    cmd = ["git", *identity, "commit", "-m", msg]
    rc, stderr = _run_git(cmd, cwd=root, timeout=60)
    if rc != 0:
        raise RuntimeError(
            f"git commit 실패: {stderr.decode('utf-8', 'replace').strip()[:200]}"
        )

    # Grab the new HEAD sha + first-line of subject for the response.
    sha_proc = subprocess.run(
        ["git", "rev-parse", "HEAD"],
        cwd=str(root),
        capture_output=True,
        timeout=10,
        check=False,
    )
    sha = sha_proc.stdout.decode("utf-8", "replace").strip()[:40] if sha_proc.returncode == 0 else None
    return {
        "committed": True,
        "sha": sha,
        "summary": msg.splitlines()[0][:200],
        "files": staged,
    }


def git_push(
    root: Path,
    git_url: str,
    branch: str,
    username: str | None,
    token: str | None,
) -> dict:
    """Push the current branch to origin.

    Two flows:
      - `git_url` set (clone source): build an in-memory URL with the
        decrypted token embedded and push to that. The on-disk remote
        config stays clean, so a token rotation doesn't leak.
      - `git_url` empty (local-folder source): trust the working tree's
        own `origin` remote and let git use whatever auth the user has
        already configured at the OS level (SSH keys, credential
        helper, etc.). We don't touch the URL.

    Returns {pushed: bool, branch}. Raises RuntimeError on push failure
    with the credential masked out of the error text."""
    if not (root / ".git").exists():
        raise RuntimeError(
            "이 폴더는 git 저장소가 아닙니다 (push하려면 .git 워킹트리가 필요합니다)"
        )
    if branch and not _REF_RE.match(branch):
        raise ValueError("branch 형식이 올바르지 않습니다")

    use_inline_url = bool(git_url)
    if use_inline_url:
        _validate_git_url(git_url)

    # Figure out the active branch if the caller didn't pin one.
    target_branch = branch
    if not target_branch:
        proc = subprocess.run(
            ["git", "rev-parse", "--abbrev-ref", "HEAD"],
            cwd=str(root),
            capture_output=True,
            timeout=10,
            check=False,
        )
        target_branch = (proc.stdout.decode("utf-8", "replace").strip() or "HEAD")
    if target_branch == "HEAD":
        raise RuntimeError("detached HEAD 상태에서는 push할 수 없습니다")

    if use_inline_url:
        url = _auth_url(git_url, username, token)
        cmd = ["git", "push", url, f"HEAD:{target_branch}"]
    else:
        # Local-folder source: push to whatever `origin` is set to in
        # the working tree. Confirm `origin` exists first so we can
        # surface a helpful error instead of git's terse one.
        proc = subprocess.run(
            ["git", "remote"],
            cwd=str(root),
            capture_output=True,
            timeout=10,
            check=False,
        )
        remotes = {
            r.strip()
            for r in proc.stdout.decode("utf-8", "replace").splitlines()
            if r.strip()
        }
        if "origin" not in remotes:
            raise RuntimeError(
                "이 로컬 폴더에 origin remote가 설정되어 있지 않습니다 "
                "(`git remote add origin <URL>`로 먼저 등록하세요)"
            )
        cmd = ["git", "push", "origin", f"HEAD:{target_branch}"]
    rc, stderr = _run_git(cmd, cwd=root, timeout=300)
    if rc != 0:
        detail = stderr.decode("utf-8", errors="replace")
        if token:
            detail = detail.replace(quote(token, safe=""), "***")
            detail = detail.replace(token, "***")
        raise RuntimeError(f"git push 실패: {detail.strip()[:300]}")

    return {"pushed": True, "branch": target_branch}


def git_revert_file(root: Path, rel_path: str) -> dict:
    """Discard local changes to `rel_path` — reset it back to HEAD.
    Untracked files are removed; tracked-but-modified files are reset
    to their committed state. Returns {path, removed} so the UI can
    update its dirty-file list."""
    if not (root / ".git").exists():
        raise RuntimeError("이 워크스페이스는 git 저장소가 아닙니다")
    target = _safe_resolve(root, rel_path)
    rel = target.relative_to(root).as_posix()

    # Is the file tracked? `git ls-files --error-unmatch` exits 0 for
    # tracked paths, non-zero for untracked.
    proc = subprocess.run(
        ["git", "ls-files", "--error-unmatch", "--", rel],
        cwd=str(root),
        capture_output=True,
        timeout=10,
        check=False,
    )
    tracked = proc.returncode == 0

    if tracked:
        rc, stderr = _run_git(
            ["git", "checkout", "HEAD", "--", rel], cwd=root, timeout=30
        )
        if rc != 0:
            raise RuntimeError(
                f"파일 되돌리기 실패: {stderr.decode('utf-8', 'replace').strip()[:200]}"
            )
        return {"path": rel, "removed": False}
    # Untracked — just delete it from the working tree if it exists.
    if target.exists() and target.is_file():
        target.unlink()
    return {"path": rel, "removed": True}
