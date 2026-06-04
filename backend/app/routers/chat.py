import asyncio
import json
import time
from collections.abc import AsyncIterator

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload
from sse_starlette.sse import EventSourceResponse

from .. import models, schemas
from ..auth import get_current_user
from ..database import SessionLocal, get_db
from ..config import settings
from ..providers.base import ChatMessage, LLMProvider
from ..providers.registry import get_provider
from ..search import SearchError, format_as_context
from ..search import search as web_search

router = APIRouter(prefix="/api/sessions", tags=["chat"])

# Hold strong refs to detached persistence tasks so they aren't GC'd
# before they finish writing the partial response to the DB.
_BACKGROUND_PERSISTS: set = set()


async def _load_session(
    db: AsyncSession, session_id: str, user_id: str
) -> models.Session:
    result = await db.execute(
        select(models.Session)
        .where(models.Session.id == session_id, models.Session.user_id == user_id)
        .options(selectinload(models.Session.messages))
    )
    session = result.scalar_one_or_none()
    if not session:
        raise HTTPException(404, "session not found")
    return session


# Persistent system instruction that pins Korean as the default reply
# language. Inserted at the head of every chat request below.
_LANGUAGE_SYSTEM = ChatMessage(
    role="system",
    content=(
        "기본 답변 언어는 한국어입니다. 사용자가 영어 등 다른 언어로 질문해도 "
        "한국어로 답변하세요. 단, 사용자가 명시적으로 다른 언어를 요청한 경우"
        '(예: "in English please", "영어로 답해줘", "請用中文回答")만 그 언어로 '
        "응답합니다. 코드 식별자·라이브러리 이름 등 고유명사는 원어 그대로 두세요."
    ),
)


# Strict accuracy / anti-hallucination prompt. Toggled by
# settings.accuracy_strict (default true). The goal is to make the
# model say "I don't know" instead of inventing function names, file
# paths, line numbers, CVE IDs, or library behaviour it can't verify.
_ACCURACY_SYSTEM = ChatMessage(
    role="system",
    content=(
        "[정확성 규칙 — 매 답변에 적용]\n"
        "1. 모르면 모른다고 답하세요. \"확실하지 않습니다\", \"현재 자료로는 "
        "알 수 없습니다\"가 추측·일반론보다 항상 낫습니다. 안전하게 "
        "보이려고 모호한 표현으로 도망가지 마세요.\n"
        "2. 인용·식별자는 정확히. 함수명, 변수명, 클래스명, 파일 경로, 라인 "
        "번호, CVE 번호, API 시그니처를 만들어내지 마세요. 첨부 파일·검색 "
        "결과·이전 대화에 실제로 존재한 문자열만 인용하세요.\n"
        "3. 코드를 인용할 때는 첨부 본문 그대로 옮기세요. 한 글자라도 "
        "추측으로 채우지 마세요. 본문에 없는 줄을 \"있을 법한 모양\"으로 "
        "만들어 보이지 마세요.\n"
        "4. 모든 주장은 근거를 함께 제시하세요. 첨부 파일이 근거이면 "
        "`path:line`, 검색이 근거이면 출처 번호, 그 외에는 \"(일반 지식)\" "
        "또는 \"(추정)\"이라고 명시하세요.\n"
        "5. 라이브러리·프레임워크 동작이나 버전·옵션 이름은 외운 것을 "
        "단언하지 마세요. 정확한 값이 필요하면 \"공식 문서 확인 필요\"라고 "
        "표시하세요.\n"
        "6. 사용자 질문이 첨부 자료의 범위를 벗어나면, 범위 밖이라는 점을 "
        "먼저 밝히고 그 다음에 일반 지식 기반 답변임을 명시하세요.\n"
        "7. 한 답변 안에서 자기 모순을 만들지 마세요. 확신이 없으면 "
        "처음부터 \"확신 없음\"이라고 말하세요. 잘못된 단정 뒤에 사과하는 "
        "것보다 처음부터 정직하게 답하는 것이 신뢰를 만듭니다."
    ),
)


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


_FILE_MARKER_HELP = (
    "For every file you modify, output the COMPLETE updated file content "
    "in a fenced code block whose FIRST LINE is a marker:\n"
    "    # file: src/foo.py             (Python / Ruby / Shell / TOML / YAML)\n"
    "    // file: src/foo.ts            (JS / TS / Java / C / C++ / Go / Rust / CSS)\n"
    "    -- file: schema.sql            (SQL)\n"
    "    <!-- file: index.html -->      (HTML / XML / Vue / Svelte)\n"
    "Use the EXACT path shown in the attachment header — do not invent new "
    "paths. The UI uses this marker to render a 💾 download button so the "
    "user can drop the file back into their codebase. Snippets and diffs are "
    "fine for discussion, but FULL FILE blocks with the marker are required "
    "for any change you want the user to be able to apply."
)


def _attachments_message(
    attachments: list[schemas.AttachmentIn],
) -> ChatMessage | None:
    if not attachments:
        return None
    code_count = sum(
        1
        for a in attachments
        if any(a.filename.lower().endswith(ext) for ext in _CODE_EXTS)
    )
    # Multiple code files (>=3) almost certainly means the user is asking
    # for project-level analysis: read across files, flag bugs,
    # suggest improvements, propose refactors.
    is_project = code_count >= 3

    total_chars = sum(len(a.text) for a in attachments)
    parts: list[str] = [
        "[ATTACHED FILES — PRIMARY SOURCE OF TRUTH]",
        f"The user attached {len(attachments)} file(s), "
        f"{total_chars:,} characters total. These are the canonical "
        "material you must analyze. Findings about bugs, vulnerabilities, "
        "or improvements MUST cite a concrete `path:line` from these "
        "files — never generic best-practice advice and never web search "
        "results. Web search context, if present, is for cross-reference "
        "(CVE numbers, library docs) only.",
        "",
        "[금지 규칙 — 절대 다음과 같이 답하지 마세요]",
        "  - \"전체 코드를 살펴볼 필요가 있습니다\"",
        "  - \"제공된 코드가 제한적이므로\"",
        "  - \"일반적인 점검 항목에 대해 검토\"",
        "  - \"추가 정보가 필요합니다\" / \"더 많은 컨텍스트가 있어야\"",
        "  - \"실제 코드를 보지 않고는 정확히 말씀드리기 어렵습니다\"",
        f"위에 {len(attachments)}개 파일 ({total_chars:,}자)이 이미 제공되었습니다. "
        "이것이 1차 자료 전부이며, 충분합니다. 즉시 첫 번째 발견 사항을 "
        "`path:line` 인용으로 시작하세요. 발견이 없으면 \"검토 결과 "
        "<범주>에서 문제를 찾지 못했습니다\"라고 구체적으로 말하세요. "
        "절대로 일반론으로 회피하지 마세요.",
    ]
    if is_project:
        # Build a quick tree-like summary so the model knows the
        # structure before diving into individual files.
        paths = sorted(a.filename for a in attachments)
        parts.append(
            "The user attached a project for review. Structure your reply "
            "with explicit numbered sections so the user can watch progress "
            "while you stream:\n"
            "  ## 1단계: 분석\n"
            "     What the project does, the entry points, how the files "
            "connect. Keep it brief — 4-6 bullet points.\n"
            "  ## 2단계: 발견된 문제\n"
            "     각 발견은 아래 형식을 정확히 따르세요 — UI가 이 형식을 "
            "접이식 카드로 렌더링합니다. 형식이 깨지면 카드가 안 생기고 "
            "그냥 글덩어리로 보입니다.\n\n"
            "     ### [HIGH] 한 줄 제목 — path/to/file.ext:42\n"
            "     - **문제**: 무엇이 잘못되었는지 1-2문장.\n"
            "     - **위험**: 어떤 결과(데이터 유출, 권한 우회, 크래시 등)가 "
            "발생할 수 있는지.\n"
            "     - **수정**: 구체적 개선안. 코드 패치는 fenced 블록으로.\n\n"
            "     심각도는 HIGH / MEDIUM / LOW / INFO 중 하나. 라인 번호는 "
            "첨부 본문에서 실제로 확인한 위치만 쓰세요 — 만들어내지 마세요. "
            "라인을 특정할 수 없으면 `:?`로 둡니다 (예: `auth.py:?`).\n"
            "     발견이 정말로 없다면 새 카드를 만들지 말고 \"검토 결과 "
            "<범주>에서 문제를 찾지 못했습니다\"라고 한 문장으로만 답하세요. "
            "가짜 발견으로 채우지 마세요.\n"
            "  ## 3단계: 수정 제안\n"
            "     For each file you change, output the FULL updated content "
            "using the file: marker format below. If a fix is purely "
            "advisory (no code change yet), say so explicitly.\n\n"
            + _FILE_MARKER_HELP
            + "\n\nProject tree:\n"
            + "\n".join(f"  - {p}" for p in paths)
        )
    elif code_count > 0:
        parts.append(_FILE_MARKER_HELP)
    for a in attachments:
        parts.append(
            f"\n--- File: {a.filename} ({len(a.text)} chars) ---\n{a.text}"
        )
    return ChatMessage(role="system", content="\n".join(parts))


async def _run_web_search(prompt: str) -> tuple[ChatMessage | None, list[dict], str | None]:
    """Return (system_context_message, sources_for_ui, error_message)."""
    try:
        result = await web_search(prompt)
    except SearchError as exc:
        return None, [], str(exc)
    except Exception as exc:  # noqa: BLE001 - network/parsing failures
        return None, [], f"{type(exc).__name__}: {exc}"
    context = format_as_context(result)
    sources = [
        {
            "title": r.get("title") or "",
            "url": r.get("link") or "",
            "kind": r.get("kind") or "web",
            "image": r.get("image") or None,
            "snippet": r.get("snippet") or None,
            "mall": r.get("mall") or None,
            "lprice": r.get("lprice"),
            "displayLink": r.get("displayLink") or None,
        }
        for r in (result.get("items") or [])
        if r.get("link")
    ]
    # Bubble partial-provider failures (e.g., Google quota exceeded while
    # Naver still returned hits) so the user sees why some sections are
    # empty instead of silently missing.
    warnings = result.get("errors") or []
    warning = "; ".join(warnings) if warnings else None
    return ChatMessage(role="system", content=context), sources, warning


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
    provider: LLMProvider,
    history: list[ChatMessage],
    model: str | None = None,
) -> AsyncIterator[tuple[str, str]]:
    """Yield (event_type, data_json) tuples for a single provider."""
    start = time.monotonic()
    buf: list[str] = []
    try:
        async for delta in provider.stream(history, model=model):
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
    user: models.User = Depends(get_current_user),
):
    if not payload.provider:
        raise HTTPException(400, "provider is required")
    provider = get_provider(payload.provider)
    if provider is None or not provider.enabled:
        raise HTTPException(400, f"provider '{payload.provider}' not available")

    session = await _load_session(db, session_id, user.id)
    history = _build_history(session, payload.prompt)

    # Web search context first (front of the system stack). Attachments
    # come AFTER conversation history below so they sit right next to
    # the new user prompt — otherwise the model latches onto search
    # results when both are present.
    search_sources: list[dict] = []
    search_error: str | None = None
    if payload.web_search:
        sys_msg, search_sources, search_error = await _run_web_search(payload.prompt)
        if sys_msg is not None:
            history.insert(0, sys_msg)

    attach_msg = _attachments_message(payload.attachments)
    if attach_msg is not None:
        # Place the attachment context right BEFORE the new user prompt
        # (which _build_history appended as the final element). This
        # keeps the attached source as the freshest context the model
        # sees, ahead of any web search or stale conversation turns.
        history.insert(-1, attach_msg)

    # Optional per-deployment system prompt from .env (house style,
    # domain rules, escalation policy, ...). Goes near the front so
    # downstream system messages can still override specifics.
    extra = (settings.system_prompt_extra or "").strip()
    if extra:
        history.insert(0, ChatMessage(role="system", content=extra))

    # Anti-hallucination ruleset. Inserted in front of any other system
    # message so the model reads it first.
    if settings.accuracy_strict:
        history.insert(0, _ACCURACY_SYSTEM)

    # Pin the language preference at the very front so it always wins
    # over the model's own default behavior.
    history.insert(0, _LANGUAGE_SYSTEM)

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
            async for evt, data in _stream_one(provider, history, model=payload.model):
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
            # Shield the write so a client disconnect (user navigates to
            # another chat while the response is still streaming) doesn't
            # cancel the partial-response save mid-INSERT. The await is
            # still cancelled by the outer task, but the persistence task
            # keeps running to completion.
            persist = asyncio.create_task(
                _persist_messages(session_id, payload.prompt, captured)
            )
            try:
                await asyncio.shield(persist)
            except asyncio.CancelledError:
                # Detach so it survives the response cleanup.
                _BACKGROUND_PERSISTS.add(persist)
                persist.add_done_callback(_BACKGROUND_PERSISTS.discard)

    return EventSourceResponse(event_gen())
