import json
import logging
from collections.abc import AsyncIterator

import httpx

from ..config import settings
from .base import ChatMessage, LLMProvider

log = logging.getLogger("uvicorn.error")

# Standard Ollama context tier sizes. We pick the smallest tier that
# fits the current payload (plus output headroom) so the model isn't
# loaded with more context than it needs.
_CTX_TIERS = (2048, 4096, 8192, 16384, 32768, 65536, 131072)


def _compute_num_ctx(messages: list[ChatMessage], floor: int, cap: int) -> int:
    total_chars = sum(len(m.content) for m in messages)
    # Korean + source code typically lands around 2.5 chars per token.
    # 1024 tokens of headroom for the model's reply.
    needed = int(total_chars / 2.5) + 1024
    for size in _CTX_TIERS:
        if size >= needed:
            return min(max(size, floor), cap)
    return cap


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
        self,
        messages: list[ChatMessage],
        model: str | None = None,
        num_ctx_cap_override: int | None = None,
    ) -> AsyncIterator[str]:
        # When auto-routing picked a model with a documented native
        # context (qwen3-coder:30b → 256K, llama3.x → 128K, ...), the
        # router passes that here so the auto-sizer can grow past the
        # global OLLAMA_NUM_CTX_MAX without erroring on a smaller-ctx
        # model.
        cap = num_ctx_cap_override or settings.ollama_num_ctx_max
        num_ctx = _compute_num_ctx(
            messages,
            floor=settings.ollama_num_ctx,
            cap=cap,
        )
        log.info(
            "Ollama stream: model=%s msgs=%d total_chars=%d num_ctx=%d",
            model or self.model,
            len(messages),
            sum(len(m.content) for m in messages),
            num_ctx,
        )
        options: dict = {"num_ctx": num_ctx}
        # Negative values disable the override and let Ollama use its
        # model-side default.
        if settings.ollama_temperature >= 0:
            options["temperature"] = settings.ollama_temperature
        if settings.ollama_top_p >= 0:
            options["top_p"] = settings.ollama_top_p
        if settings.ollama_repeat_penalty >= 0:
            options["repeat_penalty"] = settings.ollama_repeat_penalty
        payload = {
            "model": model or self.model,
            "messages": [{"role": m.role, "content": m.content} for m in messages],
            "stream": True,
            "options": options,
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
