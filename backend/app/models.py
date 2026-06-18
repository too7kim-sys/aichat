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
    # 토큰 무효화 컷오프. JWT 의 iat (issued-at) 이 이 시각보다 이전인
    # 토큰은 무효 처리. 관리자가 "강제 로그아웃" 을 누르면 여기를 now()
    # 로 갱신해 발급된 모든 토큰을 즉시 만료. 사용자 본인이 비밀번호
    # 변경 시에도 같은 작업으로 옛 세션 모두 끊긴다.
    tokens_invalidated_at: Mapped[datetime | None] = mapped_column(
        DateTime, nullable=True,
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


class UserRole(Base):
    """Additional roles assigned to a user beyond the primary one
    stored in `users.role`. Lets the operator grant multiple roles
    per person — e.g. a member of both "법무" and "재무" sees shared
    knowledge bases mapped to either code — without changing the
    primary-role semantics auth.require_role() already builds on.

    The primary role is NOT mirrored in this table; the effective
    role set the access layer computes is `{user.role} ∪ user_roles`.
    """
    __tablename__ = "user_roles"

    user_id: Mapped[str] = mapped_column(
        String(36),
        ForeignKey("users.id", ondelete="CASCADE"),
        primary_key=True,
        index=True,
    )
    role_code: Mapped[str] = mapped_column(
        String(40),
        ForeignKey("roles.code", ondelete="CASCADE"),
        primary_key=True,
        index=True,
    )
    created_at: Mapped[datetime] = mapped_column(
        DateTime, server_default=func.now()
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
    # Optional link back to the workflow that auto-generated this
    # session. Used by the runner to enforce per-workflow retention
    # (keep N most recent auto-runs, delete older). NULL for normal
    # user chats. SET NULL on workflow delete so deleting a workflow
    # leaves its historical sessions untouched.
    workflow_id: Mapped[str | None] = mapped_column(
        ForeignKey("workflows.id", ondelete="SET NULL"),
        nullable=True, index=True,
    )
    # 사용자가 사이드바 상단에 고정한 세션 (#29).
    pinned: Mapped[bool] = mapped_column(Boolean, default=False, index=True)
    # 휴지통 (#31). NULL = 정상, 값 있으면 삭제된 시각.  30일 지나면
    # lifespan 시작 시 영구 삭제 (error_log.prune 처럼).
    deleted_at: Mapped[datetime | None] = mapped_column(
        DateTime, nullable=True, index=True
    )
    # 세션 비밀번호 잠금 (#52).  설정되면 GET 시 X-Session-Passphrase
    # 헤더로 같은 해시를 보내야 본문 열람 가능.  NULL = 잠금 없음.
    # 평문 비밀번호는 저장하지 않으며 SHA-256 해시만.
    passphrase_hash: Mapped[str | None] = mapped_column(
        String(64), nullable=True
    )
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

    @property
    def has_passphrase(self) -> bool:
        return bool(self.passphrase_hash)


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
    # 팀 공유 (#89) — 역할-맵 외 팀 단위 공유.
    team_id: Mapped[str | None] = mapped_column(
        String(36), nullable=True, index=True
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
    # 팀 공유 (#89) — 역할-맵 외에 팀 단위 공유.
    team_id: Mapped[str | None] = mapped_column(
        String(36), nullable=True, index=True
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
    # 공휴일에는 자동 실행 안 함 (한국 공휴일 + .env 사내 휴일). 사용자가
    # 워크플로별로 켜고 끌 수 있게 — 새벽 보고 같은 데일리 잡은 끄는 게
    # 보통, 시스템 헬스체크 같은 건 그대로 두는 게 보통.
    skip_holidays: Mapped[bool] = mapped_column(Boolean, default=False)
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
    # 팀 공유 (#89) — set 되면 그 팀 멤버가 모두 보고 실행 가능.
    team_id: Mapped[str | None] = mapped_column(
        String(36), nullable=True, index=True
    )
    # 승인 게이트 (#91) — true 면 run 요청이 즉시 실행되지 않고
    # 'pending_approval' 상태로 들어가, 팀 owner 가 approve 해야 진행.
    requires_approval: Mapped[bool] = mapped_column(Boolean, default=False)
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
    # When true, the chat panel hides the message body in a collapsed
    # placeholder ("원문 전사 — 클릭해서 펼치기"). Used by the
    # transcription pipeline so the raw whisper output doesn't flood
    # the bubble row, while keeping the message in the DB so the
    # export modal / RAG indexer can still see it.
    hidden: Mapped[bool] = mapped_column(Boolean, default=False)
    # 사용자가 별표(즐겨찾기)한 메시지. "내가 별표한 답변" 모아보기에 사용.
    starred: Mapped[bool] = mapped_column(Boolean, default=False)
    # 답변 평가 — 1 (좋아요) / -1 (싫어요) / 0 (미평가).
    feedback: Mapped[int] = mapped_column(Integer, default=0)
    # 평가에 덧붙이는 자유 메모 (선택). 최대 500 자.
    feedback_note: Mapped[str | None] = mapped_column(
        String(500), nullable=True,
    )
    # 👎 의 사유 분류 (#121) — 'inaccurate' | 'incomplete' | 'irrelevant'
    # | 'unsafe' | 'other'.  feedback=-1 일 때만 의미가 있다.
    feedback_category: Mapped[str | None] = mapped_column(
        String(20), nullable=True,
    )
    # 1~5 별점 (#122).  None = 미평가.  feedback 토글과 독립 — 한 답변에
    # 👍 + 4성 같은 조합이 가능.
    rating: Mapped[int | None] = mapped_column(nullable=True)
    # 운영자 escalation flag (#123).  사용자가 'AI 가 못 풀었어요' 를
    # 명시적으로 누르면 시각을 박고 운영자 inbox 에 알림이 들어간다.
    # escalation 이 resolved 되면 운영자가 ack 시각을 기록.
    escalated_at: Mapped[datetime | None] = mapped_column(
        DateTime, nullable=True, index=True,
    )
    escalated_reason: Mapped[str | None] = mapped_column(
        String(500), nullable=True,
    )
    escalation_ack_at: Mapped[datetime | None] = mapped_column(
        DateTime, nullable=True,
    )
    escalation_ack_by_id: Mapped[str | None] = mapped_column(
        String(36),
        ForeignKey("users.id", ondelete="SET NULL"),
        nullable=True,
    )
    # 자유 태그 (#32) — JSON 문자열로 직렬화된 string[].  최대 8개.
    tags: Mapped[str | None] = mapped_column(Text, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now())

    session: Mapped[Session] = relationship(back_populates="messages")


class ErrorLog(Base):
    """중앙 집중식 오류 기록 — FastAPI 미들웨어 + 로깅 핸들러가 이쪽에
    한 줄씩 적어 둠.  '오류 모니터링' 패널이 이 테이블을 읽어 최근 N개
    노출.  Transcript/Project/Workflow 의 status='failed' 외에 채팅 /
    파일 / 인증 등 잡다한 백엔드 에러가 여기 모임.
    """

    __tablename__ = "error_logs"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_uuid)
    # ERROR / WARNING / EXCEPTION — 우선순위 분류용.
    level: Mapped[str] = mapped_column(String(16), default="ERROR", index=True)
    # chat / files / auth / search / system 등 모듈 단위 태그.
    source: Mapped[str] = mapped_column(String(40), default="system", index=True)
    # 한 줄짜리 사람 친화 메시지. UI 에 1차로 표시.
    message: Mapped[str] = mapped_column(String(1000), default="")
    # 풀 traceback (있을 때).  표 셀에는 줄여 노출하고 클릭 시 펼치기.
    traceback: Mapped[str | None] = mapped_column(Text, nullable=True)
    # 요청 경로 / 메서드 / 상태 코드 — 미들웨어가 채움.
    path: Mapped[str | None] = mapped_column(String(255), nullable=True)
    method: Mapped[str | None] = mapped_column(String(10), nullable=True)
    status_code: Mapped[int | None] = mapped_column(Integer, nullable=True)
    # 발생 사용자 (있으면) — 익명 요청은 NULL.
    user_id: Mapped[str | None] = mapped_column(
        ForeignKey("users.id", ondelete="SET NULL"),
        nullable=True,
        index=True,
    )
    # 요청 IP / user-agent — 디버깅에 종종 필요.
    ip: Mapped[str | None] = mapped_column(String(64), nullable=True)
    user_agent: Mapped[str | None] = mapped_column(String(255), nullable=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime, server_default=func.now(), index=True
    )


class UserMacro(Base):
    """사용자 슬래시 매크로 (#33).  composer 에서 `/` 누르면 SlashPrompt
    Picker 가 시스템 prompts + 사용자 매크로를 함께 보여줌. 매크로는
    사용자 본인 소유라 다른 계정에는 보이지 않음."""

    __tablename__ = "user_macros"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_uuid)
    user_id: Mapped[str] = mapped_column(
        ForeignKey("users.id", ondelete="CASCADE"), index=True
    )
    # 단축어 (예: "내인사", "공통서명") — slash 뒤에 입력하면 매칭.
    name: Mapped[str] = mapped_column(String(80))
    # 실제 prompt 본문 — 선택 시 textarea 에 그대로 prefill.
    body: Mapped[str] = mapped_column(Text)
    created_at: Mapped[datetime] = mapped_column(
        DateTime, server_default=func.now()
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime, server_default=func.now(), onupdate=func.now()
    )


class SessionShare(Base):
    """공유 가능한 읽기 토큰 (#38).  같은 워크스페이스 내의 다른 인증
    사용자가 토큰 URL 로 세션을 읽을 수 있게.  외부 anon 노출은 폐쇄망
    원칙상 비활성 — 토큰 + 로그인 모두 요구."""

    __tablename__ = "session_shares"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_uuid)
    session_id: Mapped[str] = mapped_column(
        ForeignKey("sessions.id", ondelete="CASCADE"), index=True
    )
    # URL 안전 랜덤 토큰 — secrets.token_urlsafe(24) 권장.  unique 인덱스.
    token: Mapped[str] = mapped_column(String(64), unique=True, index=True)
    # 만들었던 사용자 (cascade SET NULL — 사용자 탈퇴해도 링크는 유효).
    created_by_id: Mapped[str | None] = mapped_column(
        String(36),
        ForeignKey("users.id", ondelete="SET NULL"),
        nullable=True,
    )
    # 만료 시각.  NULL = 무기한 (사용자 직접 revoke 까지).
    expires_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime, server_default=func.now()
    )


class ApiKey(Base):
    """사용자 발급 API 키 (#45).  외부 시스템이 채팅 / RAG API 를
    호출할 때 사용.  실제 토큰은 평문으로 한 번만 보여주고, DB 에는
    SHA-256 해시만 저장 — DB 유출 시 토큰 자체는 복구 불가."""

    __tablename__ = "api_keys"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_uuid)
    user_id: Mapped[str] = mapped_column(
        ForeignKey("users.id", ondelete="CASCADE"), index=True
    )
    # 사용자가 키를 구분할 수 있는 라벨 (예: "n8n 워크플로", "사내 봇").
    label: Mapped[str] = mapped_column(String(80), default="")
    # SHA-256(token).  request 가 들어올 때 같은 방식으로 해시해 비교.
    token_hash: Mapped[str] = mapped_column(
        String(64), unique=True, index=True
    )
    # 토큰의 첫 8자만 라벨용으로 노출 ("aichat_5e3f....").  전체 토큰은
    # 발급 직후 한 번만 반환.
    token_prefix: Mapped[str] = mapped_column(String(16), default="")
    expires_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    last_used_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime, server_default=func.now()
    )


class SystemMacro(Base):
    """관리자가 등록한 팀 공유 매크로 (#48).  모든 사용자의 슬래시
    picker 에 시스템 매크로 섹션으로 노출.  UserMacro 와 별 컬럼만
    빼면 동일."""

    __tablename__ = "system_macros"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_uuid)
    name: Mapped[str] = mapped_column(String(80), unique=True, index=True)
    body: Mapped[str] = mapped_column(Text)
    # 누가 마지막으로 수정했는지 — 운영 감사용.
    updated_by_id: Mapped[str | None] = mapped_column(
        String(36),
        ForeignKey("users.id", ondelete="SET NULL"),
        nullable=True,
    )
    created_at: Mapped[datetime] = mapped_column(
        DateTime, server_default=func.now()
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime, server_default=func.now(), onupdate=func.now()
    )


class CodeSnippet(Base):
    """코드 스니펫 (#71).  사용자가 자주 쓰는 코드 패턴을 저장.  scope
    = 'personal' 은 본인만, 'team' 은 모두 (관리자가 만든다)."""

    __tablename__ = "code_snippets"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_uuid)
    user_id: Mapped[str | None] = mapped_column(
        String(36),
        ForeignKey("users.id", ondelete="CASCADE"),
        nullable=True,
        index=True,
    )
    scope: Mapped[str] = mapped_column(String(16), default="personal", index=True)
    name: Mapped[str] = mapped_column(String(80))
    body: Mapped[str] = mapped_column(Text)
    # 언어 태그 — Monaco 에서 syntax 강조에 사용 (선택).
    language: Mapped[str] = mapped_column(String(40), default="")
    description: Mapped[str] = mapped_column(String(200), default="")
    created_at: Mapped[datetime] = mapped_column(
        DateTime, server_default=func.now()
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime, server_default=func.now(), onupdate=func.now()
    )


# ── 팀 / 그룹 (#89) ──────────────────────────────────────────
class Team(Base):
    """팀 — 사내 협업 단위.  프롬프트·워크플로·RAG·매크로 공유의 기본
    그룹.  역할(Role)이 권한 차원이라면 Team 은 '누구와 같이 쓰는지'."""

    __tablename__ = "teams"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_uuid)
    name: Mapped[str] = mapped_column(String(80), unique=True, index=True)
    description: Mapped[str] = mapped_column(String(500), default="")
    created_by_id: Mapped[str | None] = mapped_column(
        String(36), ForeignKey("users.id", ondelete="SET NULL"), nullable=True,
    )
    created_at: Mapped[datetime] = mapped_column(
        DateTime, server_default=func.now()
    )


class TeamMember(Base):
    """팀 멤버십 — role 은 'owner' | 'member' (팀 내부 권한)."""

    __tablename__ = "team_members"

    team_id: Mapped[str] = mapped_column(
        String(36),
        ForeignKey("teams.id", ondelete="CASCADE"),
        primary_key=True,
        index=True,
    )
    user_id: Mapped[str] = mapped_column(
        String(36),
        ForeignKey("users.id", ondelete="CASCADE"),
        primary_key=True,
        index=True,
    )
    role: Mapped[str] = mapped_column(String(20), default="member")
    created_at: Mapped[datetime] = mapped_column(
        DateTime, server_default=func.now()
    )


# ── 워크플로 실행 이력 (#90) ─────────────────────────────────
class WorkflowRun(Base):
    """매 워크플로 실행의 입출력 기록.  Workflow.last_run_* 가 마지막
    한 줄만 남기는 한계 보완 — 비교·재실행·감사용."""

    __tablename__ = "workflow_runs"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_uuid)
    workflow_id: Mapped[str] = mapped_column(
        String(36),
        ForeignKey("workflows.id", ondelete="CASCADE"),
        index=True,
    )
    triggered_by_id: Mapped[str | None] = mapped_column(
        String(36), ForeignKey("users.id", ondelete="SET NULL"), nullable=True,
    )
    # 입력 — prompt vars JSON 스냅샷 (워크플로 정의가 변해도 그 시점 그대로).
    prompt_vars: Mapped[str | None] = mapped_column(Text, nullable=True)
    # 출력 — 생성된 채팅 세션 (= 답변 본문).
    session_id: Mapped[str | None] = mapped_column(
        String(36),
        ForeignKey("sessions.id", ondelete="SET NULL"),
        nullable=True,
    )
    status: Mapped[str] = mapped_column(String(20), default="pending", index=True)
    error: Mapped[str | None] = mapped_column(Text, nullable=True)
    started_at: Mapped[datetime] = mapped_column(
        DateTime, server_default=func.now(), index=True
    )
    finished_at: Mapped[datetime | None] = mapped_column(
        DateTime, nullable=True
    )


# ── 회의록 액션아이템 (#92) ──────────────────────────────────
class ActionItem(Base):
    """회의록에서 LLM 이 추출한 '할 일' / 결정사항.  칸반 상태로 관리."""

    __tablename__ = "action_items"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_uuid)
    transcript_id: Mapped[str | None] = mapped_column(
        String(36),
        ForeignKey("transcripts.id", ondelete="SET NULL"),
        nullable=True,
        index=True,
    )
    session_id: Mapped[str | None] = mapped_column(
        String(36),
        ForeignKey("sessions.id", ondelete="SET NULL"),
        nullable=True,
        index=True,
    )
    # 'todo' | 'doing' | 'done' (칸반 컬럼).
    status: Mapped[str] = mapped_column(String(16), default="todo", index=True)
    title: Mapped[str] = mapped_column(String(300))
    detail: Mapped[str | None] = mapped_column(Text, nullable=True)
    # 담당자 (있을 때) — 회의록 본문에서 LLM 이 추정.
    assignee_text: Mapped[str | None] = mapped_column(String(80), nullable=True)
    assignee_user_id: Mapped[str | None] = mapped_column(
        String(36), ForeignKey("users.id", ondelete="SET NULL"), nullable=True,
    )
    due_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    created_by_id: Mapped[str | None] = mapped_column(
        String(36), ForeignKey("users.id", ondelete="SET NULL"), nullable=True,
    )
    created_at: Mapped[datetime] = mapped_column(
        DateTime, server_default=func.now()
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime, server_default=func.now(), onupdate=func.now()
    )


# ── 코멘트 (#93) ─────────────────────────────────────────────
class Comment(Base):
    """메시지·청크·워크플로·회의록 등에 다는 인라인 코멘트.  target_type
    + target_id 로 다형성 — 새 타깃이 생겨도 컬럼 추가 불필요."""

    __tablename__ = "comments"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_uuid)
    # 'message' | 'chunk' | 'workflow' | 'transcript' 등.
    target_type: Mapped[str] = mapped_column(String(20), index=True)
    target_id: Mapped[str] = mapped_column(String(80), index=True)
    user_id: Mapped[str | None] = mapped_column(
        String(36), ForeignKey("users.id", ondelete="SET NULL"), nullable=True,
    )
    body: Mapped[str] = mapped_column(Text)
    # @멘션된 사용자 id 들 — 알림 fan-out 에 사용 (JSON 배열).
    mentions: Mapped[str | None] = mapped_column(Text, nullable=True)
    resolved: Mapped[bool] = mapped_column(Boolean, default=False, index=True)
    # 스레드 — 최초 코멘트는 NULL, 답글은 부모 id.
    parent_id: Mapped[str | None] = mapped_column(
        String(36),
        ForeignKey("comments.id", ondelete="CASCADE"),
        nullable=True,
        index=True,
    )
    created_at: Mapped[datetime] = mapped_column(
        DateTime, server_default=func.now(), index=True
    )


# ── 알림 (#94) ───────────────────────────────────────────────
class Notification(Base):
    """사용자별 알림 inbox.  워크플로 완료/실패, 코멘트 멘션, 승인 요청,
    회의록 처리 완료 등 다양한 이벤트가 모임."""

    __tablename__ = "notifications"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_uuid)
    user_id: Mapped[str] = mapped_column(
        String(36),
        ForeignKey("users.id", ondelete="CASCADE"),
        index=True,
    )
    # 종류: workflow_done / workflow_fail / mention / approval_request /
    # approval_approved / approval_rejected / transcript_done / action_assigned.
    kind: Mapped[str] = mapped_column(String(40), index=True)
    title: Mapped[str] = mapped_column(String(200))
    body: Mapped[str | None] = mapped_column(Text, nullable=True)
    # 클릭 시 어디로? — '/api' prefix 없는 SPA 경로.
    link: Mapped[str | None] = mapped_column(String(255), nullable=True)
    read_at: Mapped[datetime | None] = mapped_column(
        DateTime, nullable=True, index=True
    )
    created_at: Mapped[datetime] = mapped_column(
        DateTime, server_default=func.now(), index=True
    )


# ── 검색 품질 로그 (#110) ────────────────────────────────────
class SearchQualityLog(Base):
    """RAG 검색 한 건당 한 줄.  admin 이 '검색이 잘 안 된 질의' 를 찾아
    corpus 를 보강하거나 청크 전략을 조정할 때 사용.  retrieval 본 흐름
    과 독립이라 실패해도 silently 무시 (quality.log_retrieval_quality)."""

    __tablename__ = "search_quality_log"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_uuid)
    user_id: Mapped[str | None] = mapped_column(
        String(36),
        ForeignKey("users.id", ondelete="SET NULL"),
        nullable=True,
        index=True,
    )
    # 콤마로 join 된 project id 목록 — 다중 프로젝트 동시 검색 케이스.
    project_ids: Mapped[str | None] = mapped_column(String(500), nullable=True)
    query: Mapped[str] = mapped_column(String(500))
    # 가장 잘 맞은 청크의 벡터 점수 (0~1).  0 이면 결과 자체가 없었던 것.
    top_score: Mapped[float] = mapped_column(default=0.0)
    hit_count: Mapped[int] = mapped_column(default=0)
    elapsed_ms: Mapped[int] = mapped_column(default=0)
    created_at: Mapped[datetime] = mapped_column(
        DateTime, server_default=func.now(), index=True
    )


# ── 요청 트레이싱 (#116) ─────────────────────────────────────
class RequestLog(Base):
    """모든 API 요청 한 줄.  ErrorLog 는 실패만 잡고 이 테이블은 성공/
    실패 모두 잡아 throughput·latency 분석에 사용.

    보존 기간은 settings.request_log_retention_days (기본 7일) — 너무
    오래 쌓이면 디스크 + 인덱스 비용.  middleware 가 /health 등 noisy
    경로는 기록 스킵, status_code/path 는 인덱스해서 admin 통계 쿼리가
    빠르게 동작하도록.
    """

    __tablename__ = "request_log"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_uuid)
    user_id: Mapped[str | None] = mapped_column(
        String(36),
        ForeignKey("users.id", ondelete="SET NULL"),
        nullable=True,
        index=True,
    )
    method: Mapped[str] = mapped_column(String(10), index=True)
    # 라우트 패턴 우선 (e.g. /api/sessions/{id}).  치환된 실제 경로보다
    # 그룹 통계에 유리 — request.scope['route'].path 가 있으면 그것을,
    # 없으면 url.path 그대로 (정규화: 36자 UUID 는 {id} 로 치환).
    path: Mapped[str] = mapped_column(String(255), index=True)
    status_code: Mapped[int] = mapped_column(index=True)
    latency_ms: Mapped[int] = mapped_column(default=0)
    ip: Mapped[str | None] = mapped_column(String(64), nullable=True)
    user_agent: Mapped[str | None] = mapped_column(String(255), nullable=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime, server_default=func.now(), index=True
    )


# ── 웹훅 알림 큐 (#120) ──────────────────────────────────────
class WebhookDelivery(Base):
    """발송된(혹은 실패한) 외부 알림.  admin 이 'webhook 동작했나?' 점검
    할 수 있게 결과를 남긴다.  status='pending' 행은 백그라운드 잡이
    재시도, 'sent' / 'failed' 는 종착 상태."""

    __tablename__ = "webhook_deliveries"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_uuid)
    kind: Mapped[str] = mapped_column(String(40), index=True)
    title: Mapped[str] = mapped_column(String(200))
    body: Mapped[str | None] = mapped_column(Text, nullable=True)
    target_url: Mapped[str] = mapped_column(String(500))
    status: Mapped[str] = mapped_column(String(16), default="pending", index=True)
    response_code: Mapped[int | None] = mapped_column(nullable=True)
    error: Mapped[str | None] = mapped_column(String(500), nullable=True)
    attempts: Mapped[int] = mapped_column(default=0)
    created_at: Mapped[datetime] = mapped_column(
        DateTime, server_default=func.now(), index=True
    )
