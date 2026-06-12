import ipaddress
import logging
from contextlib import asynccontextmanager

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from starlette.middleware.base import BaseHTTPMiddleware

from .config import settings
from .database import init_db
from .providers.registry import all_providers
from .routers import (
    admin, auth, chat, chat_projects, code, files, ollama, prompts, search,
    sessions, transcripts, workflows,
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


@asynccontextmanager
async def lifespan(app: FastAPI):
    if settings.jwt_secret == "dev-only-change-me":
        log.warning(
            "JWT_SECRET is set to the default placeholder. Generate a strong "
            "random value (python -c 'import secrets; print(secrets.token_urlsafe(48))') "
            "and put it in backend/.env before exposing this service."
        )
    await init_db()
    # Seed runtime settings from env-var defaults (one-time on a
    # fresh install). After this the DB is the source of truth.
    from . import app_settings
    from .database import SessionLocal
    async with SessionLocal() as _s:
        await app_settings.seed_defaults(_s)

    # Start the RAG scheduler if qdrant-client is installed. Guarded
    # behind the same import block as the projects router so the app
    # stays up when the optional dep is missing.
    import asyncio
    scheduler_task = None
    wf_scheduler_task = None
    if _RAG_AVAILABLE:
        try:
            from .rag.indexer import scheduler_loop
            scheduler_task = asyncio.create_task(scheduler_loop())
        except Exception as exc:  # noqa: BLE001
            log.warning("RAG scheduler not started: %s", exc)
    try:
        from .workflows.scheduler import scheduler_loop as wf_loop
        wf_scheduler_task = asyncio.create_task(wf_loop())
    except Exception as exc:  # noqa: BLE001
        log.warning("workflow scheduler not started: %s", exc)

    try:
        yield
    finally:
        for t in (scheduler_task, wf_scheduler_task):
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
    이 박스 직접 노출)에서는 그대로 TCP 피어의 IP 가 들어온다."""

    def __init__(self, app, networks):
        super().__init__(app)
        self.networks = networks

    async def dispatch(self, request: Request, call_next):
        client = request.client
        host = client.host if client else None
        if not host:
            return JSONResponse(
                {"detail": "client IP missing"}, status_code=403
            )
        try:
            ip = ipaddress.ip_address(host)
        except ValueError:
            return JSONResponse(
                {"detail": f"invalid client IP: {host}"}, status_code=403
            )
        # 로컬 헬스체크가 죽지 않게 loopback 무조건 통과.
        if ip.is_loopback:
            return await call_next(request)
        for net in self.networks:
            if ip in net:
                return await call_next(request)
        log.warning("IP allowlist: denied %s for %s", host, request.url.path)
        return JSONResponse(
            {"detail": "Access denied by IP allowlist"}, status_code=403
        )


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
        # Lock down powerful features we don't use.
        h["Permissions-Policy"] = (
            "geolocation=(), microphone=(), camera=(), payment=(), usb=()"
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
