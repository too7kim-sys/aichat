"""테스트 공용 인프라.

핵심 설계:
  · 테스트마다 임시 파일 SQLite 를 만들어 격리 — :memory: 는 이벤트
    루프가 끊기면 connection 도 끊겨 데이터가 사라짐.  파일 기반이면
    StaticPool 없이도 여러 connection 에서 같은 DB 를 본다.
  · TestClient 를 `with` 컨텍스트 *없이* 사용 — lifespan 의 백그라운드
    스케줄러 task 들이 무한 대기를 만들지 않게.
  · `database.SessionLocal` 자체를 테스트 엔진으로 갈아끼움 — get_db
    오버라이드만으로는 audit/error_log 같이 SessionLocal 을 직접 쓰는
    곳에 닿지 않아 'no such table' 이 발생.

운영기 DB 가 실수로라도 만져지지 않도록:
  · DATABASE_URL 을 무조건 임시 파일로 강제.
  · settings.rag_enabled = False, ENABLE_TRANSCRIPTION = False.
  · AICHAT_NO_BACKGROUND_TASKS=1 로 무한 루프 스케줄러 스킵.
"""
from __future__ import annotations

import asyncio
import os
import tempfile

# 운영기 .env 가 우연히 활성화돼도 영향 없도록 import 전에 환경변수 덮어쓰기.
os.environ["JWT_SECRET"] = "test-jwt-secret-do-not-use-in-prod-32-bytes-long"
os.environ["RAG_ENABLED"] = "false"
os.environ["ENABLE_TRANSCRIPTION"] = "false"
os.environ.setdefault("ALLOWED_CLIENT_IPS", "")  # IPAllowlist 끄기
os.environ.setdefault("CORS_ORIGINS", "*")
# 테스트의 admin 사용자 이메일 — 첫 가입자로 만들면 자동 admin role.
os.environ["ADMIN_EMAIL"] = "admin@example.com"
# 백그라운드 스케줄러·웹훅 probe 스킵 — pytest 가 hang 되지 않게.
os.environ["AICHAT_NO_BACKGROUND_TASKS"] = "1"
# 임시 DB 파일 — settings 초기화 전에 박아 둬야 app 이 그걸 본다.
_TMP_DB = tempfile.NamedTemporaryFile(suffix=".db", delete=False)
_TMP_DB.close()
os.environ["DATABASE_URL"] = f"sqlite+aiosqlite:///{_TMP_DB.name}"

import pytest
from fastapi.testclient import TestClient
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

from app import database as _db
from app import models as _models  # noqa: F401 — Base.metadata 채우기 위해
from app.database import Base


@pytest.fixture
def app(tmp_path):
    """FastAPI app — database.SessionLocal 자체를 테스트 엔진으로
    교체하고, get_db 도 오버라이드.  매 테스트가 깨끗한 DB 를 받음."""
    db_file = tmp_path / "test.db"
    test_url = f"sqlite+aiosqlite:///{db_file}"
    # timeout=30: 잠금 충돌 시 30초까지 기다림.  WAL 만으로는 writer 직렬
    # 화에서 milli- 단위 지연이 누적될 수 있음.
    engine = create_async_engine(
        test_url,
        connect_args={"check_same_thread": False, "timeout": 30},
    )

    # PRAGMA 를 매 새 connection 마다 셋팅.  sync engine 의 event 인터페이스
    # 를 통해 async pool 안의 raw sqlite3 connection 에 직접 적용.
    from sqlalchemy import event as _event
    @_event.listens_for(engine.sync_engine, "connect")
    def _set_pragma(dbapi_conn, _record):
        cur = dbapi_conn.cursor()
        cur.execute("PRAGMA journal_mode=WAL")
        cur.execute("PRAGMA synchronous=NORMAL")
        cur.execute("PRAGMA busy_timeout=30000")
        cur.close()

    factory = async_sessionmaker(engine, expire_on_commit=False)

    # 테이블 생성 + WAL 셋업 — 새 이벤트 루프에서 한 번 돌림.
    async def _setup():
        async with engine.begin() as conn:
            # WAL 로 concurrent reader/writer — RequestLogMiddleware 가
            # 백그라운드 task 로 RequestLog 를 쓰는 동안 foreground
            # 요청이 'database is locked' 으로 깨지지 않게.
            await conn.exec_driver_sql("PRAGMA journal_mode=WAL")
            await conn.exec_driver_sql("PRAGMA synchronous=NORMAL")
            await conn.exec_driver_sql("PRAGMA busy_timeout=10000")
            await conn.run_sync(Base.metadata.create_all)

    asyncio.new_event_loop().run_until_complete(_setup())

    # SessionLocal 을 테스트 엔진의 sessionmaker 로 교체.
    orig_session_local = _db.SessionLocal
    orig_engine = _db.engine
    _db.SessionLocal = factory  # type: ignore[assignment]
    _db.engine = engine  # type: ignore[assignment]

    from app.main import app as fastapi_app

    async def _override_get_db():
        async with factory() as session:
            yield session

    fastapi_app.dependency_overrides[_db.get_db] = _override_get_db

    # Rate-limit/잠금 버킷이 module-level dict 라 테스트 간에 누적.
    # 매 테스트마다 초기화 — IP 1개에서 5번째 signup 부터 429 가 떨어지는
    # 식의 테스트 간 의존성 제거.
    from app.routers import _rate_limit as _rl
    _rl._buckets.clear()
    _rl._login_fails.clear()
    _rl._locked_until.clear()

    yield fastapi_app

    fastapi_app.dependency_overrides.clear()
    _db.SessionLocal = orig_session_local  # type: ignore[assignment]
    _db.engine = orig_engine  # type: ignore[assignment]


@pytest.fixture
def client(app):
    """동기 TestClient — lifespan 우회.  async 라우터도 sync 처럼 호출."""
    return TestClient(app)
