from fastapi import APIRouter, HTTPException

from ..providers.ollama import OllamaProvider

router = APIRouter(prefix="/api/ollama", tags=["ollama"])

_provider = OllamaProvider()


@router.get("/models")
async def list_models():
    if not _provider.enabled:
        raise HTTPException(503, "Ollama not configured")
    try:
        models = await _provider.list_models()
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(502, f"{type(exc).__name__}: {exc}")
    return {
        "current": _provider.model,
        "models": [
            {
                "name": m.get("name") or m.get("model") or "",
                "size": m.get("size", 0),
                "modified_at": m.get("modified_at"),
                "parameter_size": (m.get("details") or {}).get("parameter_size"),
            }
            for m in models
        ],
    }
