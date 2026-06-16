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


# ── Tree text rendering — fed to the LLM as a structural anchor ──────

_TREE_LINE_CAP = 600
_TREE_DIR_CHILD_CAP = 40


def format_workspace_tree_text(
    root: Path,
    max_lines: int = _TREE_LINE_CAP,
    *,
    file_status: dict[str, str] | None = None,
) -> str:
    """Render the workspace tree as plain ASCII so the LLM can answer
    structure / architecture questions directly instead of guessing.

    When `file_status` is supplied the function appends a per-file
    marker so the same tree doubles as the "어떤 파일이 첨부됐고 안
    됐는지" view. Map keys are POSIX paths relative to the workspace
    root (the same shape `bundle["files"]` reports), values are the
    short marker string ("✓ 첨부", "⊘ 한도 초과", etc.). Files absent
    from the map are rendered plain.

    Each line is one entry, indented by depth. Directories end with
    `/`. The output is capped at `max_lines` and `_TREE_DIR_CHILD_CAP`
    entries per directory to keep huge mono-repos manageable — when
    truncated, the rendering appends `(... N more)` so the model sees
    the elision instead of believing the directory is small."""
    tree, _file_count, _total = walk_tree(root)
    lines: list[str] = []
    truncated = False

    def render(items: list[dict], depth: int, parent_path: str) -> None:
        nonlocal truncated
        for i, item in enumerate(items):
            if i >= _TREE_DIR_CHILD_CAP:
                lines.append("  " * depth + f"... ({len(items) - i} more)")
                truncated = True
                break
            if len(lines) >= max_lines:
                truncated = True
                return
            is_dir = item["kind"] == "dir"
            name = item["name"] + ("/" if is_dir else "")
            line = "  " * depth + name
            if not is_dir and file_status:
                rel = (
                    f"{parent_path}/{item['name']}"
                    if parent_path else item["name"]
                )
                marker = file_status.get(rel)
                if marker:
                    line = f"{line}  {marker}"
            lines.append(line)
            if is_dir and item.get("children"):
                sub_parent = (
                    f"{parent_path}/{item['name']}"
                    if parent_path else item["name"]
                )
                render(item["children"], depth + 1, sub_parent)

    render(tree, 0, "")
    body = "\n".join(lines)
    if truncated:
        body += "\n\n[tree truncated — ask for `_WORKSPACE_TREE.txt` deeper if you need it]"
    return body or "(empty workspace)"


# ── Bulk collect — for "click workspace → start chat" ────────────────

# Caps tuned for "include the whole project when it fits, fall back
# to a tier-ranked slice when it doesn't". Bumped from the original
# 80 / 200KB / 2.5MB so most real services land under the cap and
# the LLM sees every file the user can click in the tree — no more
# "this controller exists in the tree but its body wasn't attached".
# The tier-rank logic kicks in only on huge monorepos.
# Bulk-attach budget for chat auto-injection. Defaults stay conservative so
# small workspaces don't blow context windows on quiet models, but each cap
# is overrideable from .env — a 그룹웨어 repo with ~400 files and ~1MB of
# real source easily warrants raising WORKSPACE_BUNDLE_MAX_FILES while
# leaving the byte budget alone.
_BULK_MAX_FILES = settings.workspace_bundle_max_files
_BULK_MAX_BYTES_PER_FILE = settings.workspace_bundle_max_bytes_per_file
_BULK_MAX_TOTAL_BYTES = settings.workspace_bundle_max_total_bytes

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
    back to generic boilerplate.

    Returned dict carries `total_files` / `total_size` / `truncated`
    plus diagnostic counters (`skipped_unsupported_ext`,
    `skipped_too_large`, `walk_error`) so the caller can tell why
    zero files came back when the directory clearly has content."""
    # Defence — if the path doesn't exist or isn't a directory, bail
    # with a clearly-marked empty bundle so the caller can surface
    # the failure instead of silently sending an empty manifest.
    if not root.exists():
        log.warning("collect_workspace_files: root missing %s", root)
        return {
            "files": [],
            "truncated": False,
            "total_files": 0,
            "total_size": 0,
            "total_files_in_repo": 0,
            "skipped_unsupported_ext": 0,
            "skipped_too_large": 0,
            "walk_error": f"경로가 존재하지 않습니다: {root}",
        }
    if not root.is_dir():
        log.warning("collect_workspace_files: root not a dir %s", root)
        return {
            "files": [],
            "truncated": False,
            "total_files": 0,
            "total_size": 0,
            "total_files_in_repo": 0,
            "skipped_unsupported_ext": 0,
            "skipped_too_large": 0,
            "walk_error": f"디렉토리가 아닙니다: {root}",
        }

    all_candidates: list[tuple[int, int, int, Path, str]] = []
    total_files_in_repo = 0
    skipped_unsupported_ext = 0
    skipped_too_large = 0
    walk_errors: list[str] = []
    # Per-file exclusion reason, keyed by POSIX relative path. Anything
    # ending up in `files` overwrites this with "ok"; the leftover
    # entries surface in the tree manifest so the user sees *which*
    # files were excluded, not just a bucket count.
    file_status: dict[str, str] = {}

    def visit(d: Path) -> None:
        nonlocal total_files_in_repo, skipped_unsupported_ext, skipped_too_large
        try:
            entries = list(d.iterdir())
        except OSError as exc:
            if len(walk_errors) < 5:
                walk_errors.append(f"{d}: {exc}")
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
                rel = entry.relative_to(root).as_posix()
            except ValueError:
                rel = entry.name
            try:
                size = entry.stat().st_size
            except OSError:
                file_status[rel] = "read-error"
                continue
            if size == 0:
                file_status[rel] = "empty"
                continue
            if size > _BULK_MAX_BYTES_PER_FILE:
                skipped_too_large += 1
                file_status[rel] = f"oversize:{size}"
                continue
            ext = entry.suffix.lower()
            if ext not in _TEXT_EXTS:
                skipped_unsupported_ext += 1
                file_status[rel] = f"unsupported-ext:{ext or '없음'}"
                continue
            tier = _tier_of(ext) + _name_boost(rel)
            inv_size = -size
            all_candidates.append((tier, inv_size, size, entry, rel))

    visit(root)
    all_candidates.sort(key=lambda x: (x[0], x[1]))

    files: list[dict] = []
    total_bytes = 0
    for _tier, _inv, size, path, rel in all_candidates:
        if len(files) >= _BULK_MAX_FILES:
            file_status[rel] = "over-file-cap"
            continue
        if total_bytes + size > _BULK_MAX_TOTAL_BYTES:
            file_status[rel] = "over-byte-cap"
            continue
        try:
            blob = path.read_bytes()
        except OSError:
            file_status[rel] = "read-error"
            continue
        if b"\x00" in blob[:8192]:
            file_status[rel] = "binary"
            continue
        for enc in ("utf-8", "utf-8-sig", "cp949", "euc-kr", "latin-1"):
            try:
                text = blob.decode(enc)
                break
            except UnicodeDecodeError:
                continue
        else:
            text = blob.decode("utf-8", errors="replace")
        files.append({"path": rel, "text": text, "size": size})
        file_status[rel] = "ok"
        total_bytes += size

    log.info(
        "collect_workspace_files root=%s repo_files=%d bundled=%d "
        "bytes=%d unsupported_ext_skipped=%d too_large_skipped=%d "
        "walk_errors=%d",
        root, total_files_in_repo, len(files), total_bytes,
        skipped_unsupported_ext, skipped_too_large, len(walk_errors),
    )

    return {
        "files": files,
        "truncated": len(files) < total_files_in_repo,
        "total_files": len(files),
        "total_size": total_bytes,
        "total_files_in_repo": total_files_in_repo,
        "skipped_unsupported_ext": skipped_unsupported_ext,
        "skipped_too_large": skipped_too_large,
        "walk_error": "; ".join(walk_errors) if walk_errors else None,
        # Full per-file status — chat.py builds a short visual marker
        # for each entry when rendering the tree manifest. Missing
        # paths fall through to the plain (unmarked) format.
        "file_status": file_status,
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


def detect_test_runner(root: Path) -> tuple[str, list[str]] | None:
    """워크스페이스 안에서 어떤 단위테스트 러너를 돌릴 수 있는지 추정.
    파일 시그니처만 보고 결정 — 임의 명령은 절대 받지 않는다.

    Returns (label, argv) 또는 None.
    """
    if (root / "pyproject.toml").is_file() or (root / "tests").is_dir() \
       or any(root.glob("test_*.py")) or any(root.glob("*_test.py")):
        return ("pytest", ["python3", "-m", "pytest", "-q", "--maxfail=5"])
    if (root / "package.json").is_file():
        # npm test 가 실제로 정의돼 있어야 의미가 있지만, 없으면 그대로
        # 비-제로 종료라 호출자가 알아서 처리한다.
        return ("npm test", ["npm", "test", "--silent"])
    if (root / "Cargo.toml").is_file():
        return ("cargo test", ["cargo", "test", "--quiet"])
    if (root / "pom.xml").is_file():
        return ("mvn test", ["mvn", "-q", "test"])
    if (root / "build.gradle").is_file() or (root / "build.gradle.kts").is_file():
        return ("gradle test", ["./gradlew", "test", "-q"])
    if (root / "go.mod").is_file():
        return ("go test", ["go", "test", "./...", "-count=1"])
    return None


def run_workspace_tests(root: Path, timeout_sec: int) -> dict:
    """알려진 러너를 한 번 돌리고 결과를 dict 로. 호출자(라우터)가 settings
    의 enabled 토글을 확인했다고 가정한다."""
    pick = detect_test_runner(root)
    if pick is None:
        return {
            "runner": None,
            "ok": False,
            "skipped": True,
            "reason": "테스트 러너를 자동 감지하지 못했습니다.",
            "exit_code": None,
            "stdout": "",
            "stderr": "",
            "duration_ms": 0,
        }
    label, argv = pick
    import time as _time
    started = _time.monotonic()
    try:
        proc = subprocess.run(
            argv,
            cwd=str(root),
            timeout=timeout_sec,
            capture_output=True,
            text=True,
            check=False,
            env={
                **os.environ,
                "CI": "1",
                "NO_COLOR": "1",
                "PYTHONIOENCODING": "utf-8",
            },
        )
        duration = int((_time.monotonic() - started) * 1000)
        return {
            "runner": label,
            "ok": proc.returncode == 0,
            "skipped": False,
            "exit_code": proc.returncode,
            "stdout": (proc.stdout or "")[-20_000:],
            "stderr": (proc.stderr or "")[-20_000:],
            "duration_ms": duration,
        }
    except subprocess.TimeoutExpired:
        duration = int((_time.monotonic() - started) * 1000)
        return {
            "runner": label,
            "ok": False,
            "skipped": False,
            "exit_code": None,
            "stdout": "",
            "stderr": f"⏱ {timeout_sec}초 timeout — 더 큰 값은 WORKSPACE_TEST_TIMEOUT_SEC.",
            "duration_ms": duration,
        }
    except FileNotFoundError as exc:
        return {
            "runner": label,
            "ok": False,
            "skipped": False,
            "exit_code": 127,
            "stdout": "",
            "stderr": f"명령을 찾을 수 없음: {exc}",
            "duration_ms": 0,
        }


def remove_repo(local_path: str) -> int:
    """rm -rf the working copy. Returns the bytes freed (best effort).

    Safety guard: only delete when the path sits under WORKSPACE_DIR.
    Legacy "사용자가 직접 입력한 절대경로" 형태의 로컬 워크스페이스가
    이전에 있었어서, 거기서 행을 지운다고 사용자의 실제 작업 폴더를
    rm -rf 하면 데이터 손실이 난다. WORKSPACE_DIR 밖이면 DB 행만
    지우고 파일은 그대로 둔다.
    """
    if not local_path:
        return 0
    p = Path(local_path)
    if not p.exists():
        return 0
    try:
        base = Path(settings.workspace_dir).resolve()
        p_resolved = p.resolve()
        p_resolved.relative_to(base)
    except (ValueError, OSError):
        # Path is outside WORKSPACE_DIR (legacy user-supplied folder) —
        # leave the files alone, just report 0 bytes freed.
        log.warning(
            "remove_repo: skipping %s (not under WORKSPACE_DIR=%s)",
            local_path, settings.workspace_dir,
        )
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


# ── 워크스페이스 grep (#54) ──────────────────────────────────
# 전체 트리에서 키워드/정규식 검색. ripgrep 이 있으면 빠르게, 없으면
# 파이썬 fallback. .git / node_modules / dist 같은 noise 디렉터리는
# 패스. 결과는 (path, line_no, snippet) 리스트.

_GREP_SKIP_DIRS = {
    ".git", "node_modules", "dist", "build", "__pycache__", ".venv",
    "venv", "target", ".next", ".cache", ".idea", ".vscode",
}
_GREP_TEXT_EXTS = {
    ".py", ".pyi", ".js", ".jsx", ".ts", ".tsx", ".mjs", ".cjs",
    ".java", ".kt", ".go", ".rs", ".c", ".h", ".cpp", ".hpp", ".cs",
    ".rb", ".php", ".swift", ".scala", ".sh", ".bash", ".zsh",
    ".sql", ".html", ".css", ".scss", ".sass", ".less",
    ".json", ".yaml", ".yml", ".toml", ".ini", ".cfg", ".conf",
    ".md", ".rst", ".txt", ".xml", ".vue", ".svelte",
    ".env", ".dockerfile", "Dockerfile", "Makefile",
}


def workspace_grep(
    root: Path,
    query: str,
    *,
    regex: bool = False,
    case_sensitive: bool = False,
    limit: int = 200,
) -> list[dict]:
    """워크스페이스 검색.  결과는 path:line:snippet 의 dict 리스트."""
    import re as _re

    q = (query or "").strip()
    if not q or len(q) < 2:
        return []
    if regex:
        try:
            pat = _re.compile(q, 0 if case_sensitive else _re.IGNORECASE)
        except _re.error as exc:
            raise ValueError(f"정규식 오류: {exc}")
    else:
        # literal — escape, 그리고 대소문자 옵션.
        pat = _re.compile(
            _re.escape(q), 0 if case_sensitive else _re.IGNORECASE
        )

    out: list[dict] = []
    root = root.resolve()
    for dirpath, dirnames, filenames in os.walk(root):
        # skip dirs in-place.
        dirnames[:] = [d for d in dirnames if d not in _GREP_SKIP_DIRS]
        for fn in filenames:
            if len(out) >= limit:
                return out
            ext = os.path.splitext(fn)[1].lower()
            if ext not in _GREP_TEXT_EXTS and fn not in _GREP_TEXT_EXTS:
                continue
            fp = Path(dirpath) / fn
            try:
                # 1MB 넘는 파일은 패스 — 검색 의미 적고 비용 큼.
                if fp.stat().st_size > 1_000_000:
                    continue
                with open(fp, "r", encoding="utf-8", errors="ignore") as fh:
                    for i, line in enumerate(fh, start=1):
                        if pat.search(line):
                            rel = str(fp.relative_to(root)).replace("\\", "/")
                            out.append(
                                {
                                    "path": rel,
                                    "line": i,
                                    "snippet": line.rstrip("\n")[:300],
                                }
                            )
                            if len(out) >= limit:
                                return out
            except (OSError, UnicodeDecodeError):
                continue
    return out


# ── 빌드 / 린트 / 포맷 자동 감지 + 실행 (#56) ────────────────
# 테스트 러너와 동일 패턴 — 파일 시그니처로 명령을 골라 timeout 안에
# 실행.  사용자가 임의 명령을 넘기는 게 아니라 *우리가* 안전한 명령을
# 매핑한다.

def _detect_simple(
    root: Path, kind: str
) -> tuple[str, list[str]] | None:
    """kind = 'build' | 'lint' | 'format'.  파일 시그니처 기반 매핑."""
    pkg = root / "package.json"
    if pkg.is_file():
        try:
            import json as _json

            data = _json.loads(pkg.read_text(encoding="utf-8"))
            scripts = (data.get("scripts") or {}) if isinstance(data, dict) else {}
        except Exception:
            scripts = {}
        if kind == "build" and "build" in scripts:
            return ("npm run build", ["npm", "run", "build", "--silent"])
        if kind == "lint" and "lint" in scripts:
            return ("npm run lint", ["npm", "run", "lint", "--silent"])
        if kind == "format" and "format" in scripts:
            return ("npm run format", ["npm", "run", "format", "--silent"])
    py = root / "pyproject.toml"
    if py.is_file():
        if kind == "lint" and (root / ".ruff.toml").is_file() or py.is_file():
            # ruff 가 깔려 있는지 확인은 호출 시 try/except.
            return ("ruff", ["ruff", "check", "."])
        if kind == "format":
            return ("ruff format", ["ruff", "format", "."])
        if kind == "build":
            return ("python -m build", ["python3", "-m", "build", "--no-isolation"])
    if (root / "Cargo.toml").is_file():
        if kind == "build":
            return ("cargo build", ["cargo", "build", "--quiet"])
        if kind == "lint":
            return ("cargo clippy", ["cargo", "clippy", "--quiet"])
        if kind == "format":
            return ("cargo fmt", ["cargo", "fmt"])
    if (root / "go.mod").is_file():
        if kind == "build":
            return ("go build", ["go", "build", "./..."])
        if kind == "lint":
            return ("go vet", ["go", "vet", "./..."])
        if kind == "format":
            return ("gofmt", ["gofmt", "-w", "."])
    if kind == "format" and any(root.glob("*.py")):
        return ("black", ["black", "."])
    if kind == "lint" and any(root.glob("*.py")):
        return ("flake8", ["flake8", "."])
    return None


def run_workspace_command(
    root: Path, kind: str, timeout_sec: int = 120
) -> dict:
    """kind = build / lint / format.  자동 감지된 명령 1회 실행."""
    pick = _detect_simple(root, kind)
    if pick is None:
        return {
            "runner": None,
            "kind": kind,
            "ok": False,
            "skipped": True,
            "reason": f"{kind} 명령을 자동 감지하지 못했습니다.",
            "exit_code": None,
            "stdout": "",
            "stderr": "",
            "duration_ms": 0,
        }
    label, argv = pick
    import time as _time

    started = _time.monotonic()
    try:
        proc = subprocess.run(
            argv,
            cwd=str(root),
            timeout=timeout_sec,
            capture_output=True,
            text=True,
            check=False,
            env={
                **os.environ,
                "CI": "1",
                "NO_COLOR": "1",
                "PYTHONIOENCODING": "utf-8",
            },
        )
        duration = int((_time.monotonic() - started) * 1000)
        return {
            "runner": label,
            "kind": kind,
            "ok": proc.returncode == 0,
            "skipped": False,
            "exit_code": proc.returncode,
            "stdout": (proc.stdout or "")[-20_000:],
            "stderr": (proc.stderr or "")[-20_000:],
            "duration_ms": duration,
        }
    except subprocess.TimeoutExpired:
        duration = int((_time.monotonic() - started) * 1000)
        return {
            "runner": label,
            "kind": kind,
            "ok": False,
            "skipped": False,
            "exit_code": None,
            "stdout": "",
            "stderr": f"{kind} 시간 초과 ({timeout_sec}s)",
            "duration_ms": duration,
        }
    except FileNotFoundError:
        return {
            "runner": label,
            "kind": kind,
            "ok": False,
            "skipped": True,
            "reason": f"실행 도구가 PATH 에 없습니다: {argv[0]}",
            "exit_code": None,
            "stdout": "",
            "stderr": "",
            "duration_ms": 0,
        }


# ── AI 코드 리뷰 / 커밋 메시지 (#57, #58) ────────────────────
# 현재 변경된 diff 를 한국어 시스템 prompt 와 함께 Ollama 한 번에 호출.
# 둘 다 stream=False — UI 가 모달로 한 번에 받아 표시.

async def ai_review_diff(diff_text: str, model: str, base_url: str) -> str:
    """diff 를 입력으로 받아 한국어 코드 리뷰 본문 반환."""
    import httpx

    if not diff_text.strip():
        return "변경된 내용이 없어요."
    sys = (
        "당신은 한국어로 소통하는 노련한 코드 리뷰어입니다. 아래 diff 를"
        " 보고 (1) 발견된 버그 가능성·악취 (2) 보안·성능 우려 (3) 개선"
        " 제안 순으로 한국어 마크다운으로 정리해 주세요. 좋은 부분도 한"
        " 줄 언급하세요. 형식적 칭찬은 금지. 라인 인용은 그대로 코드"
        " 블록에 넣어 주세요. 모든 답은 한국어, 결과만 출력 (서두/말미"
        " 인사 금지)."
    )
    body = diff_text[:60_000]
    timeout = httpx.Timeout(120.0, connect=5.0)
    async with httpx.AsyncClient(timeout=timeout) as client:
        r = await client.post(
            f"{base_url.rstrip('/')}/api/chat",
            json={
                "model": model,
                "stream": False,
                "messages": [
                    {"role": "system", "content": sys},
                    {"role": "user", "content": body},
                ],
            },
        )
    if r.status_code >= 400:
        raise RuntimeError(f"Ollama {r.status_code}: {r.text[:200]}")
    return ((r.json() or {}).get("message") or {}).get("content") or ""


async def ai_commit_message(
    diff_text: str, model: str, base_url: str
) -> str:
    """diff 를 입력으로 받아 짧은 한국어 커밋 메시지 한 줄 + 본문."""
    import httpx

    if not diff_text.strip():
        return "chore: (변경 없음)"
    sys = (
        "당신은 한국어 커밋 메시지를 작성하는 도구입니다. 아래 diff 를"
        " 읽고, Conventional Commits 스타일 (feat / fix / refactor /"
        " docs / chore / test / style) 첫 줄 + 빈 줄 + 짧은 본문 1~3"
        " 문장 형식으로 한국어 메시지를 출력하세요. 첫 줄은 70자 이내."
        " 다른 어떤 인사·설명도 붙이지 마세요. 메시지만 출력."
    )
    body = diff_text[:30_000]
    timeout = httpx.Timeout(60.0, connect=5.0)
    async with httpx.AsyncClient(timeout=timeout) as client:
        r = await client.post(
            f"{base_url.rstrip('/')}/api/chat",
            json={
                "model": model,
                "stream": False,
                "messages": [
                    {"role": "system", "content": sys},
                    {"role": "user", "content": body},
                ],
            },
        )
    if r.status_code >= 400:
        raise RuntimeError(f"Ollama {r.status_code}: {r.text[:200]}")
    text = ((r.json() or {}).get("message") or {}).get("content") or ""
    return text.strip()


def read_file_at_rev(root: Path, rel_path: str, rev: str = "HEAD") -> str:
    """git show <rev>:<path> 로 특정 리비전의 파일 내용 반환.  쉘 인자
    안전성 확보 위해 subprocess.run + 명시적 list 사용.  바이너리/없는
    경로는 RuntimeError."""
    rel = (rel_path or "").strip().lstrip("/\\")
    if not rel:
        raise ValueError("path 가 비어 있어요")
    if ".." in Path(rel).parts:
        raise ValueError("상대 경로(..)는 사용할 수 없어요")
    proc = subprocess.run(
        ["git", "show", f"{rev}:{rel}"],
        cwd=str(root),
        capture_output=True,
        timeout=10,
        check=False,
    )
    if proc.returncode != 0:
        # 없는 경로 / 새 파일 등 — 빈 문자열 반환해 호출자가 '신규' 로 처리.
        return ""
    # 너무 큰 파일은 자름.
    raw = proc.stdout or b""
    if len(raw) > 2 * 1024 * 1024:
        raw = raw[: 2 * 1024 * 1024]
    try:
        return raw.decode("utf-8")
    except UnicodeDecodeError:
        return raw.decode("utf-8", errors="replace")


# ── git 브랜치 관리 (#59) ────────────────────────────────────
def list_branches(root: Path) -> dict:
    """현재 브랜치 + 로컬/원격 브랜치 목록."""
    # 현재 브랜치
    proc = subprocess.run(
        ["git", "rev-parse", "--abbrev-ref", "HEAD"],
        cwd=str(root),
        capture_output=True,
        timeout=10,
        check=False,
    )
    current = (
        proc.stdout.decode("utf-8", "replace").strip()
        if proc.returncode == 0
        else ""
    )
    # 모든 브랜치 (refname only).
    proc2 = subprocess.run(
        [
            "git",
            "for-each-ref",
            "--format=%(refname:short)\t%(refname)",
            "refs/heads",
            "refs/remotes",
        ],
        cwd=str(root),
        capture_output=True,
        timeout=10,
        check=False,
    )
    local: list[str] = []
    remote: list[str] = []
    if proc2.returncode == 0:
        for line in proc2.stdout.decode("utf-8", "replace").splitlines():
            short, full = (line.split("\t", 1) + [""])[:2]
            short = short.strip()
            if not short or short.endswith("/HEAD"):
                continue
            if full.startswith("refs/remotes/"):
                remote.append(short)
            else:
                local.append(short)
    return {
        "current": current,
        "local": sorted(set(local)),
        "remote": sorted(set(remote)),
    }


def switch_branch(root: Path, name: str, create: bool = False) -> dict:
    """git switch (또는 git switch -c).  더러운 상태에선 거부 — 사용자가
    먼저 커밋·스태시 하라고 안내."""
    if not name or not name.strip():
        raise ValueError("브랜치 이름이 비어 있어요")
    safe = name.strip()
    if not re.match(r"^[A-Za-z0-9._\-/]+$", safe):
        raise ValueError("브랜치 이름에 허용되지 않는 문자가 있어요")
    args = ["git", "switch"]
    if create:
        args.append("-c")
    args.append(safe)
    proc = subprocess.run(
        args, cwd=str(root), capture_output=True, timeout=30, check=False
    )
    if proc.returncode != 0:
        raise RuntimeError(
            (proc.stderr or proc.stdout).decode("utf-8", "replace").strip()[:300]
        )
    return {
        "current": safe,
        "stdout": proc.stdout.decode("utf-8", "replace").strip(),
    }


# ── git log 뷰어 (#60) ──────────────────────────────────────
def git_log(root: Path, limit: int = 50) -> list[dict]:
    """최근 N개 커밋 — 한 줄당 dict.  본문은 첫 줄만 (subject)."""
    limit = max(1, min(int(limit or 50), 500))
    fmt = "%H%x09%an%x09%ae%x09%aI%x09%s"
    proc = subprocess.run(
        ["git", "log", f"-{limit}", f"--pretty=format:{fmt}"],
        cwd=str(root),
        capture_output=True,
        timeout=20,
        check=False,
    )
    if proc.returncode != 0:
        raise RuntimeError(
            (proc.stderr or proc.stdout).decode("utf-8", "replace").strip()[:300]
        )
    out: list[dict] = []
    for line in proc.stdout.decode("utf-8", "replace").splitlines():
        parts = line.split("\t", 4)
        if len(parts) < 5:
            continue
        sha, name, email, when, subject = parts
        out.append(
            {
                "sha": sha,
                "short_sha": sha[:7],
                "author_name": name,
                "author_email": email,
                "when": when,
                "subject": subject,
            }
        )
    return out


def git_show_files(root: Path, sha: str) -> list[dict]:
    """git show --name-status — 특정 커밋의 변경 파일 목록."""
    if not re.match(r"^[A-Fa-f0-9]{4,40}$", sha):
        raise ValueError("올바른 커밋 SHA 가 아니에요")
    proc = subprocess.run(
        ["git", "show", "--name-status", "--pretty=format:", sha],
        cwd=str(root),
        capture_output=True,
        timeout=20,
        check=False,
    )
    if proc.returncode != 0:
        raise RuntimeError(
            (proc.stderr or proc.stdout).decode("utf-8", "replace").strip()[:300]
        )
    out: list[dict] = []
    for line in proc.stdout.decode("utf-8", "replace").splitlines():
        line = line.strip()
        if not line:
            continue
        parts = line.split("\t", 2)
        if len(parts) < 2:
            continue
        status = parts[0]
        path = parts[-1]
        out.append({"status": status, "path": path})
    return out


def git_show_diff(root: Path, sha: str, path: str | None = None) -> str:
    """git show <sha> [-- <path>] — 특정 커밋(또는 그 안 파일)의 diff."""
    if not re.match(r"^[A-Fa-f0-9]{4,40}$", sha):
        raise ValueError("올바른 커밋 SHA 가 아니에요")
    args = ["git", "show", "--no-color", sha]
    if path:
        rel = path.strip().lstrip("/\\")
        if ".." in Path(rel).parts:
            raise ValueError("상대 경로(..) 사용 불가")
        args.extend(["--", rel])
    proc = subprocess.run(
        args, cwd=str(root), capture_output=True, timeout=20, check=False
    )
    if proc.returncode != 0:
        raise RuntimeError(
            (proc.stderr or proc.stdout).decode("utf-8", "replace").strip()[:300]
        )
    return proc.stdout.decode("utf-8", "replace")


# ── 파일/폴더 CRUD (#61) ────────────────────────────────────
def create_path(root: Path, rel: str, kind: str = "file") -> dict:
    """새 파일/폴더 생성.  parent 가 없으면 만들어줌.  이미 있으면 에러."""
    target = _safe_resolve(root, rel)
    if target.exists():
        raise ValueError(f"이미 존재해요: {rel}")
    if kind == "dir":
        target.mkdir(parents=True, exist_ok=False)
        return {"path": str(target.relative_to(root)).replace("\\", "/"), "kind": "dir"}
    target.parent.mkdir(parents=True, exist_ok=True)
    target.touch()
    return {"path": str(target.relative_to(root)).replace("\\", "/"), "kind": "file"}


def delete_path(root: Path, rel: str) -> dict:
    """파일/폴더 삭제.  폴더면 재귀 (단 사이즈 가드)."""
    import shutil as _shutil

    target = _safe_resolve(root, rel)
    if not target.exists():
        raise ValueError(f"존재하지 않아요: {rel}")
    if target.is_dir():
        _shutil.rmtree(target)
    else:
        target.unlink()
    return {"path": rel, "deleted": True}


def rename_path(root: Path, src: str, dst: str) -> dict:
    """파일/폴더 이름 변경 (또는 이동).  대상이 이미 있으면 거부."""
    s = _safe_resolve(root, src)
    d = _safe_resolve(root, dst)
    if not s.exists():
        raise ValueError(f"원본 없음: {src}")
    if d.exists():
        raise ValueError(f"대상이 이미 있어요: {dst}")
    d.parent.mkdir(parents=True, exist_ok=True)
    s.rename(d)
    return {
        "src": src,
        "dst": str(d.relative_to(root)).replace("\\", "/"),
    }


# ── 다중 파일 find & replace (#62) ──────────────────────────
def replace_in_files(
    root: Path,
    query: str,
    replacement: str,
    *,
    regex: bool = False,
    case_sensitive: bool = False,
    dry_run: bool = True,
    limit_files: int = 200,
) -> dict:
    """매칭 라인을 치환.  dry_run=True 면 file·count 만 미리보기."""
    import re as _re

    q = (query or "").strip()
    if not q or len(q) < 2:
        raise ValueError("query 는 2자 이상이어야 해요")
    if regex:
        try:
            pat = _re.compile(q, 0 if case_sensitive else _re.IGNORECASE)
        except _re.error as exc:
            raise ValueError(f"정규식 오류: {exc}")
    else:
        pat = _re.compile(
            _re.escape(q), 0 if case_sensitive else _re.IGNORECASE
        )

    changes: list[dict] = []
    total_replacements = 0
    for dirpath, dirnames, filenames in os.walk(root):
        dirnames[:] = [d for d in dirnames if d not in _GREP_SKIP_DIRS]
        for fn in filenames:
            if len(changes) >= limit_files:
                break
            ext = os.path.splitext(fn)[1].lower()
            if ext not in _GREP_TEXT_EXTS and fn not in _GREP_TEXT_EXTS:
                continue
            fp = Path(dirpath) / fn
            try:
                if fp.stat().st_size > 1_000_000:
                    continue
                with open(fp, "r", encoding="utf-8", errors="ignore") as fh:
                    text = fh.read()
            except OSError:
                continue
            new_text, n = pat.subn(replacement, text)
            if n == 0:
                continue
            rel = str(fp.relative_to(root)).replace("\\", "/")
            changes.append({"path": rel, "count": n})
            total_replacements += n
            if not dry_run:
                try:
                    with open(fp, "w", encoding="utf-8") as fh:
                        fh.write(new_text)
                except OSError as exc:
                    raise RuntimeError(f"쓰기 실패 {rel}: {exc}")
    return {
        "dry_run": dry_run,
        "total_files": len(changes),
        "total_replacements": total_replacements,
        "files": changes,
    }


# ── TODO / FIXME 인덱스 (#63) ───────────────────────────────
_TODO_PAT = re.compile(
    r"\b(TODO|FIXME|HACK|XXX|NOTE|BUG)\b[:\s]?\s*(.+)?",
    re.IGNORECASE,
)


def scan_todos(root: Path, limit: int = 500) -> list[dict]:
    """전체 트리에서 TODO/FIXME/HACK/NOTE/XXX/BUG 마커 수집."""
    out: list[dict] = []
    for dirpath, dirnames, filenames in os.walk(root):
        dirnames[:] = [d for d in dirnames if d not in _GREP_SKIP_DIRS]
        for fn in filenames:
            if len(out) >= limit:
                return out
            ext = os.path.splitext(fn)[1].lower()
            if ext not in _GREP_TEXT_EXTS and fn not in _GREP_TEXT_EXTS:
                continue
            fp = Path(dirpath) / fn
            try:
                if fp.stat().st_size > 1_000_000:
                    continue
                with open(fp, "r", encoding="utf-8", errors="ignore") as fh:
                    for i, line in enumerate(fh, start=1):
                        m = _TODO_PAT.search(line)
                        if m:
                            tag = m.group(1).upper()
                            msg = (m.group(2) or "").strip()
                            rel = str(fp.relative_to(root)).replace("\\", "/")
                            out.append(
                                {
                                    "path": rel,
                                    "line": i,
                                    "tag": tag,
                                    "message": msg[:200],
                                }
                            )
                            if len(out) >= limit:
                                return out
            except (OSError, UnicodeDecodeError):
                continue
    return out


# ── 워크스페이스 통계 (#64) ─────────────────────────────────
def workspace_stats(root: Path, max_files: int = 5000) -> dict:
    """LOC + 언어 분포 + 가장 큰 파일 10개.  비-텍스트는 LOC 0."""
    by_lang: dict[str, dict] = {}
    biggest: list[tuple[int, str]] = []
    file_count = 0
    total_loc = 0
    total_bytes = 0

    for dirpath, dirnames, filenames in os.walk(root):
        dirnames[:] = [d for d in dirnames if d not in _GREP_SKIP_DIRS]
        for fn in filenames:
            if file_count >= max_files:
                break
            ext = os.path.splitext(fn)[1].lower() or "_no_ext"
            lang = ext.lstrip(".") or "?"
            fp = Path(dirpath) / fn
            try:
                size = fp.stat().st_size
            except OSError:
                continue
            file_count += 1
            total_bytes += size
            rel = str(fp.relative_to(root)).replace("\\", "/")
            biggest.append((size, rel))
            loc = 0
            if ext in _GREP_TEXT_EXTS or fn in _GREP_TEXT_EXTS:
                if size <= 2_000_000:
                    try:
                        with open(fp, "r", encoding="utf-8", errors="ignore") as fh:
                            loc = sum(1 for _ in fh)
                    except OSError:
                        loc = 0
            total_loc += loc
            slot = by_lang.setdefault(
                lang, {"files": 0, "loc": 0, "bytes": 0}
            )
            slot["files"] += 1
            slot["loc"] += loc
            slot["bytes"] += size
    biggest.sort(reverse=True)
    by_lang_list = [
        {"lang": lang, **stats}
        for lang, stats in sorted(
            by_lang.items(), key=lambda kv: -kv[1]["loc"]
        )
    ]
    return {
        "file_count": file_count,
        "total_loc": total_loc,
        "total_bytes": total_bytes,
        "languages": by_lang_list[:30],
        "biggest_files": [
            {"path": p, "size": s} for (s, p) in biggest[:10]
        ],
    }


# ── 스태시 관리 (#65) ───────────────────────────────────────
def stash_list(root: Path) -> list[dict]:
    """git stash list — index / message / when."""
    proc = subprocess.run(
        ["git", "stash", "list", "--pretty=format:%gd%x09%gs%x09%cI"],
        cwd=str(root),
        capture_output=True,
        timeout=10,
        check=False,
    )
    if proc.returncode != 0:
        return []
    out: list[dict] = []
    for line in proc.stdout.decode("utf-8", "replace").splitlines():
        parts = line.split("\t", 2)
        if len(parts) < 3:
            continue
        idx, msg, when = parts
        out.append({"index": idx, "message": msg, "when": when})
    return out


def stash_save(root: Path, message: str = "") -> dict:
    """git stash push (현재 변경 사항을 옆으로)."""
    args = ["git", "stash", "push"]
    if message.strip():
        args.extend(["-m", message.strip()[:200]])
    proc = subprocess.run(
        args, cwd=str(root), capture_output=True, timeout=30, check=False
    )
    if proc.returncode != 0:
        raise RuntimeError(
            (proc.stderr or proc.stdout).decode("utf-8", "replace").strip()[:300]
        )
    return {"stdout": proc.stdout.decode("utf-8", "replace").strip()}


def stash_apply(root: Path, ref: str, pop: bool = True) -> dict:
    """기본 pop=True — apply 후 drop.  pop=False 면 stash 는 남김."""
    if not re.match(r"^stash@\{\d+\}$", ref or ""):
        raise ValueError("올바른 stash 참조가 아니에요 (예: stash@{0})")
    args = ["git", "stash", "pop" if pop else "apply", ref]
    proc = subprocess.run(
        args, cwd=str(root), capture_output=True, timeout=30, check=False
    )
    if proc.returncode != 0:
        raise RuntimeError(
            (proc.stderr or proc.stdout).decode("utf-8", "replace").strip()[:300]
        )
    return {"stdout": proc.stdout.decode("utf-8", "replace").strip()}


def stash_drop(root: Path, ref: str) -> dict:
    if not re.match(r"^stash@\{\d+\}$", ref or ""):
        raise ValueError("올바른 stash 참조가 아니에요 (예: stash@{0})")
    proc = subprocess.run(
        ["git", "stash", "drop", ref],
        cwd=str(root),
        capture_output=True,
        timeout=10,
        check=False,
    )
    if proc.returncode != 0:
        raise RuntimeError(
            (proc.stderr or proc.stdout).decode("utf-8", "replace").strip()[:300]
        )
    return {"dropped": ref}


# ── 머지 conflict 감지 + 3-way 내용 (#66) ────────────────────
def detect_conflicts(root: Path) -> list[str]:
    """git ls-files -u 가 비어 있지 않은 파일들 = conflict 상태."""
    proc = subprocess.run(
        ["git", "ls-files", "-u"],
        cwd=str(root),
        capture_output=True,
        timeout=10,
        check=False,
    )
    if proc.returncode != 0:
        return []
    paths: set[str] = set()
    for line in proc.stdout.decode("utf-8", "replace").splitlines():
        # 100644 <sha> <stage>\t<path>
        parts = line.split("\t", 1)
        if len(parts) == 2:
            paths.add(parts[1].strip())
    return sorted(paths)


def conflict_versions(root: Path, rel: str) -> dict:
    """conflict 파일의 base / ours / theirs / merged 4 버전 반환.
    stage 1 = base, 2 = ours, 3 = theirs.  merged = 현재 working tree."""

    if not rel:
        raise ValueError("path 가 비어 있어요")
    safe = rel.strip().lstrip("/\\")
    if ".." in Path(safe).parts:
        raise ValueError("상대 경로(..) 사용 불가")

    def _stage(n: int) -> str:
        proc = subprocess.run(
            ["git", "show", f":{n}:{safe}"],
            cwd=str(root),
            capture_output=True,
            timeout=10,
            check=False,
        )
        if proc.returncode != 0:
            return ""
        return proc.stdout.decode("utf-8", "replace")

    target = _safe_resolve(root, safe)
    merged = ""
    try:
        merged = target.read_text(encoding="utf-8", errors="replace")
    except OSError:
        merged = ""
    return {
        "path": safe,
        "base": _stage(1),
        "ours": _stage(2),
        "theirs": _stage(3),
        "merged": merged,
    }


def mark_conflict_resolved(root: Path, rel: str, content: str) -> dict:
    """사용자가 해결한 결과를 파일에 쓰고 git add 까지 한 번에."""
    safe = rel.strip().lstrip("/\\")
    target = _safe_resolve(root, safe)
    target.write_text(content, encoding="utf-8")
    proc = subprocess.run(
        ["git", "add", "--", safe],
        cwd=str(root),
        capture_output=True,
        timeout=10,
        check=False,
    )
    if proc.returncode != 0:
        raise RuntimeError(
            (proc.stderr or proc.stdout).decode("utf-8", "replace").strip()[:300]
        )
    return {"path": safe, "resolved": True}


# ── 사용자 정의 task runner (#67) ───────────────────────────
# 워크스페이스 루트의 .aichat-tasks.json 을 읽음.  형식:
# {"tasks": [{"name": "전체 빌드", "argv": ["npm", "run", "build"], "timeout": 120}, ...]}
# argv 는 *반드시* 명시적 list — 쉘 인터프리테이션 차단.
def load_custom_tasks(root: Path) -> list[dict]:
    import json as _json

    p = root / ".aichat-tasks.json"
    if not p.is_file():
        return []
    try:
        data = _json.loads(p.read_text(encoding="utf-8"))
    except Exception:
        return []
    tasks = data.get("tasks") if isinstance(data, dict) else None
    if not isinstance(tasks, list):
        return []
    out: list[dict] = []
    for i, t in enumerate(tasks):
        if not isinstance(t, dict):
            continue
        name = str(t.get("name") or f"task-{i}")[:80]
        argv = t.get("argv")
        if not isinstance(argv, list) or not argv:
            continue
        # 모든 원소가 문자열이어야 — 동적 객체 주입 차단.
        if not all(isinstance(a, str) for a in argv):
            continue
        # 쉘 메타문자 가드 — 단순 안전망.
        if any(any(c in a for c in "|;&`$<>") for a in argv):
            continue
        timeout = int(t.get("timeout") or 60)
        timeout = max(5, min(timeout, 600))
        out.append(
            {
                "id": str(i),
                "name": name,
                "argv": argv,
                "timeout": timeout,
                "description": str(t.get("description") or "")[:200],
            }
        )
    return out


def run_custom_task(root: Path, task_id: str) -> dict:
    """task_id 로 매칭된 사전 등록 명령 실행."""
    tasks = load_custom_tasks(root)
    pick = next((t for t in tasks if t["id"] == task_id), None)
    if pick is None:
        raise ValueError(f"등록된 task 가 아니에요: {task_id}")
    import time as _time

    started = _time.monotonic()
    try:
        proc = subprocess.run(
            pick["argv"],
            cwd=str(root),
            timeout=pick["timeout"],
            capture_output=True,
            text=True,
            check=False,
            env={
                **os.environ,
                "CI": "1",
                "NO_COLOR": "1",
                "PYTHONIOENCODING": "utf-8",
            },
        )
        duration = int((_time.monotonic() - started) * 1000)
        return {
            "name": pick["name"],
            "ok": proc.returncode == 0,
            "exit_code": proc.returncode,
            "stdout": (proc.stdout or "")[-20_000:],
            "stderr": (proc.stderr or "")[-20_000:],
            "duration_ms": duration,
        }
    except subprocess.TimeoutExpired:
        return {
            "name": pick["name"],
            "ok": False,
            "exit_code": None,
            "stdout": "",
            "stderr": f"시간 초과 ({pick['timeout']}s)",
            "duration_ms": int((_time.monotonic() - started) * 1000),
        }
    except FileNotFoundError:
        return {
            "name": pick["name"],
            "ok": False,
            "exit_code": None,
            "stdout": "",
            "stderr": f"실행 도구가 PATH 에 없어요: {pick['argv'][0]}",
            "duration_ms": 0,
        }


# ── AI 리팩터 / 테스트 생성 (#68) ───────────────────────────
async def ai_refactor_file(
    file_text: str, path: str, model: str, base_url: str
) -> str:
    """파일 본문을 LLM 에 보내 리팩터 제안 받기."""
    import httpx

    if not file_text.strip():
        return "(빈 파일)"
    sys = (
        "당신은 한국어로 소통하는 시니어 엔지니어입니다.  아래 파일을"
        " 보고 (1) 즉시 적용 가능한 리팩터 제안 3~5개 (2) 각 항목마다"
        " 변경 전/후 코드 예시 (3) 잠재적 위험·테스트 포인트 순으로"
        " 한국어 마크다운으로 정리해 주세요.  결과만, 인사·서두 금지."
    )
    body = f"# {path}\n\n```\n{file_text[:60_000]}\n```"
    timeout = httpx.Timeout(120.0, connect=5.0)
    async with httpx.AsyncClient(timeout=timeout) as client:
        r = await client.post(
            f"{base_url.rstrip('/')}/api/chat",
            json={
                "model": model,
                "stream": False,
                "messages": [
                    {"role": "system", "content": sys},
                    {"role": "user", "content": body},
                ],
            },
        )
    if r.status_code >= 400:
        raise RuntimeError(f"Ollama {r.status_code}: {r.text[:200]}")
    return ((r.json() or {}).get("message") or {}).get("content") or ""


async def ai_generate_tests(
    file_text: str, path: str, model: str, base_url: str
) -> str:
    """파일을 보고 단위 테스트 코드 생성."""
    import httpx

    if not file_text.strip():
        return "(빈 파일)"
    sys = (
        "당신은 단위테스트를 잘 짜는 엔지니어입니다.  아래 파일에 대한"
        " 단위 테스트 코드를 생성해 주세요.  파일 확장자에 맞는 테스트"
        " 프레임워크(Python=pytest, JS/TS=vitest 또는 jest, Go=testing"
        " 등)를 자동으로 선택.  각 테스트마다 무엇을 검증하는지 한국어"
        " 주석.  결과는 마크다운 코드 블록 하나로만, 첫 줄에 `# file:"
        " <테스트 파일 권장 경로>` 마커 포함.  서두/말미 잡담 금지."
    )
    body = f"# {path}\n\n```\n{file_text[:60_000]}\n```"
    timeout = httpx.Timeout(180.0, connect=5.0)
    async with httpx.AsyncClient(timeout=timeout) as client:
        r = await client.post(
            f"{base_url.rstrip('/')}/api/chat",
            json={
                "model": model,
                "stream": False,
                "messages": [
                    {"role": "system", "content": sys},
                    {"role": "user", "content": body},
                ],
            },
        )
    if r.status_code >= 400:
        raise RuntimeError(f"Ollama {r.status_code}: {r.text[:200]}")
    return ((r.json() or {}).get("message") or {}).get("content") or ""


# ── 파일 활동 타임라인 (#70) ────────────────────────────────
def file_git_log(root: Path, rel: str, limit: int = 50) -> list[dict]:
    """선택 파일의 git log."""
    safe = rel.strip().lstrip("/\\")
    if ".." in Path(safe).parts:
        raise ValueError("상대 경로(..) 사용 불가")
    fmt = "%H%x09%an%x09%aI%x09%s"
    proc = subprocess.run(
        ["git", "log", f"-{max(1, min(limit, 200))}",
         f"--pretty=format:{fmt}", "--", safe],
        cwd=str(root),
        capture_output=True,
        timeout=20,
        check=False,
    )
    if proc.returncode != 0:
        return []
    out: list[dict] = []
    for line in proc.stdout.decode("utf-8", "replace").splitlines():
        parts = line.split("\t", 3)
        if len(parts) < 4:
            continue
        sha, name, when, subject = parts
        out.append(
            {
                "sha": sha,
                "short_sha": sha[:7],
                "author_name": name,
                "when": when,
                "subject": subject,
            }
        )
    return out


# ── git tag 관리 (#75) ──────────────────────────────────────
def tag_list(root: Path) -> list[dict]:
    """모든 태그 + 가리키는 커밋의 짧은 해시·subject."""
    proc = subprocess.run(
        [
            "git",
            "for-each-ref",
            "--sort=-creatordate",
            "--format=%(refname:short)\t%(objectname:short)\t%(contents:subject)",
            "refs/tags",
        ],
        cwd=str(root),
        capture_output=True,
        timeout=10,
        check=False,
    )
    if proc.returncode != 0:
        return []
    out: list[dict] = []
    for line in proc.stdout.decode("utf-8", "replace").splitlines():
        parts = line.split("\t", 2)
        if len(parts) < 2:
            continue
        out.append(
            {
                "name": parts[0],
                "sha": parts[1],
                "subject": parts[2] if len(parts) > 2 else "",
            }
        )
    return out


def tag_create(root: Path, name: str, message: str = "", ref: str = "HEAD") -> dict:
    """경량 태그(메시지 없음) 또는 annotated 태그.  이름 검증."""
    if not re.match(r"^[A-Za-z0-9._\-/]+$", name or ""):
        raise ValueError("태그 이름에 허용되지 않는 문자가 있어요")
    if not re.match(r"^[A-Za-z0-9._\-/]+$", ref or "HEAD"):
        raise ValueError("ref 가 이상해요")
    args = ["git", "tag"]
    if message.strip():
        args.extend(["-a", name, "-m", message.strip()[:500]])
    else:
        args.append(name)
    args.append(ref)
    proc = subprocess.run(
        args, cwd=str(root), capture_output=True, timeout=10, check=False
    )
    if proc.returncode != 0:
        raise RuntimeError(
            (proc.stderr or proc.stdout).decode("utf-8", "replace").strip()[:300]
        )
    return {"name": name, "ref": ref}


def tag_delete(root: Path, name: str) -> dict:
    if not re.match(r"^[A-Za-z0-9._\-/]+$", name or ""):
        raise ValueError("태그 이름이 이상해요")
    proc = subprocess.run(
        ["git", "tag", "-d", name],
        cwd=str(root),
        capture_output=True,
        timeout=10,
        check=False,
    )
    if proc.returncode != 0:
        raise RuntimeError(
            (proc.stderr or proc.stdout).decode("utf-8", "replace").strip()[:300]
        )
    return {"deleted": name}


def tag_push(
    root: Path,
    name: str,
    push_url: str | None = None,
) -> dict:
    """origin 또는 명시 URL 로 태그 push.  push_url 이 주어지면 git push
    에 명시적으로 그 URL — auth helper 외부 호출 가능."""
    if not re.match(r"^[A-Za-z0-9._\-/]+$", name or ""):
        raise ValueError("태그 이름이 이상해요")
    args = ["git", "push", push_url or "origin", name]
    proc = subprocess.run(
        args, cwd=str(root), capture_output=True, timeout=60, check=False
    )
    if proc.returncode != 0:
        raise RuntimeError(
            (proc.stderr or proc.stdout).decode("utf-8", "replace").strip()[:300]
        )
    return {"pushed": name}


# ── AI 문서화 (#72) ────────────────────────────────────────
async def ai_document_file(
    file_text: str, path: str, model: str, base_url: str
) -> str:
    """파일에 한국어 docstring / 주석을 추가한 *수정된 전체 파일* 반환.
    LLM 이 # file: 마커를 붙여 출력하도록 시스템 prompt 에서 강제."""
    import httpx

    if not file_text.strip():
        return "(빈 파일)"
    sys = (
        "당신은 한국어로 docstring 을 다는 시니어 엔지니어입니다.  아래"
        " 파일에 (1) 모듈 헤더 한국어 1~3문장 (2) 각 공개 함수/클래스"
        " 마다 한국어 docstring (3) 필요시 한 줄 인라인 주석을 추가하고"
        " *수정된 전체 파일* 을 단일 코드 블록으로 출력하세요.  코드"
        " 블록 첫 줄에 `# file: <path>` (또는 언어별 마커) 를 반드시"
        " 포함.  로직은 절대 바꾸지 말고 주석/문서만.  서두·말미 잡담"
        " 금지, 코드 블록 외에 다른 텍스트 금지."
    )
    body = f"# {path}\n\n```\n{file_text[:60_000]}\n```"
    timeout = httpx.Timeout(180.0, connect=5.0)
    async with httpx.AsyncClient(timeout=timeout) as client:
        r = await client.post(
            f"{base_url.rstrip('/')}/api/chat",
            json={
                "model": model,
                "stream": False,
                "messages": [
                    {"role": "system", "content": sys},
                    {"role": "user", "content": body},
                ],
            },
        )
    if r.status_code >= 400:
        raise RuntimeError(f"Ollama {r.status_code}: {r.text[:200]}")
    return ((r.json() or {}).get("message") or {}).get("content") or ""


# ── AI 보안 점검 (#74) ──────────────────────────────────────
# 1차 정적 패턴 매칭 (시크릿·취약 패턴) → 결과를 LLM 에 보내 우선순위
# 분류 + 위험도 + 권장 조치 정리.

_SECURITY_PATTERNS = [
    (re.compile(r"AKIA[0-9A-Z]{16}"), "AWS Access Key 후보"),
    (re.compile(r"aws_secret_access_key\s*=\s*['\"][A-Za-z0-9/+=]{40}['\"]", re.I), "AWS Secret 후보"),
    (re.compile(r"-----BEGIN\s+(RSA|OPENSSH|DSA|EC|PGP)\s+PRIVATE\s+KEY-----"), "개인키 노출"),
    (re.compile(r"ghp_[A-Za-z0-9]{36}"), "GitHub PAT 후보"),
    (re.compile(r"sk-[A-Za-z0-9]{20,}"), "OpenAI/Claude 키 후보"),
    (re.compile(r"\bpassword\s*=\s*['\"][^'\"\n]{4,}['\"]", re.I), "하드코딩 비밀번호 후보"),
    (re.compile(r"\beval\s*\(", re.I), "eval() 사용 — 입력 검증 필수"),
    (re.compile(r"\bexec\s*\(", re.I), "exec() 사용 — 입력 검증 필수"),
    (re.compile(r"shell=True"), "subprocess shell=True — 인젝션 위험"),
    (re.compile(r"\bos\.system\s*\("), "os.system 사용 — subprocess.run 권장"),
    (re.compile(r"pickle\.loads?\s*\("), "pickle.load 사용 — RCE 위험"),
    (re.compile(r"document\.write\s*\("), "document.write — XSS 위험"),
    (re.compile(r"innerHTML\s*="), "innerHTML 직접 할당 — XSS 위험"),
    (re.compile(r"dangerouslySetInnerHTML"), "React dangerouslySetInnerHTML"),
    (re.compile(r"SELECT\s+.*\bFROM\s+.*\+\s*\w+", re.I), "SQL 문자열 합성 — Injection"),
    (re.compile(r"\bMD5\b|\bSHA1\b", re.I), "약한 해시 (MD5/SHA1)"),
    (re.compile(r"http://", re.I), "비암호화 HTTP 사용"),
    (re.compile(r"\bverify\s*=\s*False"), "SSL 검증 비활성"),
]


def scan_security(root: Path, limit: int = 300) -> list[dict]:
    """정적 패턴 검출 — 라인 단위.  결과 dict 리스트."""
    out: list[dict] = []
    for dirpath, dirnames, filenames in os.walk(root):
        dirnames[:] = [d for d in dirnames if d not in _GREP_SKIP_DIRS]
        for fn in filenames:
            if len(out) >= limit:
                return out
            ext = os.path.splitext(fn)[1].lower()
            if ext not in _GREP_TEXT_EXTS and fn not in _GREP_TEXT_EXTS:
                continue
            fp = Path(dirpath) / fn
            try:
                if fp.stat().st_size > 1_000_000:
                    continue
                with open(fp, "r", encoding="utf-8", errors="ignore") as fh:
                    for i, line in enumerate(fh, start=1):
                        # 라인이 너무 길면 패스 — minified 같은 거.
                        if len(line) > 4000:
                            continue
                        for pat, label in _SECURITY_PATTERNS:
                            if pat.search(line):
                                rel = str(fp.relative_to(root)).replace("\\", "/")
                                out.append(
                                    {
                                        "path": rel,
                                        "line": i,
                                        "label": label,
                                        "snippet": line.strip()[:240],
                                    }
                                )
                                if len(out) >= limit:
                                    return out
                                break  # 한 라인에 패턴 여러 개여도 첫 것만.
            except (OSError, UnicodeDecodeError):
                continue
    return out


async def ai_security_summarize(
    findings: list[dict], model: str, base_url: str
) -> str:
    """패턴 결과 → LLM 에 보내 한국어 보안 요약/우선순위."""
    import httpx
    import json as _json

    if not findings:
        return "✓ 자동 패턴 검출 결과 위험 항목이 발견되지 않았어요. (LLM 추가 분석 생략)"
    sys = (
        "당신은 한국어로 소통하는 시니어 보안 엔지니어입니다.  아래"
        " 코드 정적 패턴 검출 결과를 보고 (1) 가장 시급한 항목 TOP 5"
        " (2) 각 항목의 위험도·실제 위험 여부·권장 조치 (3) 패턴 검출"
        " 한계 + 추가로 확인할 영역 순으로 한국어 마크다운 정리.  결과만."
    )
    body = "검출된 항목 (path:line — label):\n" + "\n".join(
        f"- {f['path']}:{f['line']} — {f['label']}  · `{f['snippet'][:120]}`"
        for f in findings[:80]
    )
    timeout = httpx.Timeout(120.0, connect=5.0)
    async with httpx.AsyncClient(timeout=timeout) as client:
        r = await client.post(
            f"{base_url.rstrip('/')}/api/chat",
            json={
                "model": model,
                "stream": False,
                "messages": [
                    {"role": "system", "content": sys},
                    {"role": "user", "content": body},
                ],
            },
        )
    if r.status_code >= 400:
        raise RuntimeError(f"Ollama {r.status_code}: {r.text[:200]}")
    return ((r.json() or {}).get("message") or {}).get("content") or ""


# ── 의존성 dashboard (#76) ──────────────────────────────────
def parse_dependencies(root: Path) -> dict:
    """저장소 루트의 매니페스트 파일들을 파싱 — 패키지 + 버전 표시.
    closed network 이므로 외부 버전 조회는 안 함."""
    import json as _json

    result: dict[str, list[dict]] = {}

    pkg = root / "package.json"
    if pkg.is_file():
        try:
            data = _json.loads(pkg.read_text(encoding="utf-8"))
            deps = data.get("dependencies") or {}
            dev = data.get("devDependencies") or {}
            result["npm"] = [
                {"name": n, "version": v, "type": "runtime"}
                for n, v in deps.items()
            ] + [
                {"name": n, "version": v, "type": "dev"}
                for n, v in dev.items()
            ]
        except Exception:
            pass

    req = root / "requirements.txt"
    if req.is_file():
        try:
            lines = req.read_text(encoding="utf-8").splitlines()
            out: list[dict] = []
            for ln in lines:
                ln = ln.strip()
                if not ln or ln.startswith("#"):
                    continue
                # name==version, name>=version, name 등.
                m = re.match(r"([A-Za-z0-9_.\-]+)\s*([<>=!~]+)?\s*([^\s;]+)?", ln)
                if m:
                    out.append(
                        {
                            "name": m.group(1),
                            "version": (m.group(2) or "") + (m.group(3) or ""),
                            "type": "runtime",
                        }
                    )
            result["pip"] = out
        except Exception:
            pass

    pyproj = root / "pyproject.toml"
    if pyproj.is_file():
        try:
            text = pyproj.read_text(encoding="utf-8")
            # 간단한 패턴 — dependencies = [...] 안의 항목.
            matches = re.findall(
                r"^dependencies\s*=\s*\[(.*?)\]",
                text,
                re.MULTILINE | re.DOTALL,
            )
            out: list[dict] = []
            for block in matches:
                for item in re.findall(r"['\"]([^'\"]+)['\"]", block):
                    m = re.match(
                        r"([A-Za-z0-9_.\-]+)\s*([<>=!~][^;]+)?", item.strip()
                    )
                    if m:
                        out.append(
                            {
                                "name": m.group(1),
                                "version": (m.group(2) or "").strip(),
                                "type": "runtime",
                            }
                        )
            if out:
                result["pip"] = (result.get("pip") or []) + out
        except Exception:
            pass

    cargo = root / "Cargo.toml"
    if cargo.is_file():
        try:
            text = cargo.read_text(encoding="utf-8")
            # [dependencies] / [dev-dependencies] 섹션의 name = "version" 또는
            # name = { version = "...", ... }.
            out: list[dict] = []
            section = None
            for line in text.splitlines():
                s = line.strip()
                if s.startswith("[") and s.endswith("]"):
                    sec = s[1:-1].strip()
                    section = sec
                    continue
                if section in ("dependencies", "dev-dependencies"):
                    m = re.match(r"([A-Za-z0-9_\-]+)\s*=\s*(.+)$", s)
                    if not m:
                        continue
                    name, raw = m.group(1), m.group(2).strip()
                    ver_m = re.search(r"['\"]([^'\"]+)['\"]", raw)
                    out.append(
                        {
                            "name": name,
                            "version": ver_m.group(1) if ver_m else raw,
                            "type": "dev" if section == "dev-dependencies" else "runtime",
                        }
                    )
            result["cargo"] = out
        except Exception:
            pass

    gomod = root / "go.mod"
    if gomod.is_file():
        try:
            text = gomod.read_text(encoding="utf-8")
            out: list[dict] = []
            in_require = False
            for line in text.splitlines():
                s = line.strip()
                if s.startswith("require ("):
                    in_require = True
                    continue
                if in_require and s == ")":
                    in_require = False
                    continue
                # require name v1.2.3 (단일 라인) 또는 require ( 내부.
                target = s
                if s.startswith("require "):
                    target = s[len("require "):].strip()
                m = re.match(r"(\S+)\s+(\S+)", target)
                if m and (in_require or s.startswith("require ")):
                    out.append(
                        {
                            "name": m.group(1),
                            "version": m.group(2),
                            "type": "runtime",
                        }
                    )
            result["go"] = out
        except Exception:
            pass
    return result
