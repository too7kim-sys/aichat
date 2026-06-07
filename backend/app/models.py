import uuid
from datetime import datetime

from sqlalchemy import Boolean, DateTime, ForeignKey, Integer, String, Text, func
from sqlalchemy.orm import Mapped, mapped_column, relationship

from .database import Base


def _uuid() -> str:
    return str(uuid.uuid4())


class User(Base):
    __tablename__ = "users"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_uuid)
    email: Mapped[str] = mapped_column(String(255), unique=True, index=True)
    password_hash: Mapped[str] = mapped_column(String(255))
    name: Mapped[str] = mapped_column(String(80), default="")
    email_verified: Mapped[bool] = mapped_column(Boolean, default=False)
    # Approval gating — pending users can't log in until a moderator
    # or admin flips them to "approved" (or "rejected", a terminal
    # state). Existing accounts at migration time are auto-marked
    # "approved" so nobody gets locked out by the rollout.
    status: Mapped[str] = mapped_column(
        String(20), default="pending", index=True,
    )
    role: Mapped[str] = mapped_column(String(20), default="user")
    approved_at: Mapped[datetime | None] = mapped_column(
        DateTime, nullable=True,
    )
    approved_by_id: Mapped[str | None] = mapped_column(
        String(36),
        ForeignKey("users.id", ondelete="SET NULL"),
        nullable=True,
    )
    rejection_reason: Mapped[str | None] = mapped_column(
        Text, nullable=True,
    )
    # Suspension — a separate status from rejection. Rejection is the
    # terminal answer for a signup that should never have been accepted;
    # suspension is a temporary block on an already-approved account
    # ("성지" / "정지") that an admin can lift later via the dashboard.
    # All three columns are nullable so the migration is non-breaking
    # for existing rows.
    suspended_at: Mapped[datetime | None] = mapped_column(
        DateTime, nullable=True,
    )
    suspended_by_id: Mapped[str | None] = mapped_column(
        String(36),
        ForeignKey("users.id", ondelete="SET NULL"),
        nullable=True,
    )
    suspension_reason: Mapped[str | None] = mapped_column(
        Text, nullable=True,
    )
    # Reason the user gave on the signup form — surfaces in the
    # admin queue so reviewers know what the account is for. Nullable
    # because existing accounts predate the field.
    signup_reason: Mapped[str | None] = mapped_column(
        Text, nullable=True,
    )
    created_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(
        DateTime, server_default=func.now(), onupdate=func.now()
    )

    sessions: Mapped[list["Session"]] = relationship(
        back_populates="user", cascade="all, delete-orphan"
    )
    email_tokens: Mapped[list["EmailToken"]] = relationship(
        back_populates="user", cascade="all, delete-orphan"
    )


class Role(Base):
    """Role definition — both built-in (admin/moderator/user) and
    operator-defined custom codes live in this single table. The
    `base_role` column maps any custom code to one of the three
    built-in permission tiers so `require_role()` keeps its simple
    semantics: a user with role 'editor' (base_role='moderator')
    passes every check that 'moderator' passes.

    Built-in rows are seeded at startup with `is_system=True` and
    cannot be deleted from the admin UI; their display name and
    description are still editable so operators can re-label them
    in Korean / domain-specific terms."""
    __tablename__ = "roles"

    code: Mapped[str] = mapped_column(String(40), primary_key=True)
    name: Mapped[str] = mapped_column(String(80))
    description: Mapped[str | None] = mapped_column(Text, nullable=True)
    # One of "admin" | "moderator" | "user" — the effective permission
    # tier for require_role() purposes.
    base_role: Mapped[str] = mapped_column(String(20))
    is_system: Mapped[bool] = mapped_column(Boolean, default=False)
    created_at: Mapped[datetime] = mapped_column(
        DateTime, server_default=func.now()
    )
    created_by_id: Mapped[str | None] = mapped_column(
        String(36),
        ForeignKey("users.id", ondelete="SET NULL"),
        nullable=True,
    )


class AppSetting(Base):
    """Tiny key/value store for runtime-toggleable app settings — the
    admin dashboard reads/writes through here so operators can flip
    behavior without a restart. Stays string-typed at rest;
    consumers parse on read."""
    __tablename__ = "app_settings"

    key: Mapped[str] = mapped_column(String(64), primary_key=True)
    value: Mapped[str] = mapped_column(String(256))
    updated_at: Mapped[datetime] = mapped_column(
        DateTime, server_default=func.now(), onupdate=func.now(),
    )
    updated_by_id: Mapped[str | None] = mapped_column(
        String(36),
        ForeignKey("users.id", ondelete="SET NULL"),
        nullable=True,
    )


class EmailToken(Base):
    """Short-lived single-use token for email verification or password reset.

    The raw token is only ever sent to the user via email; we store its
    SHA-256 hash so a DB leak doesn't grant an attacker live links."""
    __tablename__ = "email_tokens"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_uuid)
    user_id: Mapped[str] = mapped_column(
        ForeignKey("users.id", ondelete="CASCADE"), index=True
    )
    # "verify" or "reset" — keep loose for future kinds.
    kind: Mapped[str] = mapped_column(String(20), index=True)
    token_hash: Mapped[str] = mapped_column(String(64), unique=True, index=True)
    expires_at: Mapped[datetime] = mapped_column(DateTime, index=True)
    used_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now())

    user: Mapped[User] = relationship(back_populates="email_tokens")


class Session(Base):
    __tablename__ = "sessions"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_uuid)
    title: Mapped[str] = mapped_column(String(200), default="New chat")
    # Legacy column kept for backward compatibility with pre-existing
    # databases that still have a NOT NULL constraint on it. Always written
    # as "single" and never read by the current code.
    mode: Mapped[str] = mapped_column(String(20), default="single")
    # Nullable so pre-auth sessions stored before the user feature still
    # round-trip; new sessions are always owned by an authenticated user.
    user_id: Mapped[str | None] = mapped_column(
        ForeignKey("users.id", ondelete="CASCADE"), nullable=True, index=True
    )
    # Optional link to a RAG project — when set, the chat router runs
    # retrieval against this project's vector index on every turn and
    # injects the top-K chunks as system context.
    project_id: Mapped[str | None] = mapped_column(
        ForeignKey("projects.id", ondelete="SET NULL"), nullable=True, index=True
    )
    # Optional grouping into a chat-organisation "project" (distinct
    # from the RAG `projects` table). Lets the sidebar collect related
    # conversations under a named folder and apply shared per-project
    # instructions on every turn. Nullable so a fresh chat sits in the
    # default "기타" bucket until the user files it.
    chat_project_id: Mapped[str | None] = mapped_column(
        ForeignKey("chat_projects.id", ondelete="SET NULL"),
        nullable=True, index=True,
    )
    # Code-focused mode: when this session was kicked off from a Code
    # workspace, the workspace is pinned so the chat router auto-
    # attaches the project files on EVERY turn (instead of relying on
    # the user re-attaching them). code_focused also routes auto-mode
    # selection to MODEL_AUTO_CODE and injects a coding-specialised
    # system prompt at the head of every request.
    workspace_id: Mapped[str | None] = mapped_column(
        ForeignKey("code_workspaces.id", ondelete="SET NULL"),
        nullable=True, index=True,
    )
    code_focused: Mapped[bool] = mapped_column(Boolean, default=False)
    created_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(
        DateTime, server_default=func.now(), onupdate=func.now()
    )

    user: Mapped["User | None"] = relationship(back_populates="sessions")
    messages: Mapped[list["Message"]] = relationship(
        back_populates="session",
        cascade="all, delete-orphan",
        order_by="Message.created_at",
    )


class ChatProject(Base):
    """A named bucket the user files related chat sessions under.

    Distinct from the RAG `projects` table — `ChatProject` is purely
    an organisational folder for sessions in the sidebar. Optional
    `instructions` field acts as a per-folder system prompt that the
    chat router prepends on every turn for member sessions, so the
    user gets the same "house style / domain rules" treatment Claude.ai
    Projects offer without having to repeat it in each chat.
    """
    __tablename__ = "chat_projects"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_uuid)
    user_id: Mapped[str] = mapped_column(
        ForeignKey("users.id", ondelete="CASCADE"), index=True
    )
    name: Mapped[str] = mapped_column(String(120))
    description: Mapped[str] = mapped_column(Text, default="")
    # Optional system-prompt-style instructions injected on every chat
    # in this folder. Capped at a few KB so it can't blow the context
    # window on a long run of attached chunks.
    instructions: Mapped[str] = mapped_column(Text, default="")
    created_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(
        DateTime, server_default=func.now(), onupdate=func.now()
    )


class Project(Base):
    """A code-corpus the user has indexed for RAG retrieval.

    Indexing happens out-of-band (background task triggered by an API
    call) and writes embedding vectors into Qdrant under collection
    name `proj_<id>`. The DB row tracks lifecycle + counters so the
    UI can show progress and the chat router can decide whether
    retrieval is safe to attempt.
    """
    __tablename__ = "projects"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_uuid)
    user_id: Mapped[str] = mapped_column(
        ForeignKey("users.id", ondelete="CASCADE"), index=True
    )
    name: Mapped[str] = mapped_column(String(120))
    source_type: Mapped[str] = mapped_column(String(20))  # "folder" | "git"
    source_ref: Mapped[str] = mapped_column(String(500))  # path or git url
    # Optional SELECT used for the `connection` source type. When set,
    # the indexer runs the query against the live DB on every
    # snapshot and embeds the result rows alongside the reflected
    # CREATE TABLE DDL — turns the DB into a queryable RAG corpus
    # over actual data, not just schema. Nullable so non-DB projects
    # and DB projects that only need schema reflection are unaffected.
    sql_query: Mapped[str | None] = mapped_column(Text, nullable=True)
    # API "list → per-item detail" collection. When both are set for a
    # `url` source, the indexer fetches the list URL (source_ref),
    # extracts api_detail_key from each item, substitutes it into
    # api_detail_url's {key} placeholder, fetches every detail
    # response, and embeds them. Empty = list URL is embedded as-is
    # (plain OpenAPI/spec fetch).
    api_detail_key: Mapped[str | None] = mapped_column(
        String(120), nullable=True
    )
    api_detail_url: Mapped[str | None] = mapped_column(
        String(500), nullable=True
    )
    # What kind of corpus this is — drives the chunker (line windows for
    # code, paragraph windows for documents, 조-boundary for Korean legal
    # text, endpoint-per-chunk for OpenAPI specs) and the retrieval
    # system-prompt hint.
    corpus_type: Mapped[str] = mapped_column(
        String(20), default="code", index=True
    )
    # Shared knowledge base flag. When True the project is owned by an
    # admin and exposed to any user whose role is mapped in
    # project_role_access. Personal projects (the original model) keep
    # is_shared=False and stay scoped to their user_id owner.
    is_shared: Mapped[bool] = mapped_column(
        Boolean, default=False, index=True
    )
    # The vector index lives in a Snapshot row, not on Project itself
    # (the project is the logical group; snapshots are the versioned
    # instances). current_snapshot_id is the one chat retrieval uses
    # by default.
    current_snapshot_id: Mapped[str | None] = mapped_column(
        ForeignKey("project_snapshots.id", ondelete="SET NULL"),
        nullable=True, index=True,
    )
    # Lifecycle of the LATEST snapshot, mirrored onto the project row
    # so the UI can render a status without joining every refresh.
    # Older snapshots keep their own copy of these in their own rows.
    status: Mapped[str] = mapped_column(String(20), default="pending", index=True)
    progress_done: Mapped[int] = mapped_column(Integer, default=0)
    progress_total: Mapped[int] = mapped_column(Integer, default=0)
    file_count: Mapped[int] = mapped_column(Integer, default=0)
    chunk_count: Mapped[int] = mapped_column(Integer, default=0)
    error: Mapped[str | None] = mapped_column(Text, nullable=True)
    # Auto-refresh: every N minutes after the last successful index a
    # background loop kicks an incremental update (delta against the
    # files tracked in indexed_files for the current snapshot). 0
    # disables the schedule entirely.
    schedule_interval_minutes: Mapped[int] = mapped_column(Integer, default=0)
    last_indexed_at: Mapped[datetime | None] = mapped_column(
        DateTime, nullable=True
    )
    # How many snapshots to keep per project. After each fresh
    # snapshot lands "ready", anything older than the N most recent
    # (plus the active one) is purged — both the DB row and the
    # Qdrant collection — so a long-running auto-refresh schedule
    # doesn't accumulate hundreds of stale versions. 0 = unlimited.
    snapshot_retention_count: Mapped[int] = mapped_column(
        Integer, default=10
    )
    created_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(
        DateTime, server_default=func.now(), onupdate=func.now()
    )

    snapshots: Mapped[list["ProjectSnapshot"]] = relationship(
        back_populates="project",
        cascade="all, delete-orphan",
        foreign_keys="ProjectSnapshot.project_id",
        order_by="ProjectSnapshot.created_at.desc()",
    )


class Prompt(Base):
    """Reusable prompt template — body may carry {var} placeholders
    the chat composer fills in before sending. Mirrors the Project
    ownership model: personal (user_id only) or shared (is_shared +
    PromptRoleAccess grants). Code is the URL-safe slug used as a
    stable id, while name is the display label."""
    __tablename__ = "prompts"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_uuid)
    user_id: Mapped[str] = mapped_column(
        ForeignKey("users.id", ondelete="CASCADE"), index=True
    )
    code: Mapped[str] = mapped_column(String(60), unique=True, index=True)
    name: Mapped[str] = mapped_column(String(120))
    description: Mapped[str | None] = mapped_column(Text, nullable=True)
    body: Mapped[str] = mapped_column(Text)
    category: Mapped[str | None] = mapped_column(String(40), nullable=True)
    # Comma-separated tags for quick filter. Avoid a join table for v1
    # — the volume is tiny and full-text search isn't needed yet.
    tags: Mapped[str | None] = mapped_column(String(200), nullable=True)
    is_shared: Mapped[bool] = mapped_column(
        Boolean, default=False, index=True
    )
    created_at: Mapped[datetime] = mapped_column(
        DateTime, server_default=func.now()
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime, server_default=func.now(), onupdate=func.now()
    )


class PromptRoleAccess(Base):
    """M:N — which roles may use a shared prompt. Parallels
    ProjectRoleAccess so the access layer can resolve both with the
    same role/base_role inheritance logic."""
    __tablename__ = "prompt_role_access"

    prompt_id: Mapped[str] = mapped_column(
        String(36),
        ForeignKey("prompts.id", ondelete="CASCADE"),
        primary_key=True,
    )
    role_code: Mapped[str] = mapped_column(
        String(40),
        ForeignKey("roles.code", ondelete="CASCADE"),
        primary_key=True,
    )
    created_at: Mapped[datetime] = mapped_column(
        DateTime, server_default=func.now()
    )


class ProjectRoleAccess(Base):
    """M:N — which roles may use a shared knowledge-base project. A
    user whose `role` (or its base_role) is listed here gets the
    project in their accessible set, which the chat router then
    auto-searches on every turn (question-driven, score-gated). Only
    meaningful for projects with is_shared=True."""
    __tablename__ = "project_role_access"

    project_id: Mapped[str] = mapped_column(
        String(36),
        ForeignKey("projects.id", ondelete="CASCADE"),
        primary_key=True,
    )
    role_code: Mapped[str] = mapped_column(
        String(40),
        ForeignKey("roles.code", ondelete="CASCADE"),
        primary_key=True,
    )
    created_at: Mapped[datetime] = mapped_column(
        DateTime, server_default=func.now()
    )


class ProjectSnapshot(Base):
    """A versioned index of a Project. Every reindex creates a new
    snapshot (with its own Qdrant collection) instead of overwriting
    the previous one, so the user can roll back to an older index
    or compare the latest against a snapshot from N weeks ago.
    """
    __tablename__ = "project_snapshots"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_uuid)
    project_id: Mapped[str] = mapped_column(
        ForeignKey("projects.id", ondelete="CASCADE"), index=True
    )
    label: Mapped[str] = mapped_column(String(120), default="")  # user-facing tag
    # pending | indexing | ready | failed
    status: Mapped[str] = mapped_column(String(20), default="pending", index=True)
    progress_done: Mapped[int] = mapped_column(Integer, default=0)
    progress_total: Mapped[int] = mapped_column(Integer, default=0)
    file_count: Mapped[int] = mapped_column(Integer, default=0)
    chunk_count: Mapped[int] = mapped_column(Integer, default=0)
    error: Mapped[str | None] = mapped_column(Text, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now())

    project: Mapped[Project] = relationship(
        back_populates="snapshots", foreign_keys=[project_id]
    )


class Transcript(Base):
    """Audio file transcribed (+ optionally diarized) into a chat
    Session. Tracks the pipeline stage so the UI can show a meaningful
    progress label while the heavy work runs in the background."""
    __tablename__ = "transcripts"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_uuid)
    user_id: Mapped[str] = mapped_column(
        ForeignKey("users.id", ondelete="CASCADE"), index=True
    )
    source_filename: Mapped[str] = mapped_column(String(255))
    # Bytes on disk so the UI can show "10.4 MB".
    size_bytes: Mapped[int] = mapped_column(Integer, default=0)
    duration_sec: Mapped[float | None] = mapped_column(
        nullable=True
    )
    # pending | transcribing | diarizing | summarizing | ok | failed
    status: Mapped[str] = mapped_column(
        String(20), default="pending", index=True
    )
    # 0..1 progress within the active stage (Whisper exposes segment-
    # level callbacks we average here). NULL until first update.
    progress: Mapped[float | None] = mapped_column(nullable=True)
    language: Mapped[str | None] = mapped_column(String(8), nullable=True)
    diarized: Mapped[bool] = mapped_column(Boolean, default=False)
    session_id: Mapped[str | None] = mapped_column(
        String(36), nullable=True
    )
    error: Mapped[str | None] = mapped_column(Text, nullable=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime, server_default=func.now()
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime, server_default=func.now(), onupdate=func.now()
    )


class Workflow(Base):
    """Automated chat — a prompt + variable values + optional RAG
    project + optional schedule. Each run creates a new chat session
    (so users see results in their normal session list) and posts
    the rendered prompt + AI reply there."""
    __tablename__ = "workflows"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_uuid)
    user_id: Mapped[str] = mapped_column(
        ForeignKey("users.id", ondelete="CASCADE"), index=True
    )
    name: Mapped[str] = mapped_column(String(120))
    description: Mapped[str | None] = mapped_column(Text, nullable=True)
    prompt_id: Mapped[str] = mapped_column(
        ForeignKey("prompts.id", ondelete="CASCADE")
    )
    # JSON object: {var_name: value}. Rendered into prompt.body's
    # {var_name} placeholders at run time.
    prompt_vars: Mapped[str | None] = mapped_column(Text, nullable=True)
    project_id: Mapped[str | None] = mapped_column(
        ForeignKey("projects.id", ondelete="SET NULL"),
        nullable=True,
    )
    # Optional Ollama model override. NULL → use OLLAMA_MODEL default.
    model: Mapped[str | None] = mapped_column(String(120), nullable=True)
    # Wall-clock schedule, same shape as Project.schedule_interval_minutes.
    # 0 = manual only.
    schedule_interval_minutes: Mapped[int] = mapped_column(Integer, default=0)
    enabled: Mapped[bool] = mapped_column(Boolean, default=True)
    last_run_at: Mapped[datetime | None] = mapped_column(
        DateTime, nullable=True
    )
    last_run_status: Mapped[str | None] = mapped_column(
        String(20), nullable=True
    )
    last_session_id: Mapped[str | None] = mapped_column(
        String(36), nullable=True
    )
    last_error: Mapped[str | None] = mapped_column(Text, nullable=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime, server_default=func.now()
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime, server_default=func.now(), onupdate=func.now()
    )


class IndexedFile(Base):
    """Per-snapshot record of every file that contributed chunks to
    the vector index. The incremental indexer compares the current
    source tree against these rows so a re-run only re-embeds files
    whose hash actually changed."""
    __tablename__ = "indexed_files"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_uuid)
    snapshot_id: Mapped[str] = mapped_column(
        ForeignKey("project_snapshots.id", ondelete="CASCADE"), index=True
    )
    # Path relative to the corpus root, exactly as it shows up in
    # chunk payloads (so we can DELETE matching points by filename).
    filename: Mapped[str] = mapped_column(String(500), index=True)
    # SHA-256 of the file body, hex-encoded.
    file_hash: Mapped[str] = mapped_column(String(64), index=True)
    size: Mapped[int] = mapped_column(Integer, default=0)
    chunk_count: Mapped[int] = mapped_column(Integer, default=0)
    indexed_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now())


class CodeWorkspace(Base):
    """A git repo cloned to a per-user directory on disk that the
    Code tab browses, syncs, and (in later phases) commits + pushes
    back to. Lives separately from RAG projects — the RAG project
    just embeds a corpus for retrieval; a CodeWorkspace is a working
    copy the user (and later the AI) can read, edit, and commit."""
    __tablename__ = "code_workspaces"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_uuid)
    user_id: Mapped[str] = mapped_column(
        ForeignKey("users.id", ondelete="CASCADE"), index=True
    )
    name: Mapped[str] = mapped_column(String(120))
    # "git"   — repo cloned into per-user workspace_dir
    # "local" — user-registered folder already on the filesystem
    source_type: Mapped[str] = mapped_column(
        String(16), default="git", server_default="git", index=True
    )
    git_url: Mapped[str] = mapped_column(String(500), default="")
    branch: Mapped[str] = mapped_column(String(120), default="")
    # Absolute path the workspace lives at on disk. For "git" sources
    # this is the per-user clone destination (workspace_dir/user_id/
    # workspace_id). For "local" sources it's the user-supplied folder
    # validated against settings.workspace_local_root_list.
    local_path: Mapped[str] = mapped_column(String(500), default="")
    # Credentials encrypted at rest via app.crypto. Either field may
    # be empty for repos that allow anonymous read, or when the user
    # has set up SSH keys at the OS level.
    auth_username: Mapped[str | None] = mapped_column(String(120), nullable=True)
    auth_token_encrypted: Mapped[str | None] = mapped_column(
        Text, nullable=True
    )
    # cloning | ready | failed
    status: Mapped[str] = mapped_column(String(20), default="cloning", index=True)
    error: Mapped[str | None] = mapped_column(Text, nullable=True)
    file_count: Mapped[int] = mapped_column(Integer, default=0)
    size_bytes: Mapped[int] = mapped_column(Integer, default=0)
    last_synced_at: Mapped[datetime | None] = mapped_column(
        DateTime, nullable=True
    )
    created_at: Mapped[datetime] = mapped_column(
        DateTime, server_default=func.now()
    )


class AuditLog(Base):
    __tablename__ = "audit_log"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_uuid)
    # Nullable so login_fail / signup_fail events for unknown users are
    # still recorded for forensic value.
    user_id: Mapped[str | None] = mapped_column(
        ForeignKey("users.id", ondelete="CASCADE"), nullable=True, index=True
    )
    event: Mapped[str] = mapped_column(String(40), index=True)
    ip: Mapped[str] = mapped_column(String(64), default="")
    user_agent: Mapped[str] = mapped_column(String(255), default="")
    detail: Mapped[str] = mapped_column(String(255), default="")
    created_at: Mapped[datetime] = mapped_column(
        DateTime, server_default=func.now(), index=True
    )


class Message(Base):
    __tablename__ = "messages"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_uuid)
    session_id: Mapped[str] = mapped_column(
        ForeignKey("sessions.id", ondelete="CASCADE"), index=True
    )
    role: Mapped[str] = mapped_column(String(20))  # user | assistant
    provider: Mapped[str | None] = mapped_column(String(40), nullable=True)
    content: Mapped[str] = mapped_column(Text)
    # JSON-serialised list of attachment summaries that travelled with
    # the user prompt (NEVER assistant). Just {filename, kind, size} —
    # no image_b64 or extracted text, both because they'd bloat the
    # row and because the row's job here is to render a compact chip
    # in the bubble, not to replay the attachment.
    attachments_summary: Mapped[str | None] = mapped_column(
        Text, nullable=True,
    )
    tokens_out: Mapped[int | None] = mapped_column(Integer, nullable=True)
    latency_ms: Mapped[int | None] = mapped_column(Integer, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now())

    session: Mapped[Session] = relationship(back_populates="messages")
