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
_MAX_FILES = 100
_MAX_BYTES_PER_FILE = 200 * 1024
_CLONE_TIMEOUT = 60


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
        proc = await asyncio.create_subprocess_exec(
            *cmd,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
            env=env,
        )
        try:
            _, stderr = await asyncio.wait_for(
                proc.communicate(), timeout=_CLONE_TIMEOUT
            )
        except asyncio.TimeoutError:
            proc.kill()
            raise HTTPException(504, "git clone timed out (60s)")

        if proc.returncode != 0:
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
