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
        self, messages: list[ChatMessage], model: str | None = None
    ) -> AsyncIterator[str]:
        """Yield response text chunks. Override the configured model per call."""
        raise NotImplementedError
