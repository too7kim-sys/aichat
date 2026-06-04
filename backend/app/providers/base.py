from abc import ABC, abstractmethod
from collections.abc import AsyncIterator
from dataclasses import dataclass


@dataclass
class ChatMessage:
    role: str  # user | assistant | system
    content: str


class LLMProvider(ABC):
    name: str
    label: str
    model: str

    @property
    def enabled(self) -> bool:
        return True

    @abstractmethod
    def stream(
        self,
        messages: list[ChatMessage],
        model: str | None = None,
        num_ctx_cap_override: int | None = None,
    ) -> AsyncIterator[str]:
        """Yield response text chunks. The chat router may pass a
        num_ctx_cap_override when it knows the picked model supports a
        larger native context than the global OLLAMA_NUM_CTX_MAX."""
        raise NotImplementedError
