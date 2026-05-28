from collections.abc import AsyncIterator

from openai import AsyncOpenAI

from ..config import settings
from .base import ChatMessage, LLMProvider


class OpenAIProvider(LLMProvider):
    name = "openai"
    label = "ChatGPT"

    def __init__(self) -> None:
        self.model = settings.openai_model
        self._client = (
            AsyncOpenAI(api_key=settings.openai_api_key)
            if settings.openai_api_key
            else None
        )

    @property
    def enabled(self) -> bool:
        return self._client is not None

    async def stream(self, messages: list[ChatMessage]) -> AsyncIterator[str]:
        if self._client is None:
            raise RuntimeError("OPENAI_API_KEY not configured")
        stream = await self._client.chat.completions.create(
            model=self.model,
            messages=[{"role": m.role, "content": m.content} for m in messages],
            stream=True,
        )
        async for chunk in stream:
            if not chunk.choices:
                continue
            delta = chunk.choices[0].delta.content
            if delta:
                yield delta
