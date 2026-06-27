import ipaddress
import logging
from contextlib import asynccontextmanager

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import HTMLResponse, JSONResponse
from starlette.middleware.base import BaseHTTPMiddleware

from .config import settings
from .database import init_db
from .providers.registry import all_providers
from .routers import (
    admin, api_keys, auth, chat, chat_projects, code, cowork, files, macros,
    ollama, personas, prompts, search, sessions, snippets, transcripts, workflows,
)

# RAG router pulls in qdrant-client. Import lazily so a missing
# `pip install -r requirements.txt` doesn't keep the rest of the app
# from starting — the RAG endpoints just become unavailable instead.
try:
    from .routers import projects as _projects_router
    _RAG_AVAILABLE = True
except ImportError as _rag_import_err:  # noqa: F841
    _projects_router = None
    _RAG_AVAILABLE = False
from .schemas import ProviderInfo

log = logging.getLogger("uvicorn.error")


def _resolve_jwt_secret() -> None:
    """JWT_SECRET 이 레포에 공개된 기본 placeholder 면, LAN 내 누구나
    admin 토큰을 위조할 수 있다.  폐쇄망 운영에서 수동 .env 편집을
    강제하면 잊고 그냥 띄우기 쉬우므로:

      · 기본값이면 강한 랜덤 시크릿을 자동 생성하고
      · backend/.jwt_secret 파일(0600)에 영속화해 재부팅해도 동일 →
        기존 로그인 토큰이 유지되고
      · settings.jwt_secret 을 런타임으로 교체 (auth 가 호출 시점에
        읽으므로 첫 요청 전에 바꾸면 충분).

    .env 에 진짜 JWT_SECRET 을 박아 두면 이 로직은 전혀 동작 안 함.
    """
    import os
    import secrets
    import stat
    from pathlib import Path

    if settings.jwt_secret != "dev-only-change-me":
        return  # 운영자가 명시적으로 설정함 — 그대로 사용.

    secret_path = Path(__file__).resolve().parent.parent / ".jwt_secret"
    try:
        if secret_path.is_file():
            value = secret_path.read_text(encoding="utf-8").strip()
            if value:
                settings.jwt_secret = value
                log.warning(
                    "JWT_SECRET 미설정 — backend/.jwt_secret 의 영속 "
                    "시크릿을 사용합니다.  운영 표준은 .env 의 JWT_SECRET "
                    "직접 설정입니다."
                )
                return
        value = secrets.token_urlsafe(48)
        secret_path.write_text(value, encoding="utf-8")
        try:
            secret_path.chmod(stat.S_IRUSR | stat.S_IWUSR)  # 0600
        except OSError:
            pass
        settings.jwt_secret = value
        log.warning(
            "JWT_SECRET 미설정 — 강한 랜덤 시크릿을 생성해 "
            "backend/.jwt_secret 에 저장했습니다 (0600).  공개된 기본값 "
            "위조 위험은 사라졌지만, 운영 표준은 .env 의 JWT_SECRET 직접 "
            "설정입니다."
        )
    except OSError as exc:
        # 파일 영속화 실패 (읽기전용 FS 등) — 프로세스 수명 동안만
        # 유효한 랜덤값이라도 공개 기본값보다 안전.  재부팅 시 토큰
        # 무효화되는 트레이드오프를 경고.
        settings.jwt_secret = secrets.token_urlsafe(48)
        log.warning(
            "JWT_SECRET 미설정 + .jwt_secret 영속화 실패(%s) — 이번 "
            "프로세스 한정 랜덤 시크릿 사용.  재시작하면 기존 토큰이 "
            "무효화됩니다.  .env 에 JWT_SECRET 을 설정하세요.",
            exc,
        )


@asynccontextmanager
async def lifespan(app: FastAPI):
    _resolve_jwt_secret()
    await init_db()
    # 백엔드 오류 캡처 — 미들웨어 + 로깅 핸들러 둘 다 활성.
    # init_db 가 ErrorLog 테이블을 만든 *뒤* 에 부착해야 첫 write 에서
    # 'no such table' 이 나지 않음.
    from .error_log import install_db_log_handler, prune_old
    install_db_log_handler()
    # 오래된 행 청소 (기본 30일 — settings.error_log_retention_days).
    try:
        await prune_old(getattr(settings, "error_log_retention_days", 30))
    except Exception as exc:  # noqa: BLE001
        log.warning("ErrorLog prune failed: %s", exc)
    # 요청 트레이싱 보존 정리 (#116).
    try:
        from .request_log import cleanup_request_log
        purged = await cleanup_request_log()
        if purged:
            log.info("RequestLog prune: %d rows", purged)
    except Exception as exc:  # noqa: BLE001
        log.warning("RequestLog prune failed: %s", exc)
    # 휴지통 30일 지난 세션 영구 삭제 (#31).
    try:
        from .routers.sessions import purge_expired_trash
        n = await purge_expired_trash(30)
        if n:
            log.info("session trash purge: %d 영구 삭제", n)
    except Exception as exc:  # noqa: BLE001
        log.warning("session trash purge failed: %s", exc)
    # 자동 백업 스케줄러 시작 (#44).
    try:
        from .routers.admin import start_backup_scheduler
        start_backup_scheduler()
    except Exception as exc:  # noqa: BLE001
        log.warning("backup scheduler start failed: %s", exc)
    # Seed runtime settings from env-var defaults (one-time on a
    # fresh install). After this the DB is the source of truth.
    from . import app_settings
    from .database import SessionLocal
    async with SessionLocal() as _s:
        await app_settings.seed_defaults(_s)

    # Start the RAG scheduler if qdrant-client is installed. Guarded
    # behind the same import block as the projects router so the app
    # stays up when the optional dep is missing.
    # 테스트에서는 무한 루프 스케줄러를 띄우지 않도록 가드 — pytest 가
    # AICHAT_NO_BACKGROUND_TASKS 를 env 에 박아 두면 모두 스킵.
    import asyncio
    import os as _os
    scheduler_task = None
    wf_scheduler_task = None
    webhook_task = None
    _skip_bg = _os.environ.get("AICHAT_NO_BACKGROUND_TASKS") == "1"
    if not _skip_bg and _RAG_AVAILABLE:
        try:
            from .rag.indexer import scheduler_loop
            scheduler_task = asyncio.create_task(scheduler_loop())
        except Exception as exc:  # noqa: BLE001
            log.warning("RAG scheduler not started: %s", exc)
    if not _skip_bg:
        try:
            from .workflows.scheduler import scheduler_loop as wf_loop
            wf_scheduler_task = asyncio.create_task(wf_loop())
        except Exception as exc:  # noqa: BLE001
            log.warning("workflow scheduler not started: %s", exc)
    # 외부 알림 probe (#120) — webhook_alert_url 비어 있으면 즉시 no-op.
    if not _skip_bg and (settings.webhook_alert_url or "").strip():
        try:
            from .webhook import probe_loop as _probe
            webhook_task = asyncio.create_task(_probe())
        except Exception as exc:  # noqa: BLE001
            log.warning("webhook probe not started: %s", exc)

    try:
        yield
    finally:
        for t in (scheduler_task, wf_scheduler_task, webhook_task):
            if t is None:
                continue
            t.cancel()
            try:
                await t
            except (asyncio.CancelledError, Exception):
                pass


class IPAllowlistMiddleware(BaseHTTPMiddleware):
    """`.env` 의 ALLOWED_CLIENT_IPS 가 채워져 있으면 그 안에 들지 않은
    클라이언트의 모든 요청을 403 으로 즉시 거절한다. loopback (같은
    박스에서 도는 헬스체크) 은 항상 허용.

    request.client.host 만 신뢰한다 — uvicorn 의 --proxy-headers 가
    켜져 있어 nginx 같은 신뢰된 프록시 뒤에서는 X-Forwarded-For 의
    실제 클라이언트 IP 가 자동으로 채워진다. 프록시가 없는 운영(=
    이 박스 직접 노출)에서는 그대로 TCP 피어의 IP 가 들어온다.

    응답 형식:
      - 브라우저 (Accept: text/html) → 로고 + 영문 안내 HTML.
        JSON 한 줄을 그대로 보여주면 일반 사용자에게 의미가 없어서
        브랜드 마크와 한 문장 안내로 시각적으로 정리.
      - API 클라이언트 (Accept 헤더 없거나 application/json)
        → 기존 JSON {detail: ...} 그대로 — 자동화/모니터링이 파싱
        하기 좋게.
    """

    # BrandLogo.tsx 의 픽셀 SVG 를 그대로 inline. /logo.svg 를 가져오는
    # 요청도 같은 미들웨어가 막아 빈 화면이 되므로 차단 페이지에는
    # 외부 리소스 의존이 없어야 한다.
    _LOGO_SVG = (
        '<svg width="64" height="64" viewBox="0 0 18 18" '
        'xmlns="http://www.w3.org/2000/svg" shape-rendering="crispEdges" '
        'aria-hidden="true">'
        '<rect x="0" y="0" width="12" height="3" fill="#26A938" />'
        '<rect x="0" y="0" width="3" height="12" fill="#26A938" />'
        '<rect x="0" y="10" width="6" height="2" fill="#26A938" />'
        '<rect x="8" y="10" width="4" height="2" fill="#26A938" />'
        '<rect x="15" y="6" width="3" height="12" fill="#1E54A4" />'
        '<rect x="6" y="15" width="12" height="3" fill="#1E54A4" />'
        '<rect x="6" y="6" width="2" height="4" fill="#1E54A4" />'
        '<rect x="6" y="12" width="2" height="3" fill="#1E54A4" />'
        '</svg>'
    )

    _BLOCK_HTML = (
        '<!doctype html><html lang="en"><head><meta charset="utf-8" />'
        '<meta name="viewport" content="width=device-width,initial-scale=1" />'
        '<title>Access blocked</title>'
        '<style>'
        'html,body{height:100%;margin:0;}'
        'body{display:flex;align-items:center;justify-content:center;'
        'font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,'
        '"Helvetica Neue",Arial,"Apple SD Gothic Neo","Noto Sans KR",'
        'sans-serif;background:#fafafa;color:#333;}'
        '.box{text-align:center;padding:48px 24px;max-width:480px;}'
        '.logo{margin-bottom:24px;filter:drop-shadow(0 2px 6px '
        'rgba(0,0,0,0.08));}'
        '.msg{font-size:18px;font-weight:500;line-height:1.5;'
        'letter-spacing:-0.01em;}'
        '</style></head><body><div class="box">'
        '<div class="logo">' + _LOGO_SVG + '</div>'
        '<div class="msg">Access has been blocked due to abnormal '
        'requests.</div>'
        '</div></body></html>'
    )

    def __init__(self, app, networks):
        super().__init__(app)
        self.networks = networks

    def _deny(self, request: Request, reason: str) -> HTMLResponse | JSONResponse:
        # Accept 헤더로 브라우저/API 구분 — text/html 이 들어있으면
        # 사람이 보는 화면이라고 가정.
        accept = (request.headers.get("accept") or "").lower()
        if "text/html" in accept:
            return HTMLResponse(self._BLOCK_HTML, status_code=403)
        return JSONResponse({"detail": reason}, status_code=403)

    async def dispatch(self, request: Request, call_next):
        client = request.client
        host = client.host if client else None
        if not host:
            return self._deny(request, "client IP missing")
        try:
            ip = ipaddress.ip_address(host)
        except ValueError:
            return self._deny(request, f"invalid client IP: {host}")
        # 로컬 헬스체크가 죽지 않게 loopback 무조건 통과.
        if ip.is_loopback:
            return await call_next(request)
        for net in self.networks:
            if ip in net:
                return await call_next(request)
        log.warning("IP allowlist: denied %s for %s", host, request.url.path)
        return self._deny(request, "Access denied by IP allowlist")


class SecurityHeadersMiddleware(BaseHTTPMiddleware):
    async def dispatch(self, request: Request, call_next):
        response = await call_next(request)
        h = response.headers
        # Browsers should not sniff types away from what we declare.
        h["X-Content-Type-Options"] = "nosniff"
        # No legacy framing — clickjacking guard. CSP frame-ancestors
        # below covers modern browsers as well.
        h["X-Frame-Options"] = "DENY"
        # Strip referrer for cross-origin navigations.
        h["Referrer-Policy"] = "strict-origin-when-cross-origin"
        # Lock down powerful features we don't use.  microphone 은
        # 회의록 녹음 / 음성 입력에서 same-origin(self) 으로 필요하므로
        # 허용.  geolocation/camera/payment/usb 는 전혀 안 써서 차단.
        # 주의: microphone=() (빈 allowlist) 로 두면 self 까지 막혀
        # HTTPS 에서도 getUserMedia 가 거부된다 — 반드시 (self).
        h["Permissions-Policy"] = (
            "geolocation=(), microphone=(self), camera=(), payment=(), usb=()"
        )
        # CSP only for HTML responses; APIs don't need it.
        ctype = h.get("content-type", "")
        if ctype.startswith("text/html"):
            h["Content-Security-Policy"] = (
                "default-src 'self'; "
                "script-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net; "
                "worker-src 'self' blob:; "
                "style-src 'self' 'unsafe-inline'; "
                # Allow any https image — Naver shopping aggregates many
                # malls (Coupang, 11번가, GMarket, ...) and returns their
                # original CDN URLs, which we can't enumerate up front.
                "img-src 'self' data: blob: https:; "
                "font-src 'self' data:; "
                "connect-src 'self' https://cdn.jsdelivr.net; "
                "frame-ancestors 'none'; "
                "base-uri 'self'; "
                "object-src 'none'"
            )
        return response


app = FastAPI(title="Chat", lifespan=lifespan)
# 오류 캡처 미들웨어 — 모든 예외 / 5xx / 413·429 응답을 ErrorLog 에
# 한 줄씩 기록. add_middleware 는 LIFO 라 가장 바깥에 두려면 마지막에
# 추가해야 하지만, 다른 미들웨어가 던지는 예외도 잡고 싶으면 가장
# 안쪽에 둬야 함 → '안쪽' 에 두기 위해 가장 *먼저* 등록.
from .error_log import ErrorLogMiddleware
from .request_log import RequestLogMiddleware
app.add_middleware(ErrorLogMiddleware)
# RequestLogMiddleware 는 ErrorLogMiddleware 바깥에 — 에러가 raise 돼도
# 응답 status code 가 결정된 뒤 latency 를 찍을 수 있도록.
app.add_middleware(RequestLogMiddleware)
app.add_middleware(SecurityHeadersMiddleware)
app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.cors_origin_list,
    allow_credentials=True,
    allow_methods=["GET", "POST", "PATCH", "DELETE", "OPTIONS"],
    allow_headers=["Authorization", "Content-Type"],
    max_age=600,
)

# IP allowlist 는 모든 요청을 가장 먼저 보도록 add_middleware 는 가장
# 늦게 — Starlette 가 미들웨어를 LIFO 로 감싸기 때문에, 마지막에 추가
# 한 것이 가장 바깥(첫 번째)에 들어간다. ALLOWED_CLIENT_IPS 가 비어
# 있으면 미들웨어 자체를 등록 안 함 → 오버헤드 0.
_allowed_nets = settings.allowed_client_networks
if _allowed_nets:
    app.add_middleware(IPAllowlistMiddleware, networks=_allowed_nets)
    log.info(
        "IP allowlist enabled (%d 항목): %s",
        len(_allowed_nets),
        settings.allowed_client_ips,
    )
elif settings.allowed_client_ips.strip():
    # 비어 있지 않은데 파싱이 다 실패한 경우 — 사용자가 가두려 했는데
    # 모든 IP 가 통과하는 위험한 상태이므로 명시적으로 경고.
    log.warning(
        "ALLOWED_CLIENT_IPS 값이 비어있지 않은데 유효한 IP/CIDR이 "
        "없습니다. 허용 목록이 비활성화된 채로 부팅합니다. 값: %r",
        settings.allowed_client_ips,
    )

app.include_router(auth.router)
app.include_router(auth.me_router)
app.include_router(sessions.router)
app.include_router(chat_projects.router)
app.include_router(chat.router)
app.include_router(files.router)
app.include_router(ollama.router)
app.include_router(code.router)
app.include_router(admin.router)
app.include_router(prompts.router)
app.include_router(personas.router)
app.include_router(macros.router)
app.include_router(macros.sys_router)
app.include_router(api_keys.router)
app.include_router(snippets.router)
app.include_router(cowork.teams_router)
app.include_router(cowork.comments_router)
app.include_router(cowork.notifications_router)
app.include_router(cowork.actions_router)
app.include_router(cowork.runs_router)
app.include_router(workflows.router)
app.include_router(transcripts.router)
app.include_router(search.router)
if _RAG_AVAILABLE and _projects_router is not None:
    app.include_router(_projects_router.router)
else:
    log.warning(
        "RAG endpoints disabled — qdrant-client not installed. "
        "Run: pip install -r requirements.txt"
    )


@app.get("/api/health")
async def health():
    return {"status": "ok"}


@app.get("/api/providers", response_model=list[ProviderInfo])
async def providers():
    return [
        ProviderInfo(
            name=p.name, label=p.label, model=p.model, enabled=p.enabled
        )
        for p in all_providers()
    ]


# ── Optional frontend hosting ─────────────────────────────────────────
# When FRONTEND_DIST_DIR is set in .env and the directory exists, mount
# the built SPA at /. Lets a single uvicorn host both the API and the
# UI — useful for nginx-less single-server deploys. The mount comes
# AFTER every include_router() / @app.get above so /api/* still wins.
# StaticFiles(html=True) returns index.html for any unmatched path so
# client-side React routing works on hard refresh.
if settings.frontend_dist_dir:
    from pathlib import Path
    from fastapi.staticfiles import StaticFiles
    _dist = Path(settings.frontend_dist_dir)
    if _dist.is_dir() and (_dist / "index.html").is_file():
        app.mount("/", StaticFiles(directory=_dist, html=True), name="frontend")
        log.info("frontend mounted from %s", _dist)
    else:
        log.warning(
            "FRONTEND_DIST_DIR=%s but the directory or index.html is missing — "
            "SPA hosting disabled",
            _dist,
        )
