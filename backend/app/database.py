from collections.abc import AsyncIterator

from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine
from sqlalchemy.orm import DeclarativeBase

from .config import settings


class Base(DeclarativeBase):
    pass


engine = create_async_engine(settings.database_url, echo=False, future=True)
SessionLocal = async_sessionmaker(engine, expire_on_commit=False, class_=AsyncSession)


async def init_db() -> None:
    from sqlalchemy import text

    from . import models  # noqa: F401 - register tables
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
        # SQLite: switch to WAL so a long-running write (e.g. persisting
        # an in-flight assistant message after the user navigated to a
        # new chat) doesn't block fresh reads on other tabs/requests.
        if settings.database_url.startswith("sqlite"):
            await conn.exec_driver_sql("PRAGMA journal_mode=WAL")
            await conn.exec_driver_sql("PRAGMA synchronous=NORMAL")
            await conn.exec_driver_sql("PRAGMA busy_timeout=5000")
        # Lightweight, idempotent migration for pre-auth SQLite DBs that
        # already have a `sessions` table without a `user_id` column.
        # (Full migrations would need Alembic; this covers the only schema
        # change we've shipped that breaks existing dev DBs.)
        if settings.database_url.startswith("sqlite"):
            cols = await conn.exec_driver_sql("PRAGMA table_info(sessions)")
            existing = {row[1] for row in cols.fetchall()}
            if "user_id" not in existing:
                await conn.exec_driver_sql(
                    "ALTER TABLE sessions ADD COLUMN user_id VARCHAR(36)"
                )
                await conn.exec_driver_sql(
                    "CREATE INDEX IF NOT EXISTS ix_sessions_user_id "
                    "ON sessions(user_id)"
                )
            if "project_id" not in existing:
                # RAG link added in the Phase-1 RAG commit. Nullable, so
                # existing rows survive — the chat router just sees None
                # and skips retrieval.
                await conn.exec_driver_sql(
                    "ALTER TABLE sessions ADD COLUMN project_id VARCHAR(36)"
                )
                await conn.exec_driver_sql(
                    "CREATE INDEX IF NOT EXISTS ix_sessions_project_id "
                    "ON sessions(project_id)"
                )
            if "workspace_id" not in existing:
                # Code workspace pin + code-focused flag for the
                # "click workspace → project chat" flow.
                await conn.exec_driver_sql(
                    "ALTER TABLE sessions ADD COLUMN workspace_id VARCHAR(36)"
                )
                await conn.exec_driver_sql(
                    "CREATE INDEX IF NOT EXISTS ix_sessions_workspace_id "
                    "ON sessions(workspace_id)"
                )
            if "code_focused" not in existing:
                await conn.exec_driver_sql(
                    "ALTER TABLE sessions ADD COLUMN code_focused "
                    "BOOLEAN NOT NULL DEFAULT 0"
                )
            if "chat_project_id" not in existing:
                # New "Chat projects" feature — organisational buckets
                # for sessions, distinct from the RAG `projects` table.
                # Nullable so existing sessions sit in the default
                # "기타 대화" group until the user files them.
                await conn.exec_driver_sql(
                    "ALTER TABLE sessions ADD COLUMN chat_project_id "
                    "VARCHAR(36)"
                )
                await conn.exec_driver_sql(
                    "CREATE INDEX IF NOT EXISTS ix_sessions_chat_project_id "
                    "ON sessions(chat_project_id)"
                )
            if "workflow_id" not in existing:
                # Auto-runs from Cowork 워크플로 tag the resulting
                # Session here. The runner uses this to keep only the
                # N most recent sessions per workflow (older are auto-
                # deleted). NULL on every normal user chat.
                await conn.exec_driver_sql(
                    "ALTER TABLE sessions ADD COLUMN workflow_id VARCHAR(36)"
                )
                await conn.exec_driver_sql(
                    "CREATE INDEX IF NOT EXISTS ix_sessions_workflow_id "
                    "ON sessions(workflow_id)"
                )
            # Message-hidden flag for the transcription pipeline — the
            # raw whisper output stores hidden=1 so the chat panel
            # collapses it by default while keeping the row available
            # for the 회의록 export modal + RAG indexer.
            mcols = await conn.exec_driver_sql("PRAGMA table_info(messages)")
            mexisting = {row[1] for row in mcols.fetchall()}
            if mexisting and "hidden" not in mexisting:
                await conn.exec_driver_sql(
                    "ALTER TABLE messages ADD COLUMN hidden "
                    "BOOLEAN NOT NULL DEFAULT 0"
                )
            if mexisting and "starred" not in mexisting:
                # 별표(즐겨찾기). 사용자가 채팅 안에서 1-click 으로
                # 토글 — 별표한 메시지를 모아 보는 보조 화면용.
                await conn.exec_driver_sql(
                    "ALTER TABLE messages ADD COLUMN starred "
                    "BOOLEAN NOT NULL DEFAULT 0"
                )
                await conn.exec_driver_sql(
                    "CREATE INDEX IF NOT EXISTS ix_messages_starred "
                    "ON messages(starred) WHERE starred = 1"
                )
            if mexisting and "feedback" not in mexisting:
                # 답변 평가 (1 / 0 / -1) + 자유 메모. 운영 피드백 모음
                # → 향후 프롬프트 / RAG 튜닝 근거.
                await conn.exec_driver_sql(
                    "ALTER TABLE messages ADD COLUMN feedback "
                    "INTEGER NOT NULL DEFAULT 0"
                )
                await conn.exec_driver_sql(
                    "ALTER TABLE messages ADD COLUMN feedback_note "
                    "VARCHAR(500)"
                )
                await conn.exec_driver_sql(
                    "CREATE INDEX IF NOT EXISTS ix_messages_feedback "
                    "ON messages(feedback) WHERE feedback != 0"
                )
            # Users: 토큰 무효화 컷오프 (강제 로그아웃·비번 변경).
            ucols = await conn.exec_driver_sql("PRAGMA table_info(users)")
            uexisting = {row[1] for row in ucols.fetchall()}
            if uexisting and "tokens_invalidated_at" not in uexisting:
                await conn.exec_driver_sql(
                    "ALTER TABLE users ADD COLUMN tokens_invalidated_at "
                    "DATETIME"
                )
            # Projects table may exist without corpus_type from the
            # original RAG ship — default existing rows to "code".
            pcols = await conn.exec_driver_sql("PRAGMA table_info(projects)")
            pexisting = {row[1] for row in pcols.fetchall()}
            if pexisting and "corpus_type" not in pexisting:
                await conn.exec_driver_sql(
                    "ALTER TABLE projects ADD COLUMN corpus_type "
                    "VARCHAR(20) NOT NULL DEFAULT 'code'"
                )
                await conn.exec_driver_sql(
                    "CREATE INDEX IF NOT EXISTS ix_projects_corpus_type "
                    "ON projects(corpus_type)"
                )
            if pexisting and "corpus_type" in pexisting:
                # The legal corpus type was retired; remap any existing
                # rows to "document" so the modal can still render them
                # (the chunker just runs the document path on the same
                # files until the user re-indexes).
                await conn.exec_driver_sql(
                    "UPDATE projects SET corpus_type = 'document' "
                    "WHERE corpus_type = 'legal'"
                )
            if pexisting and "is_shared" not in pexisting:
                # Shared knowledge-base flag — see models.Project.
                await conn.exec_driver_sql(
                    "ALTER TABLE projects ADD COLUMN is_shared "
                    "BOOLEAN NOT NULL DEFAULT 0"
                )
                await conn.exec_driver_sql(
                    "CREATE INDEX IF NOT EXISTS ix_projects_is_shared "
                    "ON projects(is_shared)"
                )
            if pexisting and "snapshot_retention_count" not in pexisting:
                # Per-project retention policy — see Project model. The
                # default (10) covers most "snapshot every hour, glance
                # at the last day" usage; users on a busy schedule pump
                # this up to 30/100 from the UI.
                await conn.exec_driver_sql(
                    "ALTER TABLE projects ADD COLUMN "
                    "snapshot_retention_count INTEGER NOT NULL DEFAULT 10"
                )
            # Belt-and-suspenders — older SQLite builds occasionally
            # leave existing rows at NULL even when the column was
            # added with `NOT NULL DEFAULT 10`. Backfill so the
            # response schema doesn't have to special-case None.
            if pexisting and "snapshot_retention_count" in pexisting:
                await conn.exec_driver_sql(
                    "UPDATE projects SET snapshot_retention_count = 10 "
                    "WHERE snapshot_retention_count IS NULL"
                )
            # Prompt library tables — created by create_all on first
            # boot, belt-and-suspenders here for older DBs.
            await conn.exec_driver_sql(
                """
                CREATE TABLE IF NOT EXISTS prompts (
                    id VARCHAR(36) PRIMARY KEY,
                    user_id VARCHAR(36) NOT NULL,
                    code VARCHAR(60) NOT NULL UNIQUE,
                    name VARCHAR(120) NOT NULL,
                    description TEXT,
                    body TEXT NOT NULL,
                    category VARCHAR(40),
                    tags VARCHAR(200),
                    is_shared BOOLEAN NOT NULL DEFAULT 0,
                    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
                )
                """
            )
            await conn.exec_driver_sql(
                "CREATE INDEX IF NOT EXISTS ix_prompts_user_id ON prompts(user_id)"
            )
            await conn.exec_driver_sql(
                "CREATE INDEX IF NOT EXISTS ix_prompts_is_shared ON prompts(is_shared)"
            )
            await conn.exec_driver_sql(
                """
                CREATE TABLE IF NOT EXISTS prompt_role_access (
                    prompt_id VARCHAR(36) NOT NULL,
                    role_code VARCHAR(40) NOT NULL,
                    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                    PRIMARY KEY (prompt_id, role_code)
                )
                """
            )
            await conn.exec_driver_sql(
                "CREATE INDEX IF NOT EXISTS ix_prompt_role_access_role "
                "ON prompt_role_access(role_code)"
            )
            # Transcripts table — audio file transcription/diarization jobs.
            await conn.exec_driver_sql(
                """
                CREATE TABLE IF NOT EXISTS transcripts (
                    id VARCHAR(36) PRIMARY KEY,
                    user_id VARCHAR(36) NOT NULL,
                    source_filename VARCHAR(255) NOT NULL,
                    size_bytes INTEGER NOT NULL DEFAULT 0,
                    duration_sec REAL,
                    status VARCHAR(20) NOT NULL DEFAULT 'pending',
                    progress REAL,
                    language VARCHAR(8),
                    diarized BOOLEAN NOT NULL DEFAULT 0,
                    session_id VARCHAR(36),
                    error TEXT,
                    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
                )
                """
            )
            await conn.exec_driver_sql(
                "CREATE INDEX IF NOT EXISTS ix_transcripts_user_id "
                "ON transcripts(user_id)"
            )
            await conn.exec_driver_sql(
                "CREATE INDEX IF NOT EXISTS ix_transcripts_status "
                "ON transcripts(status)"
            )
            # Workflows table — automation runs against prompt + optional
            # RAG project on a schedule, producing chat sessions.
            await conn.exec_driver_sql(
                """
                CREATE TABLE IF NOT EXISTS workflows (
                    id VARCHAR(36) PRIMARY KEY,
                    user_id VARCHAR(36) NOT NULL,
                    name VARCHAR(120) NOT NULL,
                    description TEXT,
                    prompt_id VARCHAR(36) NOT NULL,
                    prompt_vars TEXT,
                    project_id VARCHAR(36),
                    model VARCHAR(120),
                    schedule_interval_minutes INTEGER NOT NULL DEFAULT 0,
                    enabled BOOLEAN NOT NULL DEFAULT 1,
                    last_run_at DATETIME,
                    last_run_status VARCHAR(20),
                    last_session_id VARCHAR(36),
                    last_error TEXT,
                    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
                )
                """
            )
            await conn.exec_driver_sql(
                "CREATE INDEX IF NOT EXISTS ix_workflows_user_id "
                "ON workflows(user_id)"
            )
            # 공휴일 스킵 토글 (워크플로별)
            wcols = await conn.exec_driver_sql("PRAGMA table_info(workflows)")
            wexisting = {row[1] for row in wcols.fetchall()}
            if wexisting and "skip_holidays" not in wexisting:
                await conn.exec_driver_sql(
                    "ALTER TABLE workflows ADD COLUMN skip_holidays "
                    "BOOLEAN NOT NULL DEFAULT 0"
                )
            # role→project access table — created by create_all when
            # the model registers, but belt-and-suspenders for older
            # DBs so the chat auto-search join doesn't crash.
            await conn.exec_driver_sql(
                """
                CREATE TABLE IF NOT EXISTS project_role_access (
                    project_id  VARCHAR(36) NOT NULL,
                    role_code   VARCHAR(40) NOT NULL,
                    created_at  DATETIME DEFAULT CURRENT_TIMESTAMP,
                    PRIMARY KEY (project_id, role_code)
                )
                """
            )
            await conn.exec_driver_sql(
                "CREATE INDEX IF NOT EXISTS ix_project_role_access_role "
                "ON project_role_access(role_code)"
            )
            # Many-to-many user-roles join — additional roles beyond
            # the primary one in users.role. See models.UserRole.
            await conn.exec_driver_sql(
                """
                CREATE TABLE IF NOT EXISTS user_roles (
                    user_id    VARCHAR(36) NOT NULL,
                    role_code  VARCHAR(40) NOT NULL,
                    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                    PRIMARY KEY (user_id, role_code)
                )
                """
            )
            await conn.exec_driver_sql(
                "CREATE INDEX IF NOT EXISTS ix_user_roles_user_id "
                "ON user_roles(user_id)"
            )
            await conn.exec_driver_sql(
                "CREATE INDEX IF NOT EXISTS ix_user_roles_role_code "
                "ON user_roles(role_code)"
            )
            if pexisting and "sql_query" not in pexisting:
                # Per-project SELECT for the connection source — see
                # models.Project.sql_query for the indexer flow.
                await conn.exec_driver_sql(
                    "ALTER TABLE projects ADD COLUMN sql_query TEXT"
                )
            if pexisting and "api_detail_key" not in pexisting:
                # API list→detail collection columns — see
                # models.Project.api_detail_key / api_detail_url.
                await conn.exec_driver_sql(
                    "ALTER TABLE projects ADD COLUMN api_detail_key "
                    "VARCHAR(120)"
                )
                await conn.exec_driver_sql(
                    "ALTER TABLE projects ADD COLUMN api_detail_url "
                    "VARCHAR(500)"
                )
            if pexisting and "schedule_interval_minutes" not in pexisting:
                await conn.exec_driver_sql(
                    "ALTER TABLE projects ADD COLUMN "
                    "schedule_interval_minutes INTEGER NOT NULL DEFAULT 0"
                )
                await conn.exec_driver_sql(
                    "ALTER TABLE projects ADD COLUMN "
                    "last_indexed_at DATETIME"
                )
            # indexed_files lookup table — created by create_all when
            # the model registers, but if an older DB is missing it
            # we belt-and-suspenders create it here so the scheduler
            # doesn't crash on the first incremental run.
            await conn.exec_driver_sql(
                """
                CREATE TABLE IF NOT EXISTS indexed_files (
                    id          VARCHAR(36) PRIMARY KEY,
                    snapshot_id VARCHAR(36) NOT NULL,
                    filename    VARCHAR(500) NOT NULL,
                    file_hash   VARCHAR(64) NOT NULL,
                    size        INTEGER DEFAULT 0,
                    chunk_count INTEGER DEFAULT 0,
                    indexed_at  DATETIME DEFAULT CURRENT_TIMESTAMP
                )
                """
            )
            await conn.exec_driver_sql(
                "CREATE INDEX IF NOT EXISTS ix_indexed_files_snapshot_id "
                "ON indexed_files(snapshot_id)"
            )
            await conn.exec_driver_sql(
                "CREATE INDEX IF NOT EXISTS ix_indexed_files_filename "
                "ON indexed_files(filename)"
            )
            # code_workspaces — created by create_all when the model
            # registers, but if an upgraded backend hits an older DB
            # this ensures the table exists for any later route.
            await conn.exec_driver_sql(
                """
                CREATE TABLE IF NOT EXISTS code_workspaces (
                    id                    VARCHAR(36) PRIMARY KEY,
                    user_id               VARCHAR(36) NOT NULL,
                    name                  VARCHAR(120) NOT NULL,
                    git_url               VARCHAR(500) NOT NULL,
                    branch                VARCHAR(120) DEFAULT '',
                    local_path            VARCHAR(500) DEFAULT '',
                    auth_username         VARCHAR(120),
                    auth_token_encrypted  TEXT,
                    status                VARCHAR(20) DEFAULT 'cloning',
                    error                 TEXT,
                    file_count            INTEGER DEFAULT 0,
                    size_bytes            INTEGER DEFAULT 0,
                    last_synced_at        DATETIME,
                    created_at            DATETIME DEFAULT CURRENT_TIMESTAMP
                )
                """
            )
            await conn.exec_driver_sql(
                "CREATE INDEX IF NOT EXISTS ix_code_workspaces_user_id "
                "ON code_workspaces(user_id)"
            )
            # Phase-2 "local folder" source: a registered directory the
            # backend can already see, instead of a clone destination.
            # Older DBs predate the column — add it idempotently and
            # backfill the only existing source type ("git").
            wcols = await conn.exec_driver_sql(
                "PRAGMA table_info(code_workspaces)"
            )
            wexisting = {row[1] for row in wcols.fetchall()}
            if wexisting and "source_type" not in wexisting:
                await conn.exec_driver_sql(
                    "ALTER TABLE code_workspaces ADD COLUMN source_type "
                    "VARCHAR(16) NOT NULL DEFAULT 'git'"
                )
                await conn.exec_driver_sql(
                    "CREATE INDEX IF NOT EXISTS ix_code_workspaces_source_type "
                    "ON code_workspaces(source_type)"
                )
            if pexisting and "current_snapshot_id" not in pexisting:
                # Snapshot/versioning support added later. The FK column
                # is nullable so existing rows survive; a small backfill
                # below creates a Snapshot row per existing ready
                # project so retrieval keeps working without re-index.
                await conn.exec_driver_sql(
                    "ALTER TABLE projects ADD COLUMN current_snapshot_id "
                    "VARCHAR(36)"
                )
                await conn.exec_driver_sql(
                    "CREATE INDEX IF NOT EXISTS ix_projects_current_snapshot_id "
                    "ON projects(current_snapshot_id)"
                )
                # Make sure the snapshots table exists before backfilling.
                await conn.exec_driver_sql(
                    """
                    CREATE TABLE IF NOT EXISTS project_snapshots (
                        id            VARCHAR(36) PRIMARY KEY,
                        project_id    VARCHAR(36) NOT NULL,
                        label         VARCHAR(120) DEFAULT '',
                        status        VARCHAR(20) DEFAULT 'pending',
                        progress_done INTEGER DEFAULT 0,
                        progress_total INTEGER DEFAULT 0,
                        file_count    INTEGER DEFAULT 0,
                        chunk_count   INTEGER DEFAULT 0,
                        error         TEXT,
                        created_at    DATETIME DEFAULT CURRENT_TIMESTAMP
                    )
                    """
                )
                # Backfill: every existing ready project gets one
                # synthetic snapshot so future retrieval routes through
                # the snapshot id instead of the project id.
                await conn.exec_driver_sql(
                    """
                    INSERT INTO project_snapshots
                        (id, project_id, label, status, progress_done,
                         progress_total, file_count, chunk_count, error,
                         created_at)
                    SELECT
                        lower(hex(randomblob(4))) || '-' ||
                        lower(hex(randomblob(2))) || '-4' ||
                        substr(lower(hex(randomblob(2))), 2) || '-' ||
                        substr('89ab', abs(random()) % 4 + 1, 1) ||
                        substr(lower(hex(randomblob(2))), 2) || '-' ||
                        lower(hex(randomblob(6))),
                        id, '초기 인덱스', status, progress_done,
                        progress_total, file_count, chunk_count, error,
                        created_at
                    FROM projects
                    WHERE id NOT IN (
                        SELECT project_id FROM project_snapshots
                    )
                    """
                )
                # Point each project at its newly-created snapshot.
                await conn.exec_driver_sql(
                    """
                    UPDATE projects
                       SET current_snapshot_id = (
                           SELECT id FROM project_snapshots s
                           WHERE s.project_id = projects.id
                           ORDER BY s.created_at DESC LIMIT 1
                       )
                     WHERE current_snapshot_id IS NULL
                    """
                )
            ucols = await conn.exec_driver_sql("PRAGMA table_info(users)")
            uexisting = {row[1] for row in ucols.fetchall()}
            if uexisting and "email_verified" not in uexisting:
                # Default existing accounts to verified so they don't get
                # locked out by the new column — only fresh signups go
                # through verification.
                await conn.exec_driver_sql(
                    "ALTER TABLE users ADD COLUMN email_verified BOOLEAN "
                    "NOT NULL DEFAULT 1"
                )
            # Approval gating columns — added in the signup-approval
            # rollout. Default 'approved' for any existing row so the
            # transition doesn't lock out current users. Brand-new
            # signups land as 'pending' (default in the ORM model).
            if uexisting and "status" not in uexisting:
                await conn.exec_driver_sql(
                    "ALTER TABLE users ADD COLUMN status VARCHAR(20) "
                    "NOT NULL DEFAULT 'approved'"
                )
                await conn.exec_driver_sql(
                    "CREATE INDEX IF NOT EXISTS ix_users_status "
                    "ON users(status)"
                )
            if uexisting and "role" not in uexisting:
                await conn.exec_driver_sql(
                    "ALTER TABLE users ADD COLUMN role VARCHAR(20) "
                    "NOT NULL DEFAULT 'user'"
                )
            if uexisting and "approved_at" not in uexisting:
                await conn.exec_driver_sql(
                    "ALTER TABLE users ADD COLUMN approved_at DATETIME"
                )
                # Backfill the approval timestamp for grandfathered
                # users so the admin dashboard can show 'when' instead
                # of NULL.
                await conn.exec_driver_sql(
                    "UPDATE users SET approved_at = created_at "
                    "WHERE approved_at IS NULL AND status = 'approved'"
                )
            if uexisting and "approved_by_id" not in uexisting:
                await conn.exec_driver_sql(
                    "ALTER TABLE users ADD COLUMN approved_by_id VARCHAR(36)"
                )
            if uexisting and "rejection_reason" not in uexisting:
                await conn.exec_driver_sql(
                    "ALTER TABLE users ADD COLUMN rejection_reason TEXT"
                )
            if uexisting and "signup_reason" not in uexisting:
                await conn.exec_driver_sql(
                    "ALTER TABLE users ADD COLUMN signup_reason TEXT"
                )
            # Suspension columns — temporary block on an already-approved
            # account, distinct from rejection. Nullable so existing rows
            # keep working without backfill.
            if uexisting and "suspended_at" not in uexisting:
                await conn.exec_driver_sql(
                    "ALTER TABLE users ADD COLUMN suspended_at DATETIME"
                )
            if uexisting and "suspended_by_id" not in uexisting:
                await conn.exec_driver_sql(
                    "ALTER TABLE users ADD COLUMN suspended_by_id VARCHAR(36)"
                )
            if uexisting and "suspension_reason" not in uexisting:
                await conn.exec_driver_sql(
                    "ALTER TABLE users ADD COLUMN suspension_reason TEXT"
                )
            # Seed the three built-in roles so the new "역할 관리" UI
            # has the defaults to render even on a fresh install. The
            # rows are flagged is_system=1 — admins can rename them in
            # the dashboard but can't delete them or change their
            # base_role, which would break permission semantics.
            await conn.exec_driver_sql(
                """
                INSERT OR IGNORE INTO roles
                    (code, name, description, base_role, is_system)
                VALUES
                    ('admin', '관리자',
                     '시스템 전체 권한 — 역할 변경, 사용자 정지, 정책 토글',
                     'admin', 1),
                    ('moderator', '운영자',
                     '가입 신청 승인/거부, 일반 사용자 정지',
                     'moderator', 1),
                    ('user', '일반',
                     '기본 사용자 — 채팅 사용',
                     'user', 1)
                """
            )
            # Per-message attachment summary — JSON list of
            # {filename, kind, size} that the chat bubble renders as
            # compact chips above the user message. Nullable so
            # historical messages without attachments stay untouched.
            mcols = await conn.exec_driver_sql("PRAGMA table_info(messages)")
            mexisting = {row[1] for row in mcols.fetchall()}
            if mexisting and "attachments_summary" not in mexisting:
                await conn.exec_driver_sql(
                    "ALTER TABLE messages ADD COLUMN attachments_summary TEXT"
                )
            # ADMIN_EMAIL bootstrap — if the env names an account, make
            # sure it's promoted to admin + approved on every startup
            # so it can recover from accidental role demotion. No-op
            # when the account doesn't exist yet (will get promoted on
            # its first signup via the auth router hook).
            from .config import settings as _settings
            if _settings.admin_email:
                await conn.exec_driver_sql(
                    "UPDATE users "
                    "SET role = 'admin', "
                    "    status = 'approved', "
                    "    approved_at = COALESCE(approved_at, created_at) "
                    "WHERE LOWER(email) = LOWER(?)",
                    (_settings.admin_email,),
                )
        # Quiet the unused-import + text linters in environments where
        # neither branch above runs.
        _ = text


async def get_db() -> AsyncIterator[AsyncSession]:
    async with SessionLocal() as session:
        yield session
