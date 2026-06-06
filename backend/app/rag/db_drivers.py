"""Database driver registry + connection-test for the RAG project's
DB corpus type. The frontend's DB form lets the user pick from a
catalog of drivers, fill in driver-specific fields (host/port/user/
password/database for network DBs, file path for SQLite), then click
'접속 테스트' before submitting.

Drivers covered:
  - postgresql (psycopg2)
  - mysql      (pymysql)
  - mariadb    (pymysql, same dialect family)
  - sqlite     (stdlib)
  - mssql      (pyodbc + ODBC Driver 17/18 for SQL Server)
  - tibero     (pyodbc + Tibero ODBC driver)
  - cubrid     (cubrid-python or cubricdb)
  - altibase   (altibase python sdk)

Most native dialects ship with SQLAlchemy; the Korean DBs (Tibero,
CUBRID, Altibase) require an OS-level ODBC driver + a third-party
SQLAlchemy dialect. We surface a clear "drivers not installed" message
if the import fails instead of blowing up.

The reflector in `rag.indexer._reflect_db_to_dir` takes the URL this
module builds and dumps every table's CREATE TABLE DDL — the rest of
the indexing pipeline doesn't care which dialect produced it.
"""
from __future__ import annotations

import asyncio
import urllib.parse
from typing import Literal

from pydantic import BaseModel, Field


# ── Driver catalog ────────────────────────────────────────────────────


class DriverInfo(BaseModel):
    code: str
    label: str
    default_port: int | None
    # True = needs only a single file path (sqlite); False = needs
    # host/port/user/password/database.
    is_file_based: bool
    # True = ODBC-backed (frontend can hint about driver install).
    odbc_based: bool = False
    # Optional default database/service name placeholder shown in the
    # UI as the field's placeholder text.
    default_database: str = ""
    notes: str = ""


_REGISTRY: dict[str, DriverInfo] = {
    "postgresql": DriverInfo(
        code="postgresql",
        label="PostgreSQL",
        default_port=5432,
        is_file_based=False,
        notes="psycopg2 드라이버 필요 (이미 backend 의존성에 포함)",
    ),
    "mysql": DriverInfo(
        code="mysql",
        label="MySQL",
        default_port=3306,
        is_file_based=False,
        notes="pymysql 드라이버 (또는 mysqlclient)",
    ),
    "mariadb": DriverInfo(
        code="mariadb",
        label="MariaDB",
        default_port=3306,
        is_file_based=False,
        notes="MySQL 호환 — pymysql로 접속",
    ),
    "sqlite": DriverInfo(
        code="sqlite",
        label="SQLite",
        default_port=None,
        is_file_based=True,
        default_database="/path/to/db.sqlite",
        notes="백엔드 서버가 직접 읽을 수 있는 파일 경로",
    ),
    "mssql": DriverInfo(
        code="mssql",
        label="Microsoft SQL Server",
        default_port=1433,
        is_file_based=False,
        odbc_based=True,
        notes="OS에 'ODBC Driver 17/18 for SQL Server' + pyodbc 필요",
    ),
    "tibero": DriverInfo(
        code="tibero",
        label="Tibero",
        default_port=8629,
        is_file_based=False,
        odbc_based=True,
        notes="Tibero ODBC 드라이버 + pyodbc + sqlalchemy-tibero 필요",
    ),
    "cubrid": DriverInfo(
        code="cubrid",
        label="CUBRID",
        default_port=33000,
        is_file_based=False,
        notes="CUBRID Python 드라이버 + sqlalchemy-cubrid 필요",
    ),
    "altibase": DriverInfo(
        code="altibase",
        label="Altibase",
        default_port=20300,
        is_file_based=False,
        odbc_based=True,
        notes="Altibase ODBC 드라이버 + pyodbc 또는 altipy 필요",
    ),
}


def list_drivers() -> list[DriverInfo]:
    return list(_REGISTRY.values())


def get_driver(code: str) -> DriverInfo:
    info = _REGISTRY.get(code)
    if info is None:
        raise ValueError(f"unknown driver: {code}")
    return info


# ── URL builder ──────────────────────────────────────────────────────


def build_db_url(
    *,
    driver: str,
    host: str = "",
    port: int | None = None,
    user: str = "",
    password: str = "",
    database: str = "",
) -> str:
    """Compose a SQLAlchemy URL from per-field inputs. Each driver gets
    the dialect+driver scheme that ships with SQLAlchemy (or the
    community plugin recommended in `notes`)."""
    info = get_driver(driver)

    if info.is_file_based:
        # SQLite: only the file path matters. Empty path → memory DB.
        path = (database or "").strip()
        if not path:
            return "sqlite:///:memory:"
        # Three slashes for absolute paths on POSIX, four for
        # Windows-style absolute (`C:/...`). SQLAlchemy accepts both
        # when prefixed correctly.
        if path.startswith("/") or len(path) > 1 and path[1] == ":":
            return f"sqlite:///{path}"
        return f"sqlite:///./{path}"

    scheme_map = {
        "postgresql": "postgresql+psycopg2",
        "mysql": "mysql+pymysql",
        "mariadb": "mariadb+pymysql",
        "mssql": "mssql+pyodbc",
        "tibero": "tibero+pyodbc",
        "cubrid": "cubrid",
        "altibase": "altibase+pyodbc",
    }
    scheme = scheme_map[driver]

    use_port = port if port is not None else info.default_port
    encoded_user = urllib.parse.quote(user or "", safe="")
    encoded_pw = urllib.parse.quote(password or "", safe="")
    auth = ""
    if encoded_user:
        auth = f"{encoded_user}:{encoded_pw}@" if encoded_pw else f"{encoded_user}@"
    host_part = f"{host}:{use_port}" if use_port else host
    db_part = f"/{urllib.parse.quote(database, safe='')}" if database else ""

    url = f"{scheme}://{auth}{host_part}{db_part}"

    # mssql/tibero need the ODBC driver name as a query param so
    # pyodbc knows which OS driver to invoke.
    if driver == "mssql":
        url += "?driver=ODBC+Driver+17+for+SQL+Server"
    elif driver == "tibero":
        url += "?driver=Tibero"

    return url


# ── Connection test ──────────────────────────────────────────────────


class TestConnectionRequest(BaseModel):
    driver: Literal[
        "postgresql", "mysql", "mariadb", "sqlite",
        "mssql", "tibero", "cubrid", "altibase",
    ]
    host: str = Field(default="", max_length=255)
    port: int | None = None
    user: str = Field(default="", max_length=80)
    password: str = Field(default="", max_length=200)
    database: str = Field(default="", max_length=200)


class TestConnectionResult(BaseModel):
    ok: bool
    driver: str
    url_redacted: str
    error: str | None = None
    table_count: int | None = None


def _redact(url: str) -> str:
    """Mask the password section of the SQLAlchemy URL so the test
    response never echoes credentials back to the frontend log/UI."""
    import re
    return re.sub(
        r"^([a-z][a-z0-9+.-]*):\/\/([^:@/]+):[^@]+@",
        r"\1://\2:***@",
        url,
        flags=re.IGNORECASE,
    )


def _sync_test(url: str) -> TestConnectionResult:
    """Synchronous test — runs the import + connect + reflect in the
    caller's thread. Wrapped by `test_connection` below with a
    timeout so a hanging DB doesn't lock the API event loop."""
    redacted = _redact(url)
    try:
        from sqlalchemy import create_engine, text
    except ImportError as exc:  # pragma: no cover — sqlalchemy is in reqs
        return TestConnectionResult(
            ok=False, driver="", url_redacted=redacted,
            error=f"SQLAlchemy import 실패: {exc}",
        )
    try:
        engine = create_engine(
            url,
            connect_args=(
                {"connect_timeout": 10}
                if url.startswith(("postgresql", "mysql", "mariadb"))
                else {}
            ),
        )
    except Exception as exc:  # noqa: BLE001
        return TestConnectionResult(
            ok=False, driver="", url_redacted=redacted,
            error=f"엔진 생성 실패: {type(exc).__name__}: {exc}",
        )
    try:
        with engine.connect() as conn:
            # A trivial probe so we're sure the DB actually accepted
            # the connection rather than just buffering it.
            conn.execute(text("SELECT 1"))
            # Count tables via reflection. Errors here are non-fatal —
            # we still report ok=True since the connection itself
            # succeeded.
            tables = None
            try:
                from sqlalchemy import MetaData

                meta = MetaData()
                meta.reflect(bind=conn)
                tables = len(meta.tables)
            except Exception:  # noqa: BLE001
                tables = None
        return TestConnectionResult(
            ok=True, driver="", url_redacted=redacted, table_count=tables,
        )
    except Exception as exc:  # noqa: BLE001
        return TestConnectionResult(
            ok=False, driver="", url_redacted=redacted,
            error=f"접속 실패: {type(exc).__name__}: {exc}",
        )
    finally:
        try:
            engine.dispose()
        except Exception:  # noqa: BLE001
            pass


async def test_connection(payload: TestConnectionRequest) -> TestConnectionResult:
    """Build a SA URL from the per-field payload and try to open a
    real connection in a worker thread. Bounded by a 20s wall clock —
    a DB that doesn't answer in that window almost certainly won't
    finish reflection during indexing either."""
    try:
        url = build_db_url(
            driver=payload.driver,
            host=payload.host,
            port=payload.port,
            user=payload.user,
            password=payload.password,
            database=payload.database,
        )
    except ValueError as exc:
        return TestConnectionResult(
            ok=False, driver=payload.driver, url_redacted="",
            error=str(exc),
        )
    try:
        result = await asyncio.wait_for(
            asyncio.to_thread(_sync_test, url),
            timeout=20,
        )
    except asyncio.TimeoutError:
        return TestConnectionResult(
            ok=False, driver=payload.driver,
            url_redacted=_redact(url),
            error="접속 테스트 시간 초과 (20초). 네트워크/방화벽/포트 확인.",
        )
    # Stamp the driver code on the result so the UI can show it without
    # passing the driver back through every response field.
    result_driver = result.model_copy(update={"driver": payload.driver})
    return result_driver
