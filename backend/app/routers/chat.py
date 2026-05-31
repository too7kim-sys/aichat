import json
import time
from collections.abc import AsyncIterator

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload
from sse_starlette.sse import EventSourceResponse

from .. import models, schemas
from ..database import SessionLocal, get_db
from ..config import settings
from ..providers.base import ChatMessage, LLMProvider
from ..providers.registry import get_provider
from ..search import TavilyError, format_as_context
from ..search import search as tavily_search

router = APIRouter(prefix="/api/sessions", tags=["chat"])


async def _load_session(db: AsyncSession, session_id: str) -> models.Session:
    result = await db.execute(
        select(models.Session)
        .where(models.Session.id == session_id)
        .options(selectinload(models.Session.messages))
    )
    session = result.scalar_one_or_none()
    if not session:
        raise HTTPException(404, "session not found")
    return session


def _build_history(session: models.Session, new_user_prompt: str) -> list[ChatMessage]:
    # Sliding window: keep only the last N persisted messages so the
    # context length sent to Ollama doesn't grow unbounded across a long
    # conversation. The new user prompt is always appended on top.
    limit = max(1, settings.max_history_messages)
    recent = list(session.messages)[-limit:]
    history: list[ChatMessage] = [
        ChatMessage(role=m.role, content=m.content) for m in recent
    ]
    history.append(ChatMessage(role="user", content=new_user_prompt))
    return history


_CODE_EXTS = {
    ".py", ".js", ".ts", ".tsx", ".jsx", ".java", ".kt", ".rs", ".go",
    ".c", ".cpp", ".h", ".hpp", ".cs", ".rb", ".php", ".sh", ".sql",
    ".css", ".scss", ".html", ".json", ".yaml", ".yml", ".toml",
}


def _attachments_message(
    attachments: list[schemas.AttachmentIn],
) -> ChatMessage | None:
    if not attachments:
        return None
    has_code = any(
        any(a.filename.lower().endswith(ext) for ext in _CODE_EXTS)
        for a in attachments
    )
    parts: list[str] = ["[Attached files]"]
    if has_code:
        parts.append(
            "When responding about code, prefer rendering full file contents in "
            "fenced code blocks tagged with the correct language (```python, "
            "```typescript, etc.) so the UI can pick them up as editable artifacts."
        )
    for a in attachments:
        parts.append(
            f"\n--- File: {a.filename} ({len(a.text)} chars) ---\n{a.text}"
        )
    return ChatMessage(role="system", content="\n".join(parts))


async def _run_web_search(prompt: str) -> tuple[ChatMessage | None, list[dict], str | None]:
    """Return (system_context_message, sources_for_ui, error_message)."""
    try:
        result = await tavily_search(prompt)
    except TavilyError as exc:
        return None, [], str(exc)
    except Exception as exc:  # noqa: BLE001 - network/parsing failures
        return None, [], f"{type(exc).__name__}: {exc}"
    context = format_as_context(result)
    sources = [
        {"title": r.get("title") or "", "url": r.get("url") or ""}
        for r in (result.get("results") or [])
        if r.get("url")
    ]
    return ChatMessage(role="system", content=context), sources, None


def _derive_title(prompt: str, limit: int = 40) -> str:
    cleaned = " ".join(prompt.split())
    if len(cleaned) <= limit:
        return cleaned
    return cleaned[:limit].rstrip() + "..."


async def _persist_messages(
    session_id: str,
    user_prompt: str,
    assistant_results: dict[str, tuple[str, int]],
) -> None:
    async with SessionLocal() as db:
        db.add(
            models.Message(
                session_id=session_id, role="user", content=user_prompt
            )
        )
        for provider_name, (content, latency_ms) in assistant_results.items():
            if not content:
                continue
            db.add(
                models.Message(
                    session_id=session_id,
                    role="assistant",
                    provider=provider_name,
                    content=content,
                    latency_ms=latency_ms,
                    tokens_out=len(content.split()),
                )
            )
        # Auto-title a fresh session on its very first user prompt. We
        # guard on both the default title and a zero existing message count
        # so a user who deliberately renames a session back to "New chat"
        # doesn't get clobbered on the next turn.
        result = await db.execute(
            select(models.Session).where(models.Session.id == session_id)
        )
        session = result.scalar_one_or_none()
        if session is not None and session.title == "New chat":
            existing_count = await db.scalar(
                select(func.count(models.Message.id)).where(
                    models.Message.session_id == session_id,
                    models.Message.role == "user",
                )
            )
            # The new user message we just added is included; treat 1 as first.
            if (existing_count or 0) <= 1:
                session.title = _derive_title(user_prompt)
        await db.commit()


async def _stream_one(
    provider: LLMProvider, history: list[ChatMessage]
) -> AsyncIterator[tuple[str, str]]:
    """Yield (event_type, data_json) tuples for a single provider."""
    start = time.monotonic()
    buf: list[str] = []
    try:
        async for delta in provider.stream(history):
            buf.append(delta)
            yield "token", json.dumps(
                {"provider": provider.name, "delta": delta}, ensure_ascii=False
            )
        latency_ms = int((time.monotonic() - start) * 1000)
        yield "done", json.dumps(
            {
                "provider": provider.name,
                "latency_ms": latency_ms,
                "tokens_out": len("".join(buf).split()),
            }
        )
    except Exception as exc:  # noqa: BLE001
        message = f"{type(exc).__name__}: {exc}"
        yield "error", json.dumps(
            {"provider": provider.name, "message": message}, ensure_ascii=False
        )


@router.post("/{session_id}/chat")
async def chat_single(
    session_id: str,
    payload: schemas.ChatRequest,
    db: AsyncSession = Depends(get_db),
):
    if not payload.provider:
        raise HTTPException(400, "provider is required")
    provider = get_provider(payload.provider)
    if provider is None or not provider.enabled:
        raise HTTPException(400, f"provider '{payload.provider}' not available")

    session = await _load_session(db, session_id)
    history = _build_history(session, payload.prompt)

    attach_msg = _attachments_message(payload.attachments)
    if attach_msg is not None:
        history.insert(0, attach_msg)

    search_sources: list[dict] = []
    search_error: str | None = None
    if payload.web_search:
        sys_msg, search_sources, search_error = await _run_web_search(payload.prompt)
        if sys_msg is not None:
            history.insert(0, sys_msg)

    captured: dict[str, tuple[str, int]] = {}
    chunks: list[str] = []
    start = time.monotonic()

    async def event_gen():
        try:
            if search_sources or search_error:
                yield {
                    "event": "sources",
                    "data": json.dumps(
                        {"sources": search_sources, "error": search_error},
                        ensure_ascii=False,
                    ),
                }
            async for evt, data in _stream_one(provider, history):
                if evt == "token":
                    chunks.append(json.loads(data)["delta"])
                elif evt == "error":
                    chunks.append(f"[error: {json.loads(data)['message']}]")
                yield {"event": evt, "data": data}
        finally:
            captured[provider.name] = (
                "".join(chunks),
                int((time.monotonic() - start) * 1000),
            )
            await _persist_messages(session_id, payload.prompt, captured)

    return EventSourceResponse(event_gen())
