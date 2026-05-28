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
    def stream(self, messages: list[ChatMessage]) -> AsyncIterator[str]:
        """Yield response text chunks."""
        raise NotImplementedError
