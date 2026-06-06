"""Workflow runner — one-shot LLM call that materialises as a chat
session. Each run:

  1. Renders the prompt body with the workflow's variable values
  2. Creates a new chat Session owned by the workflow's user
  3. (optional) Retrieves RAG context from the workflow's project
  4. Streams the assistant reply through the Ollama provider
  5. Persists user + assistant messages
  6. Updates workflow status (last_run_at / status / session_id)

The result lives in the user's regular session list — when they open
the workflow's last session they see the rendered prompt and the AI
answer just like a normal chat. No special UI required for output."""
from __future__ import annotations

import asyncio
import json
import logging
import re
import time
from datetime import datetime, timezone

from sqlalchemy import select

from .. import models
from ..config import settings
from ..database import SessionLocal
from ..providers.base import ChatMessage
from ..providers.registry import get_provider

log = logging.getLogger("uvicorn.error")


_VAR_RE = re.compile(r"\{([a-zA-Z_][a-zA-Z0-9_]*)\}")


def extract_prompt_vars(body: str) -> list[str]:
    """Return the set of {var_name} placeholders found in the body,
    preserving first-occurrence order. Used by the form to render an
    input per variable."""
    seen: list[str] = []
    for m in _VAR_RE.finditer(body or ""):
        v = m.group(1)
        if v not in seen:
            seen.append(v)
    return seen


def render_prompt(body: str, values: dict | None) -> str:
    """Substitute {var} placeholders. Missing values stay as-is so the
    operator sees what they forgot to fill instead of silent blanks."""
    values = values or {}
    def _sub(m: re.Match) -> str:
        v = m.group(1)
        out = values.get(v)
        return str(out) if out is not None else m.group(0)
    return _VAR_RE.sub(_sub, body or "")


async def run_workflow(workflow_id: str) -> None:
    """Execute a single workflow run. Safe to call from a background
    task — exceptions are caught and recorded on the workflow row."""
    async with SessionLocal() as db:
        wf = await db.scalar(
            select(models.Workflow).where(models.Workflow.id == workflow_id)
        )
        if wf is None:
            log.warning("workflow runner: id=%s not found", workflow_id)
            return
        if not wf.enabled:
            log.info("workflow runner: id=%s disabled, skipping", workflow_id)
            return
        prompt = await db.scalar(
            select(models.Prompt).where(models.Prompt.id == wf.prompt_id)
        )
        if prompt is None:
            wf.last_run_status = "failed"
            wf.last_error = "prompt missing"
            wf.last_run_at = datetime.now(timezone.utc)
            await db.commit()
            return

        # Mark in-progress so the UI shows "running…" between ticks.
        wf.last_run_status = "running"
        wf.last_error = None
        await db.commit()

        try:
            session = await _execute_workflow(db, wf, prompt)
            wf.last_session_id = session.id
            wf.last_run_status = "ok"
            wf.last_error = None
        except Exception as exc:  # noqa: BLE001
            wf.last_run_status = "failed"
            wf.last_error = f"{type(exc).__name__}: {exc}"[:2000]
            log.exception("workflow %s failed: %s", workflow_id, exc)
        finally:
            wf.last_run_at = datetime.now(timezone.utc)
            await db.commit()


async def _execute_workflow(
    db,
    wf: models.Workflow,
    prompt: models.Prompt,
) -> models.Session:
    # 1) Render prompt
    values = None
    if wf.prompt_vars:
        try:
            values = json.loads(wf.prompt_vars)
        except Exception:  # noqa: BLE001
            values = None
    rendered = render_prompt(prompt.body, values).strip()
    if not rendered:
        raise RuntimeError("렌더된 프롬프트가 비어 있습니다")

    # 2) Create the session that holds this run's transcript
    ts = datetime.now(timezone.utc).strftime("%m-%d %H:%M")
    session = models.Session(
        user_id=wf.user_id,
        title=f"[자동] {wf.name} · {ts}",
        project_id=wf.project_id,
    )
    db.add(session)
    await db.flush()

    # 3) Persist the user-prompt message immediately so the UI can
    # show it the moment the session lands in the list (even if the
    # stream hasn't finished yet).
    user_msg = models.Message(
        session_id=session.id,
        role="user",
        content=rendered,
    )
    db.add(user_msg)
    await db.commit()

    # 4) Build the message stack — language pin + the user prompt.
    # We don't run the full chat router here (auto-routing, web search,
    # accuracy block, etc.) to keep the runner small; the prompt
    # itself carries any system instruction the operator wants.
    history: list[ChatMessage] = [
        ChatMessage(
            role="system",
            content=(
                "기본 답변 언어는 한국어입니다. 사용자가 영어 등 다른 "
                "언어로 질문해도 한국어로 답변하세요."
            ),
        ),
    ]

    # 5) Optional RAG retrieval from the workflow's linked project
    if wf.project_id:
        try:
            from ..rag.retriever import format_chunks_for_prompt, retrieve
            chunks = await retrieve(wf.project_id, rendered)
            if chunks:
                history.append(
                    ChatMessage(
                        role="system",
                        content=format_chunks_for_prompt(chunks),
                    )
                )
        except Exception as exc:  # noqa: BLE001
            log.warning("workflow RAG retrieve failed: %s", exc)

    history.append(ChatMessage(role="user", content=rendered))

    # 6) Stream the reply through Ollama (or whichever provider is
    # default). We collect the full text rather than streaming to
    # anyone — the session that lands at the end is the deliverable.
    provider = get_provider("ollama")
    if provider is None or not provider.enabled:
        raise RuntimeError("ollama provider 를 사용할 수 없습니다")
    model = wf.model or settings.ollama_model
    start = time.monotonic()
    buf: list[str] = []
    try:
        async for delta in provider.stream(history, model=model):
            buf.append(delta)
    except asyncio.CancelledError:
        raise
    latency_ms = int((time.monotonic() - start) * 1000)
    answer = "".join(buf).strip() or "(빈 응답)"

    assistant_msg = models.Message(
        session_id=session.id,
        role="assistant",
        provider=provider.name,
        content=answer,
        latency_ms=latency_ms,
        tokens_out=len(answer.split()),
    )
    db.add(assistant_msg)
    await db.commit()
    await db.refresh(session)
    return session
