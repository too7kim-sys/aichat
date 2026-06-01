from fastapi import APIRouter, Depends, File, HTTPException, Request, UploadFile

from .. import models
from ..auth import get_current_user
from ..config import settings
from ..files import ExtractError, extract

router = APIRouter(prefix="/api/files", tags=["files"])


@router.post("/extract")
async def extract_file(
    request: Request,
    file: UploadFile = File(...),
    _user: models.User = Depends(get_current_user),
):
    # Refuse oversize uploads before reading them into memory. The
    # Content-Length header isn't authoritative (multipart includes form
    # overhead), so we use it as a fast early-reject only and still cap
    # the in-memory blob below.
    declared = request.headers.get("content-length")
    if declared and declared.isdigit():
        if int(declared) > settings.max_upload_bytes + 8 * 1024:
            raise HTTPException(
                413,
                f"파일이 너무 큽니다 (limit {settings.max_upload_bytes} bytes)",
            )

    # Stream the upload up to the limit instead of reading it all at
    # once. file.read(n) returns at most n bytes.
    chunks: list[bytes] = []
    total = 0
    while True:
        chunk = await file.read(64 * 1024)
        if not chunk:
            break
        total += len(chunk)
        if total > settings.max_upload_bytes:
            raise HTTPException(
                413,
                f"파일이 너무 큽니다 (limit {settings.max_upload_bytes} bytes)",
            )
        chunks.append(chunk)
    blob = b"".join(chunks)
    try:
        result = extract(file.filename or "uploaded", blob)
    except ExtractError as exc:
        raise HTTPException(400, str(exc))
    return {
        "filename": result.filename,
        "text": result.text,
        "char_count": result.char_count,
        "method": result.method,
    }
