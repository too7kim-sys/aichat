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
    # What kind of corpus this is — drives the chunker (line windows for
    # code, paragraph windows for documents, 조-boundary for Korean legal
    # text, endpoint-per-chunk for OpenAPI specs) and the retrieval
    # system-prompt hint.
    corpus_type: Mapped[str] = mapped_column(
        String(20), default="code", index=True
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
    tokens_out: Mapped[int | None] = mapped_column(Integer, nullable=True)
    latency_ms: Mapped[int | None] = mapped_column(Integer, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now())

    session: Mapped[Session] = relationship(back_populates="messages")
