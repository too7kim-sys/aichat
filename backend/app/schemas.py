from datetime import datetime
from typing import Literal

from pydantic import BaseModel, EmailStr, Field


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
    # base64 of the original image bytes — only set for image
    # attachments. Forwarded to Ollama's vision API as the "images"
    # field of the user message when the routed model can actually
    # see images.
    image_b64: str | None = None


class ChatRequest(BaseModel):
    prompt: str = Field(min_length=1)
    provider: str | None = None
    model: str | None = None  # per-request override of the provider's default
    web_search: bool = False
    attachments: list[AttachmentIn] = []
    # Optional: retrieve context from an indexed project. When set, the
    # chat router runs a vector search before generation and injects the
    # top-K matching chunks as system context.
    project_id: str | None = None


# ── RAG / Projects ────────────────────────────────────────────────────

CorpusType = Literal["code", "document", "legal", "api", "db"]


class ProjectCreate(BaseModel):
    name: str = Field(min_length=1, max_length=120)
    source_type: Literal["folder", "git"]
    source_ref: str = Field(min_length=1, max_length=500)
    ref: str | None = Field(default=None, max_length=120)  # git branch/tag
    corpus_type: CorpusType = "code"


class SnapshotOut(BaseModel):
    id: str
    label: str
    status: str
    progress_done: int
    progress_total: int
    file_count: int
    chunk_count: int
    error: str | None
    created_at: datetime

    class Config:
        from_attributes = True


class ProjectOut(BaseModel):
    id: str
    name: str
    source_type: str
    source_ref: str
    corpus_type: str
    status: str
    progress_done: int
    progress_total: int
    file_count: int
    chunk_count: int
    error: str | None
    current_snapshot_id: str | None
    snapshots: list[SnapshotOut] = []
    created_at: datetime

    class Config:
        from_attributes = True


class ProviderInfo(BaseModel):
    name: str
    label: str
    model: str
    enabled: bool


# ── Auth ─────────────────────────────────────────────────────────────

class SignupRequest(BaseModel):
    email: EmailStr
    password: str = Field(min_length=8, max_length=128)
    name: str = Field(default="", max_length=80)


class LoginRequest(BaseModel):
    email: EmailStr
    password: str


class UserOut(BaseModel):
    id: str
    email: EmailStr
    name: str
    email_verified: bool
    created_at: datetime

    class Config:
        from_attributes = True


class VerifyRequest(BaseModel):
    token: str = Field(min_length=8, max_length=128)


class PasswordResetRequest(BaseModel):
    email: EmailStr


class PasswordResetConfirm(BaseModel):
    token: str = Field(min_length=8, max_length=128)
    new_password: str = Field(min_length=8, max_length=128)


class AuthResponse(BaseModel):
    user: UserOut
    access_token: str
    token_type: str = "bearer"
    expires_at: datetime


class UserUpdate(BaseModel):
    name: str | None = Field(default=None, max_length=80)
    current_password: str | None = None
    new_password: str | None = Field(default=None, min_length=8, max_length=128)


class AuditEvent(BaseModel):
    id: str
    event: str
    ip: str
    user_agent: str
    detail: str
    created_at: datetime

    class Config:
        from_attributes = True
