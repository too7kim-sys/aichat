from .base import LLMProvider
from .ollama import OllamaProvider

_providers: dict[str, LLMProvider] = {p.name: p for p in [OllamaProvider()]}


def all_providers() -> list[LLMProvider]:
    return list(_providers.values())


def enabled_providers() -> list[LLMProvider]:
    return [p for p in _providers.values() if p.enabled]


def get_provider(name: str) -> LLMProvider | None:
    return _providers.get(name)
