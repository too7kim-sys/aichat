"""Shallow-clone a public Git repo on the server, extract source files,
and return them as attachment-shaped records for the chat to analyze.

Security guardrails:
  - http(s) URLs only
  - host allowlist (github / gitlab / bitbucket / codeberg)
  - --depth 1 --single-branch --no-tags + GIT_TERMINAL_PROMPT=0 so the
    server never blocks on credentials or runs hooks
  - 60 s timeout, 100-file cap, 200 KB-per-file cap
  - tempdir cleaned on every exit path
"""
from __future__ import annotations

import asyncio
import os
import shutil
import subprocess
import tempfile
from pathlib import Path
from urllib.parse import urlparse

from fastapi import APIRouter, Depends, HTTPException
from pydantic import AnyHttpUrl, BaseModel, Field

from .. import models
from ..auth import get_current_user
from ..files import ExtractError, extract

router = APIRouter(prefix="/api/repo", tags=["repo"])

_ALLOWED_HOSTS = {
    "github.com",
    "raw.githubusercontent.com",
    "gitlab.com",
    "bitbucket.org",
    "codeberg.org",
    "git.sr.ht",
}

_SKIP_DIRS = {
    "node_modules", ".git", ".venv", "venv", "__pycache__",
    "dist", "build", ".next", ".cache", ".vite", ".turbo",
    ".idea", ".vscode", "target", ".pytest_cache", ".mypy_cache",
    "coverage", ".nuxt", "out", "vendor",
}
_ALLOWED_EXT = {
    ".py", ".js", ".ts", ".tsx", ".jsx", ".mjs", ".cjs",
    ".java", ".kt", ".rs", ".go", ".c", ".cpp", ".h", ".hpp",
    ".cs", ".rb", ".php", ".sh", ".bash", ".zsh", ".sql",
    ".css", ".scss", ".html", ".htm", ".xml", ".json", ".jsonl",
    ".yaml", ".yml", ".toml", ".ini", ".cfg",
    ".md", ".markdown", ".txt", ".log", ".csv", ".tsv",
    ".vue", ".svelte", ".astro",
}
# Larger limits to take advantage of high-memory Ollama hosts (e.g.
# MSI EdgeXpert / DGX Spark with 128 GB unified memory). For modest
# machines you can lower these without affecting correctness; the
# attachments router caps the per-attachment char count separately.
_MAX_FILES = 300
_MAX_BYTES_PER_FILE = 500 * 1024
_CLONE_TIMEOUT = 60


def _run_git_clone(
    cmd: list[str], env: dict[str, str], timeout: int
) -> tuple[int, bytes]:
    """Synchronous git clone helper run in a threadpool.

    Using subprocess.run via run_in_executor instead of
    asyncio.create_subprocess_exec, because the latter raises
    NotImplementedError on Windows when uvicorn is using the default
    SelectorEventLoop. subprocess.run works everywhere.

    Return codes:
      >= 0 : git's own exit code
      -1   : timeout
      -2   : git binary not found on PATH
    """
    try:
        proc = subprocess.run(
            cmd,
            env=env,
            capture_output=True,
            timeout=timeout,
            check=False,
        )
        return proc.returncode, proc.stderr or b""
    except subprocess.TimeoutExpired as exc:
        err = exc.stderr if isinstance(exc.stderr, bytes) else b""
        return -1, err
    except FileNotFoundError:
        return -2, b"git executable not found on server PATH"


class CloneRequest(BaseModel):
    url: AnyHttpUrl
    ref: str | None = Field(
        default=None,
        max_length=120,
        description="Branch / tag / commit. Defaults to the repo's default branch.",
    )


class CloneFile(BaseModel):
    filename: str
    text: str
    char_count: int
    method: str


class CloneResponse(BaseModel):
    files: list[CloneFile]
    skipped: dict[str, int]
    repo: str


@router.post("/clone", response_model=CloneResponse)
async def clone_repo(
    payload: CloneRequest,
    _user: models.User = Depends(get_current_user),
):
    parsed = urlparse(str(payload.url))
    if parsed.scheme not in ("http", "https"):
        raise HTTPException(400, "Only http(s) URLs are allowed")
    if parsed.hostname not in _ALLOWED_HOSTS:
        raise HTTPException(
            400,
            f"호스트 미허용: {parsed.hostname}. 허용: {', '.join(sorted(_ALLOWED_HOSTS))}",
        )

    tmpdir = tempfile.mkdtemp(prefix="chat-repo-")
    try:
        cmd = [
            "git", "clone",
            "--depth", "1",
            "--single-branch",
            "--no-tags",
            "--filter=blob:limit=1m",
        ]
        if payload.ref:
            cmd.extend(["--branch", payload.ref])
        cmd.extend([str(payload.url), tmpdir])

        env = {
            **os.environ,
            "GIT_TERMINAL_PROMPT": "0",
            "GIT_ASKPASS": "echo",
            "GIT_LFS_SKIP_SMUDGE": "1",
        }
        loop = asyncio.get_running_loop()
        returncode, stderr = await loop.run_in_executor(
            None, _run_git_clone, cmd, env, _CLONE_TIMEOUT
        )
        if returncode == -1:
            raise HTTPException(504, "git clone timed out (60s)")
        if returncode == -2:
            raise HTTPException(
                500,
                "서버에 git이 설치되어 있지 않습니다. git을 설치한 뒤 다시 시도해주세요.",
            )
        if returncode != 0:
            detail = (stderr.decode("utf-8", errors="replace") or "").strip()
            raise HTTPException(400, f"git clone 실패: {detail[:300]}")

        root = Path(tmpdir)
        files: list[CloneFile] = []
        skipped = {"dir": 0, "ext": 0, "size": 0, "binary": 0, "limit": 0}

        for path in sorted(root.rglob("*")):
            if not path.is_file() or path.is_symlink():
                continue
            if len(files) >= _MAX_FILES:
                skipped["limit"] += 1
                continue
            rel = path.relative_to(root)
            if any(seg in _SKIP_DIRS for seg in rel.parts):
                skipped["dir"] += 1
                continue
            if path.suffix.lower() not in _ALLOWED_EXT:
                skipped["ext"] += 1
                continue
            try:
                size = path.stat().st_size
            except OSError:
                continue
            if size > _MAX_BYTES_PER_FILE:
                skipped["size"] += 1
                continue
            try:
                blob = path.read_bytes()
                result = extract(str(rel), blob)
            except ExtractError:
                skipped["binary"] += 1
                continue
            except Exception:
                continue
            files.append(
                CloneFile(
                    filename=str(rel).replace("\\", "/"),
                    text=result.text,
                    char_count=result.char_count,
                    method=result.method,
                )
            )

        repo_label = parsed.path.strip("/").removesuffix(".git") or parsed.netloc
        return CloneResponse(files=files, skipped=skipped, repo=repo_label)
    finally:
        shutil.rmtree(tmpdir, ignore_errors=True)
