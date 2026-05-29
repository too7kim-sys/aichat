from datetime import datetime
from typing import Literal

from pydantic import BaseModel, Field


class MessageOut(BaseModel):
    id: str
    role: Literal["user", "assistant"]
    provider: str | None = None
    content: str
    tokens_out: int | None = None
    latency_ms: int | None = None
    created_at: datetime

    class Config:
        from_attributes = True


class SessionOut(BaseModel):
    id: str
    title: str
    mode: Literal["single", "compare"]
    created_at: datetime
    updated_at: datetime

    class Config:
        from_attributes = True


class SessionDetail(SessionOut):
    messages: list[MessageOut] = []


class SessionCreate(BaseModel):
    title: str = "New chat"
    mode: Literal["single", "compare"] = "single"


class ChatRequest(BaseModel):
    prompt: str = Field(min_length=1)
    provider: str | None = None  # required for /chat, ignored for /compare
    web_search: bool = False


class ProviderInfo(BaseModel):
    name: str
    label: str
    model: str
    enabled: bool
