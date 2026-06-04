import asyncio
import json
import re
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


# === Auto model routing =====================================================
# Used when the client sends model="auto". We classify the request and pick
# one of the configured models. Patterns lean Korean-first since this is a
# KR-default UI.

_CODE_INTENT_KO = re.compile(
    r"취약점|코드\s*리뷰|코드\s*점검|보안\s*점검|버그|디버깅|"
    r"리팩토|리펙토|개선\s*제안|구현해|코드\s*작성|코드를\s*만들|코드\s*리뷰"
)
_CODE_INTENT_EN = re.compile(
    r"vulnerab|code\s*review|review\s+(?:this|the|my)?\s*code|"
    r"security\s*(?:review|audit|check|bug)|"
    r"\bbugs?\b|\bdebug(?:ging)?\b|refactor|implement|"
    r"write\s*(?:code|a\s*function|a\s*script)",
    re.IGNORECASE,
)
_REASONING_INTENT_KO = re.compile(
    r"왜\s|왜냐|이유는|원인은|분석해\s*줘|증명해|단계별로\s*생각|논리적으로|"
    r"수학|미적분|확률|논증|왜 그런"
)
_REASONING_INTENT_EN = re.compile(
    r"step.by.step|reason\s*through|prove\b|explain\s*why|\bwhy\s+does|"
    r"derive|chain.of.thought",
    re.IGNORECASE,
)
_LARGE_ATTACH_CHARS = 30_000

# Per-model native context length. When auto-routing picks a model,
# we use this map to lift the auto-sized num_ctx cap to whatever the
# model actually supports — so qwen3-coder's 256K isn't wasted by a
# global cap that has to stay low for qwen3/exaone's 32K hard limit.
# Match is by leading prefix on the lower-cased base name (the part
# before ":<tag>"). Unknown models fall back to OLLAMA_NUM_CTX_MAX.
_MODEL_CTX_LIMITS: dict[str, int] = {
    "qwen3-coder": 262_144,  # 256K native
    "qwen3": 32_768,
    "qwen2.5-coder": 32_768,
    "qwen2.5": 32_768,
    "deepseek-r1": 131_072,
    "deepseek-v3": 131_072,
    "llama3.3": 131_072,
    "llama3.2": 131_072,
    "llama3.1": 131_072,
    "exaone3.5": 32_768,
    "exaone": 32_768,
    "gemma3": 8_192,
    "gemma2": 8_192,
    "phi4": 16_384,
    "phi3": 4_096,
}


def _ctx_cap_for_model(name: str | None) -> int | None:
    """Return the model's native max context, or None if unknown."""
    if not name:
        return None
    base = name.split(":", 1)[0].lower()
    # Longest prefix wins so "qwen3-coder" beats "qwen3" for the
    # qwen3-coder:30b tag.
    best: tuple[int, int] | None = None
    for prefix, limit in _MODEL_CTX_LIMITS.items():
        if base.startswith(prefix) and (best is None or len(prefix) > best[0]):
            best = (len(prefix), limit)
    return best[1] if best else None


def _pick(name: str, fallback: str) -> str:
    """Use a configured router model if non-empty, else the default."""
    return name.strip() or fallback


def _choose_model(
    prompt: str,
    attachments: list[schemas.AttachmentIn],
) -> tuple[str, str]:
    """Return (model_name, reason_tag) for auto routing."""
    default = settings.ollama_model
    general = _pick(settings.model_auto_general, default)

    has_code_file = any(
        any(a.filename.lower().endswith(ext) for ext in _CODE_EXTS)
        for a in attachments
    )
    total_chars = sum(len(a.text) for a in attachments)

    if has_code_file:
        return _pick(settings.model_auto_code, default), "code attachment"
    if _CODE_INTENT_KO.search(prompt) or _CODE_INTENT_EN.search(prompt):
        return _pick(settings.model_auto_code, default), "code intent"
    if _REASONING_INTENT_KO.search(prompt) or _REASONING_INTENT_EN.search(prompt):
        return _pick(settings.model_auto_reasoning, default), "reasoning intent"
    if total_chars > _LARGE_ATTACH_CHARS:
        return _pick(settings.model_auto_code, default), "large attachment"
    return general, "general"


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
            "     각 발견은 다음 형식 그대로 H3 헤딩 한 줄로 출력하세요. "
            "UI가 이 헤딩을 찾아 접이식 카드로 변환합니다. 형식이 깨지면 "
            "카드가 안 생기고 그냥 텍스트로 보입니다.\n\n"
            "     ### [HIGH] SQL Injection 가능 - backend/app/auth.py:42\n"
            "     - **문제**: 무엇이 잘못되었는지 1-2문장.\n"
            "     - **위험**: 어떤 결과가 발생하는지.\n"
            "     - **수정**: 구체적 개선안. 코드는 fenced 블록으로.\n\n"
            "     === 형식 규칙 ===\n"
            "     · 헤딩은 반드시 `### ` (H3) 로 시작.\n"
            "     · 심각도는 [HIGH] / [MEDIUM] / [LOW] / [INFO] 중 하나 — "
            "대괄호 필수.\n"
            "     · 제목과 위치 사이는 일반 hyphen ` - ` (앞뒤 공백) 또는 "
            "em-dash ` — ` 둘 다 OK.\n"
            "     · 위치는 `상대경로:라인번호` 형식. 라인을 특정 못 하면 "
            "`경로:?` 로 표기 (예: `auth.py:?`). 라인 범위는 `42-58`.\n"
            "     · 경로는 첨부 파일 헤더에 나온 그대로 — 만들어내지 마세요.\n\n"
            "     === 잘못된 예 (이렇게 쓰지 마세요) ===\n"
            "     ✗ ### 1. SQL Injection (심각도 누락)\n"
            "     ✗ ### HIGH - SQL Injection (대괄호 누락)\n"
            "     ✗ **[HIGH]** SQL Injection (헤딩이 아님)\n"
            "     ✗ ### SQL Injection [HIGH] (위치 누락)\n"
            "     ✗ ### [HIGH] SQL Injection at auth.py (라인 누락)\n\n"
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
    num_ctx_cap_override: int | None = None,
) -> AsyncIterator[tuple[str, str]]:
    """Yield (event_type, data_json) tuples for a single provider."""
    start = time.monotonic()
    buf: list[str] = []
    try:
        async for delta in provider.stream(
            history, model=model, num_ctx_cap_override=num_ctx_cap_override
        ):
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

    # Auto-pick a model when the client sends "auto" (the dropdown's
    # 🤖 자동 entry). The chosen name is sent down the wire to the
    # provider AND echoed to the UI through an SSE "model" event so
    # the user can see what got selected and why.
    chosen_model: str | None = payload.model
    auto_reason: str | None = None
    if (payload.model or "").lower() == "auto":
        chosen_model, auto_reason = _choose_model(
            payload.prompt, payload.attachments
        )
    # When auto-routing decides, also raise the num_ctx cap to the
    # picked model's native limit. For manually selected models the
    # global OLLAMA_NUM_CTX_MAX still applies so a user can't push
    # qwen3 past 32K by accident.
    auto_ctx_cap = _ctx_cap_for_model(chosen_model) if auto_reason else None

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
            if auto_reason:
                yield {
                    "event": "model",
                    "data": json.dumps(
                        {
                            "provider": provider.name,
                            "name": chosen_model,
                            "reason": auto_reason,
                            "ctx_cap": auto_ctx_cap,
                        },
                        ensure_ascii=False,
                    ),
                }
            if search_sources or search_error:
                yield {
                    "event": "sources",
                    "data": json.dumps(
                        {"sources": search_sources, "error": search_error},
                        ensure_ascii=False,
                    ),
                }
            async for evt, data in _stream_one(
                provider,
                history,
                model=chosen_model,
                num_ctx_cap_override=auto_ctx_cap,
            ):
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
