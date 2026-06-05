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
    workspace_id: str | None = None
    code_focused: bool = False
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

# Legacy values include "code" — kept in the type so the API can still
# return data for projects created before code was migrated to the
# Code tab (workspaces). New POSTs are rejected in the router.
CorpusType = Literal["code", "document", "api", "db"]
SourceType = Literal["folder", "git", "url", "connection", "sftp"]


class ProjectCreate(BaseModel):
    name: str = Field(min_length=1, max_length=120)
    source_type: SourceType
    source_ref: str = Field(min_length=1, max_length=500)
    ref: str | None = Field(default=None, max_length=120)  # git branch/tag
    corpus_type: CorpusType = "document"


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
    schedule_interval_minutes: int = 0
    last_indexed_at: datetime | None = None
    created_at: datetime

    class Config:
        from_attributes = True


# ── Code workspaces ───────────────────────────────────────────────────

class WorkspaceCreate(BaseModel):
    """Either flavour:
      - source_type="git": git_url required (default for backward
        compatibility with the original create form).
      - source_type="local": local_path required; git_url ignored.
    """
    name: str = Field(min_length=1, max_length=120)
    source_type: Literal["git", "local"] = "git"
    git_url: str = Field(default="", max_length=500)
    branch: str = Field(default="", max_length=120)
    auth_username: str | None = Field(default=None, max_length=120)
    auth_token: str | None = Field(default=None, max_length=500)
    local_path: str = Field(default="", max_length=500)


class WorkspaceOut(BaseModel):
    """No secrets — auth_token_encrypted and the decrypted token are
    never serialised back to the client. auth_username is kept so the
    user can recognise which account they wired up."""
    id: str
    name: str
    source_type: str = "git"
    git_url: str
    branch: str
    local_path: str = ""
    auth_username: str | None
    status: str
    error: str | None
    file_count: int
    size_bytes: int
    last_synced_at: datetime | None
    created_at: datetime

    class Config:
        from_attributes = True


class WorkspaceTreeEntry(BaseModel):
    name: str
    path: str  # relative to the workspace root, POSIX slashes
    kind: Literal["file", "dir"]
    size: int = 0
    children: list["WorkspaceTreeEntry"] = []


class WorkspaceFileContent(BaseModel):
    path: str
    text: str
    size: int
    truncated: bool = False
    method: str = "text"  # text | binary-skipped | too-large


class WorkspaceApply(BaseModel):
    """Write a single file's content into the workspace clone. The
    content is what the LLM emitted under the `# file: <path>` marker
    in the chat — no patch / hunk format, just the full new file."""
    path: str = Field(min_length=1, max_length=500)
    content: str = Field(max_length=2 * 1024 * 1024)


class WorkspaceStatusEntry(BaseModel):
    path: str
    x: str  # index status (1 char)
    y: str  # worktree status (1 char)
    status: str
    label: str


class WorkspaceCommitRequest(BaseModel):
    message: str = Field(min_length=1, max_length=4000)
    # Empty list → commit ALL dirty files (`git add -A`). Explicit
    # paths → only those paths. Keep validation light — the backend
    # also runs each path through `_safe_resolve`.
    paths: list[str] = Field(default_factory=list)
    # If true, immediately push to origin after a successful commit.
    push: bool = False


class ProjectScheduleUpdate(BaseModel):
    """Configure (or disable) the auto-refresh interval for a project.
    Validation range matches what the background scheduler actually
    cares about — sub-minute polling would just thrash, daily-or-less
    is what humans tend to set."""
    schedule_interval_minutes: int = Field(
        ge=0, le=60 * 24 * 30, description="0 = disabled"
    )


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
    # Optional free-text reason the applicant gives — surfaces in
    # the admin approval queue. Capped at 1000 chars so the UI
    # textarea can't be used as a DoS vector against the listing
    # endpoint.
    signup_reason: str = Field(default="", max_length=1000)


class LoginRequest(BaseModel):
    email: EmailStr
    password: str


class UserOut(BaseModel):
    id: str
    email: EmailStr
    name: str
    email_verified: bool
    status: Literal["pending", "approved", "rejected"] = "pending"
    role: Literal["user", "moderator", "admin"] = "user"
    approved_at: datetime | None = None
    rejection_reason: str | None = None
    signup_reason: str | None = None
    created_at: datetime

    class Config:
        from_attributes = True


# Admin-facing variant — same fields plus the approver's id, so the
# dashboard can show 'approved by ___' without an extra round trip.
class AdminUserOut(UserOut):
    approved_by_id: str | None = None
    updated_at: datetime


class RoleUpdateRequest(BaseModel):
    role: Literal["user", "moderator", "admin"]


class RejectRequest(BaseModel):
    reason: str = Field(default="", max_length=500)


class AppSettingsOut(BaseModel):
    """Snapshot of the runtime-toggleable app settings the admin
    dashboard reads/writes."""
    auto_approve_signups: bool


class AppSettingsUpdate(BaseModel):
    """Partial update — only fields provided are touched. Lets the
    UI PUT just the field it cares about without round-tripping
    everything."""
    auto_approve_signups: bool | None = None


class SignupResponse(BaseModel):
    """Returned from /signup — either a real login (when approval is
    disabled or the user is auto-approved as the bootstrap admin) or
    a 'pending' acknowledgement that does NOT carry an access token.
    The frontend branches on whether access_token is None."""
    user: UserOut
    access_token: str | None = None
    token_type: str = "bearer"
    expires_at: datetime | None = None
    status: Literal["pending", "approved"] = "pending"


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
