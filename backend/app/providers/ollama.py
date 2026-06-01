import json
from collections.abc import AsyncIterator

import httpx

from ..config import settings
from .base import ChatMessage, LLMProvider


class OllamaProvider(LLMProvider):
    name = "ollama"

    def __init__(self) -> None:
        self.model = settings.ollama_model
        self.base_url = settings.ollama_base_url.rstrip("/")
        self.label = f"Ollama ({self.model})"

    @property
    def enabled(self) -> bool:
        return bool(self.base_url)

    async def list_models(self) -> list[dict]:
        """Return the models the Ollama server has available."""
        timeout = httpx.Timeout(connect=5.0, read=10.0, write=10.0, pool=5.0)
        async with httpx.AsyncClient(timeout=timeout) as client:
            resp = await client.get(f"{self.base_url}/api/tags")
            resp.raise_for_status()
            body = resp.json()
        return body.get("models") or []

    async def stream(
        self, messages: list[ChatMessage], model: str | None = None
    ) -> AsyncIterator[str]:
        payload = {
            "model": model or self.model,
            "messages": [{"role": m.role, "content": m.content} for m in messages],
            "stream": True,
        }
        url = f"{self.base_url}/api/chat"
        # No read timeout: large models with long attached context can take
        # minutes to emit the first token. Connect timeout stays short so
        # we fail fast if the server is unreachable.
        timeout = httpx.Timeout(
            connect=10.0,
            read=None,
            write=60.0,
            pool=10.0,
        )
        async with httpx.AsyncClient(timeout=timeout) as client:
            async with client.stream("POST", url, json=payload) as resp:
                resp.raise_for_status()
                async for line in resp.aiter_lines():
                    if not line.strip():
                        continue
                    try:
                        obj = json.loads(line)
                    except json.JSONDecodeError:
                        continue
                    delta = obj.get("message", {}).get("content", "")
                    if delta:
                        yield delta
                    if obj.get("done"):
                        return
