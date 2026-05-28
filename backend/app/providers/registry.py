from .base import LLMProvider
from .claude import ClaudeProvider
from .ollama import OllamaProvider
from .openai import OpenAIProvider

_providers: dict[str, LLMProvider] = {
    p.name: p for p in [OllamaProvider(), OpenAIProvider(), ClaudeProvider()]
}


def all_providers() -> list[LLMProvider]:
    return list(_providers.values())


def enabled_providers() -> list[LLMProvider]:
    return [p for p in _providers.values() if p.enabled]


def get_provider(name: str) -> LLMProvider | None:
    return _providers.get(name)
