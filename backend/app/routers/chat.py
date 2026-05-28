import asyncio
import json
import time
from collections.abc import AsyncIterator

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload
from sse_starlette.sse import EventSourceResponse

from .. import models, schemas
from ..database import SessionLocal, get_db
from ..providers.base import ChatMessage, LLMProvider
from ..providers.registry import enabled_providers, get_provider

router = APIRouter(prefix="/api/sessions", tags=["chat"])

_SENTINEL = object()


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
    history: list[ChatMessage] = []
    for m in session.messages:
        # In compare mode multiple assistant messages share a turn; keep only the
        # most recent assistant reply per turn by using the last one before each
        # user message. For MVP simplicity we include all in chronological order.
        history.append(ChatMessage(role=m.role, content=m.content))
    history.append(ChatMessage(role="user", content=new_user_prompt))
    return history


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
        yield "error", json.dumps(
            {"provider": provider.name, "message": str(exc)}, ensure_ascii=False
        )


@router.post("/{session_id}/chat")
async def chat_single(
    session_id: str,
    payload: schemas.ChatRequest,
    db: AsyncSession = Depends(get_db),
):
    if not payload.provider:
        raise HTTPException(400, "provider is required for single chat")
    provider = get_provider(payload.provider)
    if provider is None or not provider.enabled:
        raise HTTPException(400, f"provider '{payload.provider}' not available")

    session = await _load_session(db, session_id)
    history = _build_history(session, payload.prompt)
    captured: dict[str, tuple[str, int]] = {}
    chunks: list[str] = []
    start = time.monotonic()

    async def event_gen():
        try:
            async for evt, data in _stream_one(provider, history):
                if evt == "token":
                    chunks.append(json.loads(data)["delta"])
                yield {"event": evt, "data": data}
        finally:
            captured[provider.name] = (
                "".join(chunks),
                int((time.monotonic() - start) * 1000),
            )
            await _persist_messages(session_id, payload.prompt, captured)

    return EventSourceResponse(event_gen())


async def _merge_streams(
    providers: list[LLMProvider], history: list[ChatMessage]
) -> AsyncIterator[tuple[str, str]]:
    """Round-robin merge of multiple provider streams into one event stream."""
    queues: dict[str, asyncio.Queue] = {p.name: asyncio.Queue() for p in providers}

    async def runner(p: LLMProvider) -> None:
        async for evt, data in _stream_one(p, history):
            await queues[p.name].put((evt, data))
        await queues[p.name].put(_SENTINEL)

    tasks = [asyncio.create_task(runner(p)) for p in providers]
    remaining = set(queues.keys())

    try:
        while remaining:
            # Wait for any queue to have an item
            get_tasks = {
                asyncio.create_task(queues[name].get()): name for name in remaining
            }
            done, pending = await asyncio.wait(
                get_tasks.keys(), return_when=asyncio.FIRST_COMPLETED
            )
            for t in done:
                name = get_tasks[t]
                item = t.result()
                if item is _SENTINEL:
                    remaining.discard(name)
                else:
                    yield item
            for t in pending:
                t.cancel()
    finally:
        for t in tasks:
            t.cancel()


@router.post("/{session_id}/compare")
async def chat_compare(
    session_id: str,
    payload: schemas.ChatRequest,
    db: AsyncSession = Depends(get_db),
):
    providers = enabled_providers()
    if not providers:
        raise HTTPException(503, "no providers configured")

    session = await _load_session(db, session_id)
    history = _build_history(session, payload.prompt)

    buffers: dict[str, list[str]] = {p.name: [] for p in providers}
    timings: dict[str, int] = {}
    start = time.monotonic()

    async def event_gen():
        try:
            async for evt, data in _merge_streams(providers, history):
                obj = json.loads(data)
                pname = obj.get("provider")
                if evt == "token" and pname in buffers:
                    buffers[pname].append(obj.get("delta", ""))
                if evt == "done" and pname:
                    timings[pname] = obj.get("latency_ms", 0)
                yield {"event": evt, "data": data}
        finally:
            results = {
                name: (
                    "".join(parts),
                    timings.get(name, int((time.monotonic() - start) * 1000)),
                )
                for name, parts in buffers.items()
            }
            await _persist_messages(session_id, payload.prompt, results)

    return EventSourceResponse(event_gen())
