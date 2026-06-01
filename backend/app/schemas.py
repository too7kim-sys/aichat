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
    created_at: datetime
    updated_at: datetime

    class Config:
        from_attributes = True


class SessionDetail(SessionOut):
    messages: list[MessageOut] = []


class SessionCreate(BaseModel):
    title: str = "New chat"


class SessionUpdate(BaseModel):
    title: str = Field(min_length=1, max_length=200)


class AttachmentIn(BaseModel):
    filename: str
    text: str


class ChatRequest(BaseModel):
    prompt: str = Field(min_length=1)
    provider: str | None = None
    model: str | None = None  # per-request override of the provider's default
    web_search: bool = False
    attachments: list[AttachmentIn] = []


class ProviderInfo(BaseModel):
    name: str
    label: str
    model: str
    enabled: bool
