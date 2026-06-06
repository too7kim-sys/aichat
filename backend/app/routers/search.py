"""Global chat search — single endpoint that scans every message the
caller owns and returns short snippets the UI can render in a result
list. Matches against both message content and the attachment summary
column so a user can find "where did I attach quarterly-report.pdf"
in addition to plain text lookups.

Scope is the requesting user's sessions only — the join on
`sessions.user_id` prevents cross-tenant disclosure.
"""
from datetime import datetime
from typing import Literal

from fastapi import APIRouter, Depends
from pydantic import BaseModel
from sqlalchemy import or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from .. import models
from ..auth import get_current_user
from ..database import get_db

router = APIRouter(prefix="/api/search", tags=["search"])


class MessageSearchResult(BaseModel):
    message_id: str
    session_id: str
    session_title: str
    role: Literal["user", "assistant"]
    snippet: str
    created_at: datetime


def _make_snippet(content: str, query: str, width: int = 140) -> str:
    """Return a short window of `content` centred on the first match
    of `query` (case-insensitive). Adds leading/trailing ellipses
    when the window doesn't cover the whole string."""
    if not content:
        return ""
    if not query:
        return content[:width] + ("…" if len(content) > width else "")
    idx = content.lower().find(query.lower())
    if idx < 0:
        # Match was probably in attachments_summary, not the body —
        # surface the first slice of body so the row still has
        # context to render.
        return content[:width] + ("…" if len(content) > width else "")
    pad_left = 50
    pad_right = width - pad_left - len(query)
    if pad_right < 0:
        pad_right = 0
    start = max(0, idx - pad_left)
    end = min(len(content), idx + len(query) + pad_right)
    return (
        ("…" if start > 0 else "")
        + content[start:end]
        + ("…" if end < len(content) else "")
    )


@router.get("/messages", response_model=list[MessageSearchResult])
async def search_messages(
    q: str = "",
    limit: int = 50,
    user: models.User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    query = (q or "").strip()
    # Two-character floor stops trivial "a" / single-char queries from
    # walking the full message table on every keystroke.
    if len(query) < 2:
        return []
    if limit < 1:
        limit = 50
    if limit > 200:
        limit = 200
    like = f"%{query}%"
    stmt = (
        select(models.Message, models.Session.title)
        .join(models.Session, models.Session.id == models.Message.session_id)
        .where(models.Session.user_id == user.id)
        .where(
            or_(
                models.Message.content.ilike(like),
                models.Message.attachments_summary.ilike(like),
            )
        )
        .order_by(models.Message.created_at.desc())
        .limit(limit)
    )
    rows = (await db.execute(stmt)).all()
    return [
        MessageSearchResult(
            message_id=m.id,
            session_id=m.session_id,
            session_title=(title or "(제목 없음)"),
            role=m.role if m.role in ("user", "assistant") else "user",
            snippet=_make_snippet(m.content or "", query),
            created_at=m.created_at,
        )
        for m, title in rows
    ]
