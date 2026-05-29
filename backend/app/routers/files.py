from fastapi import APIRouter, File, HTTPException, UploadFile

from ..files import ExtractError, extract

router = APIRouter(prefix="/api/files", tags=["files"])


@router.post("/extract")
async def extract_file(file: UploadFile = File(...)):
    blob = await file.read()
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
