import json
from datetime import datetime
from typing import Literal

from pydantic import BaseModel, EmailStr, Field, field_validator


class AttachmentSummary(BaseModel):
    """Compact record of a single attachment as rendered in the chat
    bubble. The actual extracted text + image_b64 are NOT stored here —
    this is for visual recall only ("you attached report.pdf"), not for
    re-running analysis."""
    filename: str
    kind: Literal["image", "file"]
    size: int = 0


class MessageOut(BaseModel):
    id: str
    role: Literal["user", "assistant"]
    provider: str | None = None
    content: str
    attachments_summary: list[AttachmentSummary] | None = None
    tokens_out: int | None = None
    latency_ms: int | None = None
    created_at: datetime

    @field_validator("attachments_summary", mode="before")
    @classmethod
    def _parse_attachments_summary(cls, v):
        # The DB column stores a JSON string; the wire format is a
        # parsed list. None / empty strings collapse to None so the
        # bubble renderer skips the chip row entirely.
        if v is None or isinstance(v, list):
            return v or None
        if isinstance(v, str):
            s = v.strip()
            if not s:
                return None
            try:
                parsed = json.loads(s)
            except json.JSONDecodeError:
                return None
            return parsed or None
        return v

    class Config:
        from_attributes = True


class SessionOut(BaseModel):
    id: str
    title: str
    workspace_id: str | None = None
    code_focused: bool = False
    # Optional chat-project (folder) id this session belongs to. None
    # = sits in the default ungrouped bucket on the sidebar.
    chat_project_id: str | None = None
    created_at: datetime
    updated_at: datetime

    class Config:
        from_attributes = True


class SessionDetail(SessionOut):
    messages: list[MessageOut] = []


class SessionCreate(BaseModel):
    title: str = "New chat"
    # When set, the new session is filed under this chat project so
    # "+ 새 대화" inside a project folder lands in that folder.
    chat_project_id: str | None = None


class SessionUpdate(BaseModel):
    title: str = Field(min_length=1, max_length=200)


class SessionMove(BaseModel):
    """PATCH /sessions/{id}/chat-project body. Pass `chat_project_id`
    to move; null detaches the session from any project."""
    chat_project_id: str | None = None


class ChatProjectOut(BaseModel):
    id: str
    name: str
    description: str
    instructions: str
    session_count: int = 0
    created_at: datetime
    updated_at: datetime

    class Config:
        from_attributes = True


class ChatProjectCreate(BaseModel):
    name: str = Field(min_length=1, max_length=120)
    description: str = Field(default="", max_length=2000)
    instructions: str = Field(default="", max_length=8000)


class ChatProjectUpdate(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=120)
    description: str | None = Field(default=None, max_length=2000)
    instructions: str | None = Field(default=None, max_length=8000)


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
SourceType = Literal["folder", "git", "url", "connection", "sftp", "upload"]


class RagUploadedFile(BaseModel):
    """One file living under the project's upload directory. Used by
    the manage view to list / delete user-supplied documents."""
    filename: str
    size: int
    modified_at: datetime
    # Per-file indexing status — same shape the code workspace tree
    # uses so the UI can render ✓ / ⊘ markers next to each row.
    # `index_status` is one of:
    #   "indexed"               body is in the current snapshot's index
    #   "pending"               uploaded but not yet indexed (or stale snapshot)
    #   "oversize"              skipped — file > rag_max_bytes_per_file
    #   "unsupported-ext"       skipped — extension not in the corpus allowlist
    #   "empty"                 0-byte file (chunker has nothing to do)
    #   "no-snapshot"           project has never been indexed
    index_status: str = "pending"
    chunk_count: int | None = None


class ProjectCreate(BaseModel):
    name: str = Field(min_length=1, max_length=120)
    source_type: SourceType
    source_ref: str = Field(min_length=1, max_length=500)
    ref: str | None = Field(default=None, max_length=120)  # git branch/tag
    corpus_type: CorpusType = "document"
    # Optional SELECT for the `connection` source — when set the
    # indexer runs it on every snapshot and embeds the result rows
    # alongside the reflected schema. Ignored for other source types.
    sql_query: str | None = Field(default=None, max_length=8000)
    # API list→detail collection (url source). When both set, the
    # indexer fetches the list URL, pulls api_detail_key from each
    # item, substitutes into api_detail_url's {key}, and embeds every
    # detail response.
    api_detail_key: str | None = Field(default=None, max_length=120)
    api_detail_url: str | None = Field(default=None, max_length=500)
    # Shared knowledge base — admin-only. When true, the project is
    # exposed to every role listed in `role_codes` and auto-searched
    # in chat for those users. Personal projects leave is_shared=False.
    is_shared: bool = False
    role_codes: list[str] = Field(default_factory=list, max_length=50)
    # How many snapshots to keep per project (0 = unlimited). After
    # each fresh snapshot the indexer drops anything older than the
    # N most recent + the currently-active one. Server-side defaults
    # cover absent fields from older clients.
    snapshot_retention_count: int = Field(default=10, ge=0, le=10000)


class PromptOut(BaseModel):
    id: str
    code: str
    name: str
    description: str | None = None
    body: str
    category: str | None = None
    tags: str | None = None
    is_shared: bool
    role_codes: list[str] = []
    owned: bool = True
    created_at: datetime
    updated_at: datetime

    class Config:
        from_attributes = True


class PromptCreate(BaseModel):
    code: str = Field(min_length=2, max_length=60, pattern=r"^[a-z0-9][a-z0-9_-]*$")
    name: str = Field(min_length=1, max_length=120)
    description: str = Field(default="", max_length=2000)
    body: str = Field(min_length=1, max_length=20000)
    category: str = Field(default="", max_length=40)
    tags: str = Field(default="", max_length=200)
    is_shared: bool = False
    role_codes: list[str] = Field(default_factory=list, max_length=50)


class PromptUpdate(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=120)
    description: str | None = Field(default=None, max_length=2000)
    body: str | None = Field(default=None, min_length=1, max_length=20000)
    category: str | None = Field(default=None, max_length=40)
    tags: str | None = Field(default=None, max_length=200)
    is_shared: bool | None = None
    role_codes: list[str] | None = Field(default=None, max_length=50)


class TranscriptOut(BaseModel):
    id: str
    source_filename: str
    size_bytes: int
    duration_sec: float | None = None
    status: str
    progress: float | None = None
    language: str | None = None
    diarized: bool = False
    session_id: str | None = None
    error: str | None = None
    created_at: datetime
    updated_at: datetime

    class Config:
        from_attributes = True


class WorkflowOut(BaseModel):
    id: str
    name: str
    description: str | None = None
    prompt_id: str
    prompt_name: str | None = None
    prompt_vars: dict | None = None
    project_id: str | None = None
    project_name: str | None = None
    model: str | None = None
    schedule_interval_minutes: int = 0
    enabled: bool = True
    last_run_at: datetime | None = None
    last_run_status: str | None = None
    last_session_id: str | None = None
    last_error: str | None = None
    created_at: datetime
    updated_at: datetime

    class Config:
        from_attributes = True


class WorkflowCreate(BaseModel):
    name: str = Field(min_length=1, max_length=120)
    description: str = Field(default="", max_length=2000)
    prompt_id: str = Field(min_length=1, max_length=36)
    prompt_vars: dict | None = None
    project_id: str | None = Field(default=None, max_length=36)
    model: str | None = Field(default=None, max_length=120)
    schedule_interval_minutes: int = 0
    enabled: bool = True


class WorkflowUpdate(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=120)
    description: str | None = Field(default=None, max_length=2000)
    prompt_id: str | None = Field(default=None, max_length=36)
    prompt_vars: dict | None = None
    project_id: str | None = Field(default=None, max_length=36)
    model: str | None = Field(default=None, max_length=120)
    schedule_interval_minutes: int | None = None
    enabled: bool | None = None


class ProjectAccessUpdate(BaseModel):
    """PATCH the role→project access list for a shared project."""
    role_codes: list[str] = Field(default_factory=list, max_length=50)


class ProjectUpdate(BaseModel):
    """PATCH editable fields on an existing project. All optional —
    backend touches only what's set. Changing source_ref / ref /
    sql_query / api_detail_* invalidates the current index and the
    router triggers a new snapshot."""
    name: str | None = Field(default=None, min_length=1, max_length=120)
    source_ref: str | None = Field(default=None, min_length=1, max_length=500)
    ref: str | None = Field(default=None, max_length=120)
    sql_query: str | None = Field(default=None, max_length=8000)
    api_detail_key: str | None = Field(default=None, max_length=120)
    api_detail_url: str | None = Field(default=None, max_length=500)
    is_shared: bool | None = None
    role_codes: list[str] | None = Field(default=None, max_length=50)
    snapshot_retention_count: int | None = Field(default=None, ge=0, le=10000)


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
    is_shared: bool = False
    sql_query: str | None = None
    api_detail_key: str | None = None
    api_detail_url: str | None = None
    snapshot_retention_count: int = 10
    # Populated for shared projects so the admin UI can render the
    # current role grants. Empty for personal projects.
    role_codes: list[str] = []
    # True when the requesting user owns this project (vs. accessing
    # it as a shared knowledge base). Lets the UI hide owner-only
    # controls (delete, reindex) for shared projects a user merely
    # consumes.
    owned: bool = True

    @field_validator(
        "snapshot_retention_count",
        "schedule_interval_minutes",
        "progress_done",
        "progress_total",
        "file_count",
        "chunk_count",
        mode="before",
    )
    @classmethod
    def _default_int(cls, v, info):
        # Pre-migration rows can come back with NULL for columns added
        # later (snapshot_retention_count, etc.). Pydantic's `int = N`
        # default kicks in only when the field is missing entirely,
        # not when the attribute exists with value None — so a single
        # legacy row would 500 the whole list endpoint. Substitute the
        # field-specific default here.
        if v is not None:
            return v
        defaults = {
            "snapshot_retention_count": 10,
            "schedule_interval_minutes": 0,
            "progress_done": 0,
            "progress_total": 0,
            "file_count": 0,
            "chunk_count": 0,
        }
        return defaults.get(info.field_name, 0)

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
    status: Literal["pending", "approved", "rejected", "suspended"] = "pending"
    # Free-form role code now that operators can define custom roles
    # in the dashboard. The built-in tier comes from a roles-table
    # join (see auth.require_role); the wire format is just the code.
    role: str = "user"
    approved_at: datetime | None = None
    rejection_reason: str | None = None
    suspension_reason: str | None = None
    signup_reason: str | None = None
    created_at: datetime

    class Config:
        from_attributes = True


# Admin-facing variant — same fields plus the approver's id, so the
# dashboard can show 'approved by ___' without an extra round trip.
class AdminUserOut(UserOut):
    approved_by_id: str | None = None
    suspended_at: datetime | None = None
    suspended_by_id: str | None = None
    updated_at: datetime
    # Additional roles beyond `role` (the primary). Sorted by code so
    # the dashboard's chip row is deterministic across reloads.
    extra_roles: list[str] = []


class RoleUpdateRequest(BaseModel):
    # Free-form code so an admin can assign any role defined in the
    # roles table — server-side validation rejects unknown codes.
    role: str = Field(min_length=1, max_length=40)


class UserRolesUpdateRequest(BaseModel):
    """PATCH /admin/users/{id}/roles body. Replaces the user's
    additional role grants with `role_codes`. The primary role
    (users.role) is not touched — that stays on its own endpoint."""
    role_codes: list[str] = Field(default_factory=list, max_length=200)


class RejectRequest(BaseModel):
    reason: str = Field(default="", max_length=500)


class SuspendRequest(BaseModel):
    reason: str = Field(default="", max_length=500)


class RoleOut(BaseModel):
    code: str
    name: str
    description: str | None = None
    base_role: Literal["admin", "moderator", "user"]
    is_system: bool
    created_at: datetime

    class Config:
        from_attributes = True


class RoleCreateRequest(BaseModel):
    code: str = Field(min_length=2, max_length=40, pattern=r"^[a-z][a-z0-9_-]*$")
    name: str = Field(min_length=1, max_length=80)
    description: str = Field(default="", max_length=500)
    base_role: Literal["admin", "moderator", "user"]


class RoleUpdateBody(BaseModel):
    # Only the display label and description are mutable. The code is
    # an identity column (changing it would orphan every user.role that
    # references it) and base_role is locked for system rows so the
    # built-in tier semantics stay intact.
    name: str | None = Field(default=None, min_length=1, max_length=80)
    description: str | None = Field(default=None, max_length=500)
    base_role: Literal["admin", "moderator", "user"] | None = None


class MergeLogRequest(BaseModel):
    """Body posted by the chat composer after a successful inline
    `/병합` so the backend can persist a two-message record of the
    exchange — the user's command and an assistant-style confirmation
    with the merged filename as an attachment chip."""
    user_prompt: str = Field(min_length=1, max_length=2000)
    source_filenames: list[str] = Field(default_factory=list, max_length=200)
    result_filename: str = Field(min_length=1, max_length=200)
    result_size: int = 0


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
