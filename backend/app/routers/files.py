from fastapi import APIRouter, Depends, File, Form, HTTPException, Request, UploadFile
from fastapi.responses import Response

from .. import models
from ..auth import get_current_user
from ..config import settings
from ..files import ExtractError, extract
from ..files.merge import MergeError, MergeInput, merge as do_merge

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
        "image_b64": result.image_b64,
    }


@router.post("/merge")
async def merge_files(
    request: Request,
    files: list[UploadFile] = File(...),
    title: str = Form(""),
    with_separators: str = Form("true"),
    _user: models.User = Depends(get_current_user),
):
    """Merge multiple uploaded files into a single document of the
    same format. The merge module enforces that every input shares
    one extension — mixed-format input gets a 400 with a clear
    message rather than a half-baked output."""
    if not files:
        raise HTTPException(400, "병합할 파일이 없습니다.")
    if len(files) < 2:
        raise HTTPException(400, "병합하려면 파일이 2개 이상 필요합니다.")

    # Reject the entire batch if the combined size blows past the
    # per-upload cap × 4 (rough cap on the merge surface). The
    # individual files were already capped at upload time by the
    # /extract endpoint, but Direct merge uploads bypass that, so we
    # re-cap here.
    declared = request.headers.get("content-length")
    cap = settings.max_upload_bytes * 4
    if declared and declared.isdigit() and int(declared) > cap + 32 * 1024:
        raise HTTPException(
            413,
            f"병합 요청이 너무 큽니다 (limit {cap} bytes)",
        )

    inputs: list[MergeInput] = []
    total = 0
    for f in files:
        # Same streaming-cap pattern as the extract route — a single
        # malicious file shouldn't be able to balloon memory just
        # because it's tucked inside a merge batch.
        chunks: list[bytes] = []
        while True:
            chunk = await f.read(64 * 1024)
            if not chunk:
                break
            total += len(chunk)
            if total > cap:
                raise HTTPException(
                    413,
                    f"병합 요청이 너무 큽니다 (limit {cap} bytes)",
                )
            chunks.append(chunk)
        inputs.append(
            MergeInput(
                filename=f.filename or "untitled",
                blob=b"".join(chunks),
            )
        )

    sep_flag = with_separators.strip().lower() in {"1", "true", "yes", "on"}
    try:
        result = do_merge(inputs, title=title, with_separators=sep_flag)
    except MergeError as exc:
        raise HTTPException(400, str(exc))
    except Exception as exc:  # pragma: no cover — surface internal bugs
        raise HTTPException(500, f"병합 중 오류: {exc}") from exc

    # Quote the filename for the Content-Disposition header so non-
    # ASCII titles (Korean) round-trip cleanly.
    from urllib.parse import quote

    disposition = (
        "attachment; "
        f"filename*=UTF-8''{quote(result.filename)}"
    )
    return Response(
        content=result.blob,
        media_type=result.content_type,
        headers={"Content-Disposition": disposition},
    )
