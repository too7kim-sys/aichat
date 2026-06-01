from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from .config import settings
from .database import init_db
from .providers.registry import all_providers
from .routers import chat, files, ollama, sessions
from .schemas import ProviderInfo


@asynccontextmanager
async def lifespan(app: FastAPI):
    await init_db()
    yield


app = FastAPI(title="Chat", lifespan=lifespan)
app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.cors_origin_list,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(sessions.router)
app.include_router(chat.router)
app.include_router(files.router)
app.include_router(ollama.router)


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
