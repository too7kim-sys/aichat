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


class ChatRequest(BaseModel):
    prompt: str = Field(min_length=1)
    provider: str | None = None
    web_search: bool = False
    attachments: list[AttachmentIn] = []


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
