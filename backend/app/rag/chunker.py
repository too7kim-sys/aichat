"""Line-based chunker — pragmatic v1.

For each file, emit overlapping windows of `chunk_lines` lines with
`overlap` lines of context carried into the next chunk. Stops at file
boundaries, so a chunk never crosses files (the model would lose
context). Tree-sitter / AST-aware chunking is the v2 path.
"""
from __future__ import annotations

from dataclasses import dataclass

from ..config import settings


@dataclass
class Chunk:
    filename: str
    start_line: int  # 1-indexed, inclusive
    end_line: int    # 1-indexed, inclusive
    text: str


def chunk_file(filename: str, body: str) -> list[Chunk]:
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
        # Prepend filename header so the embedding has filename signal
        # even when the chunk's interior doesn't mention the file.
        header = f"// {filename} (lines {i + 1}-{end})"
        text = header + "\n" + "\n".join(body_lines)
        out.append(
            Chunk(
                filename=filename,
                start_line=i + 1,
                end_line=end,
                text=text,
            )
        )
        if end == n:
            break
        i += step
    return out
