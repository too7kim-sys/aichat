from collections.abc import AsyncIterator

from anthropic import AsyncAnthropic

from ..config import settings
from .base import ChatMessage, LLMProvider


class ClaudeProvider(LLMProvider):
    name = "claude"
    label = "Claude"

    def __init__(self) -> None:
        self.model = settings.claude_model
        self._client = (
            AsyncAnthropic(api_key=settings.anthropic_api_key)
            if settings.anthropic_api_key
            else None
        )

    @property
    def enabled(self) -> bool:
        return self._client is not None

    async def stream(self, messages: list[ChatMessage]) -> AsyncIterator[str]:
        if self._client is None:
            raise RuntimeError("ANTHROPIC_API_KEY not configured")

        system_parts = [m.content for m in messages if m.role == "system"]
        convo = [
            {"role": m.role, "content": m.content}
            for m in messages
            if m.role in ("user", "assistant")
        ]
        kwargs = {
            "model": self.model,
            "max_tokens": 1024,
            "messages": convo,
        }
        if system_parts:
            kwargs["system"] = "\n\n".join(system_parts)

        async with self._client.messages.stream(**kwargs) as stream:
            async for text in stream.text_stream:
                if text:
                    yield text
