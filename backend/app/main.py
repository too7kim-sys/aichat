import logging
from contextlib import asynccontextmanager

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from starlette.middleware.base import BaseHTTPMiddleware

from .config import settings
from .database import init_db
from .providers.registry import all_providers
from .routers import auth, chat, files, ollama, sessions

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

    # Start the RAG scheduler if qdrant-client is installed. Guarded
    # behind the same import block as the projects router so the app
    # stays up when the optional dep is missing.
    import asyncio
    scheduler_task = None
    if _RAG_AVAILABLE:
        try:
            from .rag.indexer import scheduler_loop
            scheduler_task = asyncio.create_task(scheduler_loop())
        except Exception as exc:  # noqa: BLE001
            log.warning("RAG scheduler not started: %s", exc)

    try:
        yield
    finally:
        if scheduler_task is not None:
            scheduler_task.cancel()
            try:
                await scheduler_task
            except (asyncio.CancelledError, Exception):
                pass


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

app.include_router(auth.router)
app.include_router(auth.me_router)
app.include_router(sessions.router)
app.include_router(chat.router)
app.include_router(files.router)
app.include_router(ollama.router)
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
