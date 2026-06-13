import asyncio
import json
import logging
import re
import time
from collections.abc import AsyncIterator

log = logging.getLogger("uvicorn.error")

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

# qdrant-client may not be installed yet — RAG is an optional feature.
# Fall back to no-op stubs so the chat path keeps working unchanged.
try:
    from ..rag.retriever import format_chunks_for_prompt, retrieve
except ImportError:
    async def retrieve(*_args, **_kwargs):  # type: ignore[misc]
        return []

    def format_chunks_for_prompt(*_args, **_kwargs) -> str:  # type: ignore[misc]
        return ""

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


# 사용자 질문이 모호하거나 여러 해석이 가능할 때, 추측 대신 명시적으로
# 다시 묻는다. 답변 끝에 다음 형식의 fenced code block 을 포함시키면
# 프런트가 선택 버튼으로 렌더 — 사용자가 한 번 클릭으로 다음 turn 을
# 자동 전송, 대화가 끊김 없이 이어진다.
_CLARIFY_SYSTEM = ChatMessage(
    role="system",
    content=(
        "[모호함 → 선택지 질문]\n"
        "사용자 의도가 명확하지 않거나 여러 가지로 해석될 수 있을 때, "
        "추측해서 답변하지 마세요. 대신 짧게 다시 물으면서 답변의 마지막"
        "에 다음과 같은 코드 블록을 정확히 한 번만 포함하세요:\n\n"
        "```ask\n"
        "{\n"
        '  "question": "어떻게 처리할까요?",\n'
        '  "choices": [\n'
        '    "선택지 1 설명 (한 줄)",\n'
        '    "선택지 2 설명 (한 줄)"\n'
        "  ]\n"
        "}\n"
        "```\n\n"
        "규칙:\n"
        "- 코드 블록 안은 반드시 valid JSON.\n"
        "- choices 는 2~4 개. 너무 많으면 사용자 인지 부담이 커집니다.\n"
        "- 각 선택지는 한 줄 (60자 이내) 의 명확한 설명.\n"
        "- 사용자가 클릭한 선택지 문구가 다음 user 메시지로 그대로 들어"
        "오므로, 그 문구만 받아서 다음 답변을 작성할 수 있게 자족적으로 "
        "작성하세요.\n"
        "- 한 답변에 ask 블록은 최대 하나. 명백한 질문에는 ask 블록을 "
        "쓰지 마세요 — 그땐 그냥 답변."
    ),
)


# Detect translation intent in the user prompt so we can hand the model
# a strict format that always renders原文 + 번역 side-by-side. Patterns
# kept generous on purpose — a false positive just adds two helpful
# section headings, while a miss leaves the user staring at a wall of
# target-language text with no source to compare against.
_TRANSLATION_INTENT_RE = re.compile(
    r"번역|"
    r"\btranslate\b|"
    r"\btranslation\b|"
    r"(?:한국어|영어|일본어|중국어|독일어|프랑스어|스페인어|러시아어)\s*로|"
    r"(?:into|to)\s+(?:Korean|English|Japanese|Chinese|German|French|"
    r"Spanish|Russian|Vietnamese|Arabic)\b",
    re.IGNORECASE,
)

_CODE_FOCUSED_SYSTEM = ChatMessage(
    role="system",
    content=(
        "[코드 작업 모드 — 첨부 코드 직접 분석 강제]\n"
        "이 대화는 코드 작업에 특화되어 있습니다. 시스템 메시지의 "
        "[ATTACHED FILES] 블록에는 매 턴 워크스페이스 파일이 자동으로 "
        "포함됩니다. 첫 첨부는 항상 `_WORKSPACE_TREE.txt` (실제 디렉터리 "
        "구조)이고, 그 뒤로 소스코드 > 스크립트 > 마크업 > 설정 순으로 "
        "내용 파일들이 따라옵니다.\n\n"
        "[질문 유형별 행동 — 어기지 마세요]\n"
        "■ 구조/아키텍처/모듈 구성/디렉터리 설명 요청\n"
        "   → 반드시 `_WORKSPACE_TREE.txt`의 실제 경로를 인용해 답하세요.\n"
        "     \"보통 Spring 프로젝트는 controller/service/repository ...\" "
        "     같은 일반론 예시는 금지. 트리에 보이는 실제 폴더·파일명만 "
        "     사용. 응답 구조:\n"
        "         ## 최상위 구성 (트리에서 본 폴더 + 한 줄 설명)\n"
        "         ## 진입점 (파일 경로 + 역할)\n"
        "         ## 빌드/설정 (pom.xml / package.json 등 실제 파일)\n"
        "■ 취약점/리뷰/버그/리팩토/특정 기능 분석 요청\n"
        "   → 첨부 파일을 한 줄씩 직접 읽고 분석. \"이런 취약점이 있을 수 "
        "     있어요\" \"일반적으로 ~합니다\" \"예시는 다음과 같습니다\" "
        "     같은 GENERIC 예시 응답 금지. 응답 구조:\n"
        "         ## 분석한 파일 (path 목록)\n"
        "         ## 발견된 문제 (각각 path:line + 코드 증거)\n"
        "         ## 수정 제안 (필요 시 `# file: <경로>` 마커로 전체 파일)\n"
        "■ \"어디서 ~를 처리하나요\" / \"~ 흐름을 설명해줘\" 류 탐색 요청\n"
        "   → 먼저 트리에서 후보 경로를 찾고, 첨부 파일 본문에서 호출 흐름을 "
        "     역추적해 path:line으로 인용하세요.\n\n"
        "[공통 절대 규칙]\n"
        "1. 모든 인용은 `path/to/file.ext:line_number — <설명>` 형식. "
        "   path:line 인용이 불가능하면 단정하지 말고 \"트리에는 X가 있지만 "
        "   본문 첨부는 누락\"이라고 명시.\n"
        "2. 코드 증거를 보여줄 때는 첨부에서 실제로 본 라인만 ```언어 …``` "
        "   블록으로 인용. 임의 코드 지어내기 금지.\n"
        "3. 첨부에 필요한 파일이 없으면 응답 도입에 \"첨부된 N개 파일에는 "
        "   <범주> 관련 코드가 보이지 않습니다. 다음 경로의 파일을 보여주세요: "
        "   …\"라고 명시적으로 요청. 일반 예시로 도망가지 마세요.\n"
        "4. 첨부에 진짜 해당 카테고리 코드가 없으면 \"이번 첨부에서는 "
        "   <범주> 관련 코드를 찾지 못했습니다\"라고 짧게 답하고 끝내세요. "
        "   빈 발견을 만들어내지 마세요.\n"
        "5. 새 파일 생성, 코드 수정 제안, 또는 사용자가 \"다운로드\" / "
        "   \"저장\" / \"파일로 만들어줘\" 류를 요청한 경우 반드시 "
        "   `# file: <워크스페이스 상대 경로>` 마커 + 전체 파일 내용을 "
        "   ```언어 …``` 블록 안에 작성. 경로는 반드시 `_WORKSPACE_TREE.txt`의 "
        "   기존 폴더 구조를 따르세요 — 새 서비스라면 기존 서비스가 있는 "
        "   디렉터리, 새 컨트롤러라면 기존 컨트롤러 디렉터리. 디렉터리 표준이 "
        "   없거나 모호하면 사용자에게 어디에 둘지 먼저 물어보세요. "
        "   본문에서는 git / commit / push 같은 용어를 임의로 사용하지 "
        "   말고, 자신이 어떤 워크스페이스 종류에 있는지 모르면 그냥 "
        "   \"저장하면 워크스페이스에 반영됩니다\" 정도로만 안내하세요 "
        "   (별도 시스템 메시지가 git 여부를 알려줍니다).\n"
        "6. 빌드·테스트 명령은 프로젝트의 실제 스택(pom.xml / build.gradle / "
        "   package.json / Cargo.toml 등)에서 확인된 것만.\n"
        "7. 이전 턴 파일은 다시 첨부됐다고 가정하고 맥락 이어가기 — "
        "   \"파일을 보여주세요\" 반복 금지.\n"
        "8. 의심 시 답변 끝에 `(확인 필요)` + 검증 요청 명시."
    ),
)


_HTML_DOC_INTENT_RE = re.compile(
    r"문서로\s*만들|문서\s*만들|보고서로\s*만들|보고서\s*만들|"
    r"한\s*페이지로|웹\s*페이지로|"
    r"html\s*문서|html로\s*만들|html\s*만들|"
    r"single.?file\s*html|self.?contained\s*html|"
    r"build\s+an?\s+html\s+(?:document|page|report)|"
    r"make\s+an?\s+html\s+(?:document|page|report)",
    re.IGNORECASE,
)


_HTML_DOC_SYSTEM = ChatMessage(
    role="system",
    content=(
        "[HTML 문서 출력 모드]\n"
        "사용자가 문서/보고서/페이지를 만들어달라고 요청했습니다. 답변은 반드시 "
        "단 하나의 완전한 자체 포함 HTML 문서를 ```html 코드 블록 안에 "
        "출력하세요. 클라이언트가 이 블록을 감지해 좌측 슬라이드 패널에서 "
        "미리보기로 자동 표시하고, .html 파일로 다운로드할 수 있게 합니다.\n\n"
        "엄격한 규칙:\n"
        "1. 답변은 ```html 으로 시작해서 ``` 로 끝나는 단 하나의 코드 블록.\n"
        "2. 코드 블록 외부에 추가 설명·주석·서두 출력 금지. 오직 HTML만.\n"
        "3. <!DOCTYPE html> 선언으로 시작.\n"
        "4. <head>에 적절한 <title> 설정 (다운로드 파일명에 사용됨).\n"
        "5. <head>에 <meta charset=\"utf-8\"> 와 <meta name=\"viewport\" "
        "   content=\"width=device-width, initial-scale=1\"> 포함.\n"
        "6. 모든 CSS는 <style> 태그로 인라인 — 외부 stylesheet/CDN 링크 금지.\n"
        "7. 외부 이미지/스크립트/폰트 CDN 사용 금지 — 오프라인에서도 동작해야 함.\n"
        "8. 한글 친화 폰트 스택: \"Pretendard\", \"Apple SD Gothic Neo\", "
        "   \"Malgun Gothic\", sans-serif.\n"
        "9. 본문 너비는 max-width: 820px; margin: 0 auto; padding: 40px 24px.\n"
        "10. 본문 색상은 #333~#444 회색 톤, 강조 색은 #cc785c 또는 #b8654a.\n"
        "11. 인쇄(@media print) 시 적절히 보이도록 페이지 여백·색 대비 확보.\n"
        "12. 표/목록/제목 위계를 명확히 — 단조로운 텍스트 덩어리 금지."
    ),
)


_TRANSLATION_SYSTEM = ChatMessage(
    role="system",
    content=(
        "[번역 출력 형식]\n"
        "사용자가 번역을 요청했습니다. 답변은 반드시 아래 구조로 시작해야 "
        "합니다:\n\n"
        "## 원문\n"
        "<번역 대상 텍스트만 그대로>\n\n"
        "## 번역\n"
        "<대상 언어로 번역한 결과>\n\n"
        "지켜야 할 규칙:\n"
        "1. \"원문\" 섹션에는 번역할 대상 텍스트만 옮기세요. 사용자의 "
        "요청 문구(\"번역해줘\", \"translate to English\" 같은 메타 지시)는 "
        "원문에서 빼세요.\n"
        "2. 원문은 한 글자도 변경하지 말고 그대로 인용하세요. 띄어쓰기·"
        "줄바꿈·문장부호까지 동일하게.\n"
        "3. 단락이 여럿이면 원문/번역 모두 같은 단락 순서로 정렬하세요. "
        "긴 텍스트는 단락 단위로 (원문/번역) 쌍을 반복해도 좋습니다.\n"
        "4. 고유명사·코드 식별자·수식·URL은 원어 그대로 두세요.\n"
        "5. 의역이 들어간 부분은 그 단락 뒤에 \"(직역: <원문의 직역>)\"을 "
        "한 줄 덧붙이세요.\n"
        "6. 번역 외 추가 설명·문화적 주석·용어 풀이는 마지막 \"## 참고\" "
        "섹션에 모으세요.\n"
        "예외: 사용자가 \"원문 없이\", \"번역만\", \"output translation only\" "
        "같이 명시한 경우에만 \"## 원문\" 섹션을 생략하세요."
    ),
)


def _is_translation_request(prompt: str) -> bool:
    return bool(_TRANSLATION_INTENT_RE.search(prompt))


def _is_html_doc_request(prompt: str) -> bool:
    return bool(_HTML_DOC_INTENT_RE.search(prompt))


def _build_history(
    session: models.Session,
    new_user_prompt: str,
    new_user_images: list[str] | None = None,
) -> list[ChatMessage]:
    # Sliding window: keep only the last N *visible* persisted messages
    # so the context length sent to Ollama doesn't grow unbounded across
    # a long conversation. Messages marked hidden=True (e.g., the raw
    # whisper transcript persisted alongside its summary) are excluded
    # because they're typically huge bodies that crowd out real intent
    # — the summary alone is enough for follow-up Q&A about the meeting.
    # The new user prompt is always appended on top, and — when the
    # current attachments include image bytes — the base64 blobs ride
    # along on that message so vision models can see them.
    limit = max(1, settings.max_history_messages)
    visible = [m for m in session.messages if not getattr(m, "hidden", False)]
    recent = visible[-limit:]
    history: list[ChatMessage] = [
        ChatMessage(role=m.role, content=m.content) for m in recent
    ]
    history.append(
        ChatMessage(
            role="user",
            content=new_user_prompt,
            images=new_user_images or None,
        )
    )
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
    "qwen2.5vl": 32_768,
    "qwen2-vl": 32_768,
    "qwen-vl": 32_768,
    "qwen2.5": 32_768,
    "deepseek-r1": 131_072,
    "deepseek-v3": 131_072,
    "llama3.3": 131_072,
    "llama3.2-vision": 131_072,
    "llama3.2": 131_072,
    "llama3.1": 131_072,
    "exaone3.5": 32_768,
    "exaone": 32_768,
    "gemma3": 131_072,  # gemma3 4b/12b/27b are vision-capable + 128K ctx
    "gemma2": 8_192,
    "phi4-multimodal": 16_384,
    "phi4": 16_384,
    "phi3-vision": 4_096,
    "phi3": 4_096,
    "llava": 4_096,
    "bakllava": 4_096,
    "minicpm-v": 32_768,
    "moondream": 4_096,
}


# Model name prefixes that have vision input. The chat router uses
# this to route image attachments to a model that can actually look at
# them — the OCR fallback in extract.py keeps text-only models working
# without the image. Match is by leading prefix on the lower-cased
# base name.
_VISION_MODEL_PREFIXES = (
    "qwen2.5vl", "qwen2-vl", "qwen-vl",
    "llama3.2-vision",
    "gemma3",
    "llava", "bakllava",
    "minicpm-v", "moondream",
    "phi3-vision", "phi4-multimodal",
)


def _is_vision_model(name: str | None) -> bool:
    if not name:
        return False
    base = name.split(":", 1)[0].lower()
    return any(base.startswith(p) for p in _VISION_MODEL_PREFIXES)


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

    # Vision wins over everything else — once an image is in the room
    # the user almost certainly wants the model to see it, not just
    # OCR-summarise around it.
    if any(a.image_b64 for a in attachments):
        return _pick(settings.model_auto_vision, default), "image attachment"

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
    image_count = sum(1 for a in attachments if a.image_b64)
    if image_count:
        parts.append(
            f"\n[IMAGE NOTE] 위 첨부 중 {image_count}개는 이미지입니다. "
            "비전 모델이 라우팅된 경우 사용자 메시지의 images 필드를 통해 "
            "이미지 픽셀을 직접 볼 수 있습니다. 텍스트 모델이면 아래 OCR "
            "결과로만 답변하고, 시각적 세부사항(색·레이아웃·도표)에 대해서는 "
            "\"이미지를 직접 볼 수 없습니다\"라고 명시하세요."
        )
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


def _attachments_summary_json(
    attachments: list[schemas.AttachmentIn],
) -> str | None:
    """Compact JSON list persisted alongside the user message so the
    bubble can render filename + type chips after reload. Only the
    client-uploaded attachments belong here — auto-injected workspace
    files would duplicate on every turn and aren't useful to recall."""
    if not attachments:
        return None
    summary = [
        {
            "filename": a.filename,
            "kind": "image" if a.image_b64 else "file",
            "size": len(a.text),
        }
        for a in attachments
    ]
    return json.dumps(summary, ensure_ascii=False)


async def _persist_messages(
    session_id: str,
    user_prompt: str,
    assistant_results: dict[str, tuple[str, int]],
    attachments_summary_json: str | None = None,
) -> None:
    async with SessionLocal() as db:
        db.add(
            models.Message(
                session_id=session_id,
                role="user",
                content=user_prompt,
                attachments_summary=attachments_summary_json,
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


@router.post("/{session_id}/log-merge", response_model=list[schemas.MessageOut])
async def log_merge(
    session_id: str,
    payload: schemas.MergeLogRequest,
    db: AsyncSession = Depends(get_db),
    user: models.User = Depends(get_current_user),
):
    """Persist a two-message record of a `/병합` exchange so the chat
    surface shows what happened — the user's slash command (with the
    source files as chips) on one side, and an assistant-style
    confirmation (with the merged filename as a chip) on the other.

    The actual merged bytes are NOT stored — the download already
    fired client-side during the merge call. This endpoint is purely
    for the visible chat log."""
    session = await _load_session(db, session_id, user.id)

    _image_exts = {".png", ".jpg", ".jpeg", ".gif", ".bmp", ".webp", ".tif", ".tiff"}

    def _kind(fn: str) -> str:
        i = fn.rfind(".")
        ext = fn[i:].lower() if i >= 0 else ""
        return "image" if ext in _image_exts else "file"

    user_summary = json.dumps(
        [
            {"filename": fn, "kind": _kind(fn), "size": 0}
            for fn in payload.source_filenames
        ],
        ensure_ascii=False,
    )
    result_summary = json.dumps(
        [
            {
                "filename": payload.result_filename,
                "kind": _kind(payload.result_filename),
                "size": max(payload.result_size, 0),
            }
        ],
        ensure_ascii=False,
    )
    kb = (max(payload.result_size, 0) + 1023) // 1024
    summary_text = (
        f"병합 완료 · {payload.result_filename} "
        f"({len(payload.source_filenames)}개 파일, {kb:,} KB)"
    )

    user_msg = models.Message(
        session_id=session_id,
        role="user",
        content=payload.user_prompt,
        attachments_summary=user_summary,
    )
    result_msg = models.Message(
        session_id=session_id,
        role="assistant",
        provider="merge",
        content=summary_text,
        attachments_summary=result_summary,
    )
    db.add(user_msg)
    db.add(result_msg)
    await db.commit()
    await db.refresh(user_msg)
    await db.refresh(result_msg)
    _ = session  # suppress unused — ownership check already happened
    return [user_msg, result_msg]


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

    # Code-focused sessions pull their workspace files fresh each
    # turn so the model doesn't lose the project after the first
    # message. The list is prepended to whatever the client sent so
    # client-side image / one-off attachments still work normally.
    auto_workspace_attachments: list[schemas.AttachmentIn] = []
    if session.workspace_id:
        try:
            ws = await db.scalar(
                select(models.CodeWorkspace).where(
                    models.CodeWorkspace.id == session.workspace_id,
                    models.CodeWorkspace.user_id == user.id,
                )
            )
        except Exception:  # noqa: BLE001
            ws = None
        if ws and ws.status != "ready":
            # Workspace exists but isn't usable — surface the reason
            # so the model can tell the user instead of pretending to
            # have the code. Common case: a local-folder workspace
            # whose path went away between clone and chat.
            auto_workspace_attachments.append(
                schemas.AttachmentIn(
                    filename=f"{ws.name}/_WORKSPACE_NOT_READY.txt",
                    text=(
                        f"# {ws.name} — 워크스페이스 준비 안 됨\n"
                        f"상태: {ws.status}\n"
                        f"오류: {ws.error or '없음'}\n"
                        f"경로: {ws.local_path or '없음'}\n\n"
                        "코드 내용을 가져올 수 없습니다. 사용자에게 "
                        "워크스페이스 재동기화(↻) 또는 경로 재확인을 안내하세요."
                    ),
                )
            )
            log.warning(
                "chat workspace not ready session=%s ws=%s status=%s",
                session.id, ws.id, ws.status,
            )
        elif ws and ws.status == "ready":
            from pathlib import Path as _PathForWs

            from ..code.workspace import (
                collect_workspace_files,
                format_workspace_tree_text,
            )
            root = _PathForWs(ws.local_path)
            bundle = await asyncio.get_running_loop().run_in_executor(
                None, collect_workspace_files, root
            )
            log.info(
                "chat workspace bundle session=%s ws=%s root=%s "
                "files=%d/%d truncated=%s walk_error=%s",
                session.id, ws.id, root,
                bundle["total_files"], bundle["total_files_in_repo"],
                bundle["truncated"], bundle.get("walk_error"),
            )
            # Translate the bundle's per-file status into short
            # visual markers the tree can show next to each file.
            # Compact form (한 글자 + 짧은 이유) so even a 400-file
            # tree stays readable for the model.
            def _status_marker(status: str) -> str:
                if status == "ok":
                    return "✓ 첨부"
                if status.startswith("oversize:"):
                    try:
                        kb = int(status.split(":", 1)[1]) // 1024
                    except ValueError:
                        kb = 0
                    return f"⊘ 한도 초과 ({kb} KB)"
                if status.startswith("unsupported-ext:"):
                    ext = status.split(":", 1)[1]
                    return f"⊘ 미지원 확장자 ({ext})"
                if status == "over-file-cap":
                    return "… 파일 개수 한도 초과"
                if status == "over-byte-cap":
                    return "… 합계 바이트 한도 초과"
                if status == "binary":
                    return "⊘ 바이너리"
                if status == "empty":
                    return "⊘ 빈 파일"
                if status == "read-error":
                    return "⊘ 읽기 실패"
                return ""
            file_status_map = {
                rel: _status_marker(reason)
                for rel, reason in (bundle.get("file_status") or {}).items()
            }
            # Always inject the directory tree FIRST so structure /
            # architecture questions don't have to fish through file
            # contents to figure out what the project looks like.
            tree_text = await asyncio.get_running_loop().run_in_executor(
                None,
                lambda: format_workspace_tree_text(
                    root, file_status=file_status_map,
                ),
            )
            tree_manifest = (
                f"# {ws.name} — 디렉터리 구조 + 첨부 현황\n"
                f"이 트리는 워크스페이스의 실제 폴더 구조입니다. "
                f"각 파일 우측에 첨부 상태가 표시됩니다:\n"
                f"  · ✓ 첨부 — 본문이 이번 턴 컨텍스트에 포함됨\n"
                f"  · ⊘ ... — 한도/확장자 등의 이유로 본문 제외 (트리에는 보임)\n"
                f"  · … 한도 초과 — 같은 한도라도 우선순위가 낮아 잘림\n"
                f"질문이 ⊘/… 파일에 대한 것이면 사용자에게 그 파일을 명시적으로 "
                f"요청하라고 안내하세요.\n\n"
                f"```\n{tree_text}\n```"
            )
            auto_workspace_attachments = [
                schemas.AttachmentIn(
                    filename=f"{ws.name}/_WORKSPACE_TREE.txt",
                    text=tree_manifest,
                ),
            ]
            auto_workspace_attachments.extend(
                schemas.AttachmentIn(
                    filename=f"{ws.name}/{f['path']}",
                    text=f["text"],
                )
                for f in bundle["files"]
            )
            # Diagnostics: when the bundle came back empty (or much
            # smaller than the user might expect for a real project),
            # surface a system note so the model can tell the user
            # what's wrong instead of pretending to analyse code it
            # never actually received.
            if bundle.get("walk_error"):
                auto_workspace_attachments.append(
                    schemas.AttachmentIn(
                        filename=f"{ws.name}/_WORKSPACE_ERROR.txt",
                        text=(
                            f"# {ws.name} — 워크스페이스 읽기 실패\n"
                            f"경로: {root}\n"
                            f"원인: {bundle['walk_error']}\n\n"
                            "분석을 시작하기 전에 사용자에게 다음을 알려주세요:\n"
                            "1) 위 경로가 백엔드 서버에서 읽을 수 있는지 확인 필요\n"
                            "2) 권한·존재 여부·마운트 상태 점검\n"
                            "코드 내용을 알 수 없으므로 추측 답변은 하지 마세요."
                        ),
                    )
                )
            elif bundle["total_files"] == 0 and bundle["total_files_in_repo"] == 0:
                auto_workspace_attachments.append(
                    schemas.AttachmentIn(
                        filename=f"{ws.name}/_WORKSPACE_EMPTY.txt",
                        text=(
                            f"# {ws.name} — 분석 가능한 파일이 없습니다\n"
                            f"경로: {root}\n"
                            "이 디렉토리는 비어 있거나 SKIP 대상(.git/node_modules 등)만 포함합니다.\n"
                            "사용자에게 올바른 소스 경로를 다시 안내하고 추측 답변은 하지 마세요."
                        ),
                    )
                )
            elif bundle["total_files"] == 0 and bundle["total_files_in_repo"] > 0:
                # Files exist but none made it into the bundle —
                # almost always because every file is too big OR has
                # an extension outside _TEXT_EXTS (e.g. compiled jars).
                hints: list[str] = []
                if bundle.get("skipped_too_large", 0) > 0:
                    hints.append(
                        f"{bundle['skipped_too_large']}개가 300KB 한도 초과로 제외됨"
                    )
                if bundle.get("skipped_unsupported_ext", 0) > 0:
                    hints.append(
                        f"{bundle['skipped_unsupported_ext']}개가 지원하지 않는 확장자로 제외됨"
                    )
                hint_text = " / ".join(hints) if hints else "원인 불명"
                auto_workspace_attachments.append(
                    schemas.AttachmentIn(
                        filename=f"{ws.name}/_WORKSPACE_FILTERED.txt",
                        text=(
                            f"# {ws.name} — 파일은 있으나 본문이 첨부되지 않음\n"
                            f"전체 파일: {bundle['total_files_in_repo']}\n"
                            f"본문 첨부: 0\n"
                            f"제외 사유: {hint_text}\n\n"
                            "사용자에게 다음을 알려주세요:\n"
                            "- 분석 대상 폴더가 컴파일 산출물(jar/class/war)만 있는지\n"
                            "- 대용량 단일 파일이라면 분할 또는 부분 경로 지정이 필요\n"
                            "추측 답변은 하지 말고 어떤 파일을 보고 싶은지 물어보세요."
                        ),
                    )
                )
            elif bundle["truncated"]:
                # Tell the user *which* cap clipped the bundle so the
                # right knob (file count / per-file size / total
                # bytes) is obvious to tune via .env.
                missing = (
                    bundle['total_files_in_repo'] - bundle['total_files']
                )
                reasons: list[str] = []
                if bundle["total_files"] >= settings.workspace_bundle_max_files:
                    reasons.append(
                        f"파일 개수 한도(WORKSPACE_BUNDLE_MAX_FILES="
                        f"{settings.workspace_bundle_max_files}) 도달 — "
                        f"실제 코드 바이트는 {bundle['total_size']:,} (한도 "
                        f"{settings.workspace_bundle_max_total_bytes:,})로 여유가 있을 수 있음"
                    )
                if (
                    bundle['total_size']
                    >= settings.workspace_bundle_max_total_bytes
                    - settings.workspace_bundle_max_bytes_per_file
                ):
                    reasons.append(
                        f"전체 바이트 한도(WORKSPACE_BUNDLE_MAX_TOTAL_BYTES="
                        f"{settings.workspace_bundle_max_total_bytes:,}) 임계 도달"
                    )
                if bundle.get("skipped_too_large", 0) > 0:
                    reasons.append(
                        f"단일 파일 {bundle['skipped_too_large']}개가 "
                        f"WORKSPACE_BUNDLE_MAX_BYTES_PER_FILE="
                        f"{settings.workspace_bundle_max_bytes_per_file:,} 초과"
                    )
                why = "\n  · " + "\n  · ".join(reasons) if reasons else ""
                manifest = (
                    f"# {ws.name} — workspace manifest\n"
                    f"전체 파일: {bundle['total_files_in_repo']}\n"
                    f"채팅에 포함: {bundle['total_files']} (텍스트, 작은 것 우선)\n"
                    f"총 본문 바이트: {bundle['total_size']:,}\n"
                    f"미포함: {missing}개{why}\n\n"
                    "필요한 파일이 위에 없으면 사용자에게 정확한 경로를 요청하세요."
                )
                auto_workspace_attachments.append(
                    schemas.AttachmentIn(
                        filename=f"{ws.name}/_WORKSPACE_MANIFEST.txt",
                        text=manifest,
                    )
                )

    # Merge client + auto attachments. Client-provided ones come
    # LAST so newer one-off uploads (e.g., a screenshot) sit closer
    # to the model's attention.
    effective_attachments = auto_workspace_attachments + list(payload.attachments)

    # Auto-pick a model when the client sends "auto" (the dropdown's
    # 🤖 자동 entry). The chosen name is sent down the wire to the
    # provider AND echoed to the UI through an SSE "model" event so
    # the user can see what got selected and why.
    chosen_model: str | None = payload.model
    auto_reason: str | None = None
    if (payload.model or "").lower() == "auto":
        chosen_model, auto_reason = _choose_model(
            payload.prompt, effective_attachments
        )
        # code-focused sessions force the code bucket regardless of
        # what _choose_model returned. This guarantees the routing
        # reason badge says "session code-focused" instead of
        # whatever heuristic fired.
        if session.code_focused:
            chosen_model = _pick(
                settings.model_auto_code, settings.ollama_model
            )
            auto_reason = "session code-focused"

    # Vision payload: only forward image bytes when the model can
    # actually look at them. Text-only models get the OCR text from
    # the attachments system message and ignore the image entirely.
    user_images: list[str] = []
    if _is_vision_model(chosen_model):
        user_images = [
            a.image_b64 for a in payload.attachments if a.image_b64
        ]

    history = _build_history(
        session, payload.prompt, new_user_images=user_images or None
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

    attach_msg = _attachments_message(effective_attachments)
    if attach_msg is not None:
        # Place the attachment context right BEFORE the new user prompt
        # (which _build_history appended as the final element). This
        # keeps the attached source as the freshest context the model
        # sees, ahead of any web search or stale conversation turns.
        history.insert(-1, attach_msg)

    # Project RAG: if the session (or this request) names a project,
    # embed the prompt + retrieve top-K chunks and inject them as
    # another system message right before the user prompt. Failures
    # are logged but never block the chat.
    rag_chunks: list[dict] = []
    project_id = payload.project_id
    if not project_id:
        # Session-level default — set when the user picks a project on
        # the chat panel.
        session_row = await db.scalar(
            select(models.Session).where(models.Session.id == session_id)
        )
        if session_row is not None:
            project_id = session_row.project_id

    chunks: list = []
    rag_filename = (
        (payload.rag_filename_filter or "").strip() or None
        if hasattr(payload, "rag_filename_filter") else None
    )
    if project_id:
        # Explicit link — search just that project (existing behaviour).
        try:
            chunks = await retrieve(
                project_id, payload.prompt,
                filename_pattern=rag_filename,
                user_id=user.id,
            )
        except Exception as exc:  # noqa: BLE001
            chunks = []
            log.warning("RAG retrieve failed: %s", exc)
    else:
        # No explicit link — question-driven auto search across every
        # shared knowledge base this user's role can access. Score-
        # gated so unrelated bases contribute nothing to the context.
        try:
            from ..rag.access import accessible_shared_project_ids
            from ..rag.retriever import retrieve_many

            accessible = await accessible_shared_project_ids(db, user)
            if accessible:
                log.info(
                    "RAG auto-search: user=%s accessible=%d projects %s",
                    user.email, len(accessible), accessible,
                )
                chunks = await retrieve_many(
                    accessible,
                    payload.prompt,
                    min_score=settings.rag_auto_min_score,
                    user_id=user.id,
                )
                if chunks:
                    by_proj: dict[str, int] = {}
                    for c in chunks:
                        key = (c.project_name or c.project_id or "?")
                        by_proj[key] = by_proj.get(key, 0) + 1
                    log.info(
                        "RAG auto-search: %d chunks from %s",
                        len(chunks), by_proj,
                    )
        except Exception as exc:  # noqa: BLE001
            chunks = []
            log.warning("RAG auto-retrieve failed: %s", exc)

    if chunks:
        history.insert(
            -1,
            ChatMessage(
                role="system",
                content=format_chunks_for_prompt(chunks),
            ),
        )
        rag_chunks = [
            {
                "filename": c.filename,
                "start_line": c.start_line,
                "end_line": c.end_line,
                "score": c.score,
                "project_name": c.project_name,
                "project_owned": c.project_owned,
            }
            for c in chunks
        ]

    # Optional per-deployment system prompt from .env (house style,
    # domain rules, escalation policy, ...). Goes near the front so
    # downstream system messages can still override specifics.
    extra = (settings.system_prompt_extra or "").strip()
    if extra:
        history.insert(0, ChatMessage(role="system", content=extra))

    # Per-chat-project instructions — the "Claude.ai Projects" pattern.
    # When the session sits inside a folder, the folder's instructions
    # field is prepended so the same domain context applies across
    # every chat in that project without the user having to repeat it.
    if session.chat_project_id:
        cp = await db.scalar(
            select(models.ChatProject).where(
                models.ChatProject.id == session.chat_project_id,
                models.ChatProject.user_id == user.id,
            )
        )
        cp_instr = (cp.instructions or "").strip() if cp else ""
        if cp_instr:
            history.insert(0, ChatMessage(role="system", content=cp_instr))

    # Anti-hallucination ruleset. Inserted in front of any other system
    # message so the model reads it first.
    if settings.accuracy_strict:
        history.insert(0, _ACCURACY_SYSTEM)

    # 모호함 → 선택지 질문 규칙. 항상 적용 — 명백한 질문에는 모델이
    # 알아서 안 쓰도록 시스템 메시지 안에서 가이드.
    history.insert(0, _CLARIFY_SYSTEM)

    # Translation requests get a strict "## 원문" / "## 번역" output
    # contract so the user can read source and target side-by-side
    # instead of having to scroll back to the original to compare.
    # Inserted after the accuracy block so it shows up nearer the
    # user prompt (= higher attention) than the global rules.
    if _is_translation_request(payload.prompt):
        history.insert(-1, _TRANSLATION_SYSTEM)

    # Document-build requests get a strict "single self-contained HTML"
    # output contract — the frontend auto-detects the resulting
    # ```html``` block and opens it in a left-side preview panel.
    if _is_html_doc_request(payload.prompt):
        history.insert(-1, _HTML_DOC_SYSTEM)

    # Code-focused sessions get the coding system prompt right next
    # to the user message so its rules win over the global ruleset.
    if session.code_focused:
        history.insert(-1, _CODE_FOCUSED_SYSTEM)
        # Tell the model which kind of workspace is attached so it
        # describes the "save" action with the right vocabulary.
        # Without this hint the model defaults to mentioning git
        # commit / push even when the session is on a local-folder
        # workspace (no .git) and the user gets confused.
        ws_kind = None
        if session.workspace_id:
            ws_for_hint = await db.scalar(
                select(models.CodeWorkspace).where(
                    models.CodeWorkspace.id == session.workspace_id,
                    models.CodeWorkspace.user_id == user.id,
                )
            )
            ws_kind = ws_for_hint.source_type if ws_for_hint else None
        if ws_kind == "git":
            hint = (
                "[워크스페이스 종류: git clone]\n"
                "- 파일을 저장하면 클론에 쓰고, UI에서 사용자가 commit/push "
                "  버튼을 누르면 원격 저장소에 반영됩니다.\n"
                "- 사용자가 \"git에 반영\" / \"push\" / \"commit\" 요청 시 "
                "  `# file: <상대경로>` 마커 + 전체 파일을 출력하세요. UI가 "
                "  자동으로 apply + commit + push 칩을 답니다.\n"
            )
        elif ws_kind == "local":
            hint = (
                "[워크스페이스 종류: local 폴더]\n"
                "- 이 워크스페이스에는 .git이 없거나 사용자가 직접 등록한 "
                "  서버 폴더입니다. **git, commit, push 단어를 답변에 쓰지 "
                "  마세요** — 사용자가 혼란스러워합니다.\n"
                "- \"저장\" / \"다운로드\" 요청 시 `# file: <상대경로>` 마커 "
                "  + 전체 파일을 출력하면 UI가 폴더에 저장 + 브라우저 다운로드 "
                "  칩을 답니다.\n"
            )
        else:
            hint = None
        if hint:
            history.insert(-1, ChatMessage(role="system", content=hint))

    # Pin the language preference at the very front so it always wins
    # over the model's own default behavior.
    history.insert(0, _LANGUAGE_SYSTEM)

    captured: dict[str, tuple[str, int]] = {}
    chunks: list[str] = []
    start = time.monotonic()

    async def event_gen():
        try:
            if rag_chunks:
                yield {
                    "event": "rag",
                    "data": json.dumps(
                        {"chunks": rag_chunks}, ensure_ascii=False
                    ),
                }
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
                _persist_messages(
                    session_id,
                    payload.prompt,
                    captured,
                    attachments_summary_json=_attachments_summary_json(
                        payload.attachments
                    ),
                )
            )
            try:
                await asyncio.shield(persist)
            except asyncio.CancelledError:
                # Detach so it survives the response cleanup.
                _BACKGROUND_PERSISTS.add(persist)
                persist.add_done_callback(_BACKGROUND_PERSISTS.discard)

    return EventSourceResponse(event_gen())
