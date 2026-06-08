"""File text extraction with optional OCR fallback.

Strategy per extension:
- .txt/.md/.csv/.json/source code: utf-8 decode (latin-1 fallback)
- .pdf: PyMuPDF text extraction; if a page yields almost no text, rasterize
  it and OCR via Tesseract (scanned PDF support)
- .docx: python-docx
- images (.png/.jpg/.jpeg/.gif/.bmp/.tif/.tiff/.webp): direct Tesseract OCR
  AND (when the chat routes to a vision-capable Ollama model) the raw
  bytes are surfaced as base64 so the model sees the image directly.

Failures are surfaced as ExtractError with a user-facing message; the router
turns these into 400 responses.
"""
from __future__ import annotations

import base64
import io
from dataclasses import dataclass

from ..config import settings

_TEXT_EXTENSIONS = {
    ".txt", ".md", ".markdown", ".csv", ".tsv", ".json", ".jsonl",
    ".yaml", ".yml", ".xml", ".html", ".htm", ".log",
    ".py", ".js", ".ts", ".tsx", ".jsx", ".java", ".kt", ".rs", ".go",
    ".c", ".cpp", ".h", ".hpp", ".cs", ".rb", ".php", ".sh", ".sql",
    ".css", ".scss", ".toml", ".ini", ".cfg", ".env",
}
_IMAGE_EXTENSIONS = {
    ".png", ".jpg", ".jpeg", ".gif", ".bmp", ".tif", ".tiff", ".webp",
}


class ExtractError(RuntimeError):
    pass


@dataclass
class Extracted:
    filename: str
    text: str
    char_count: int
    method: str  # text | pdf | pdf+ocr | docx | ocr | image-no-ocr | image-no-text
    # base64 of the original bytes when the attachment is an image —
    # picked up by the Ollama provider when the routed model is vision-
    # capable so the model sees the picture, not just the OCR text.
    image_b64: str | None = None


def _truncate(text: str) -> str:
    limit = settings.max_attachment_chars
    if len(text) <= limit:
        return text
    return text[:limit] + f"\n\n[... truncated at {limit} chars]"


def _ext(filename: str) -> str:
    dot = filename.rfind(".")
    return filename[dot:].lower() if dot >= 0 else ""


def _decode_text(blob: bytes) -> str:
    for enc in ("utf-8", "utf-8-sig", "cp949", "euc-kr", "latin-1"):
        try:
            return blob.decode(enc)
        except UnicodeDecodeError:
            continue
    return blob.decode("utf-8", errors="replace")


def _configure_tesseract() -> None:
    import pytesseract

    cmd = settings.tesseract_cmd.strip()
    if cmd:
        pytesseract.pytesseract.tesseract_cmd = cmd


def _ocr_image(image_bytes: bytes) -> str:
    try:
        import pytesseract
        from PIL import Image
    except ImportError as exc:
        raise ExtractError(f"OCR dependency missing: {exc}") from exc

    _configure_tesseract()
    try:
        with Image.open(io.BytesIO(image_bytes)) as img:
            return pytesseract.image_to_string(img, lang=settings.ocr_languages)
    except pytesseract.TesseractNotFoundError as exc:
        raise ExtractError(
            "Tesseract binary not found. Install it and set TESSERACT_CMD in .env."
        ) from exc
    except Exception as exc:  # noqa: BLE001
        raise ExtractError(f"OCR failed: {exc}") from exc


def _extract_pdf(blob: bytes) -> tuple[str, str]:
    """Return (text, method). Falls back to OCR for pages without text."""
    try:
        import fitz  # PyMuPDF
    except ImportError as exc:
        raise ExtractError(f"PDF dependency missing: {exc}") from exc

    parts: list[str] = []
    ocr_pages = 0
    try:
        with fitz.open(stream=blob, filetype="pdf") as doc:
            for i, page in enumerate(doc, start=1):
                text = page.get_text("text").strip()
                if len(text) < 20:
                    # Likely a scanned/image page; rasterize and OCR.
                    pix = page.get_pixmap(dpi=200)
                    text = _ocr_image(pix.tobytes("png")).strip()
                    ocr_pages += 1
                if text:
                    parts.append(f"[page {i}]\n{text}")
    except ExtractError:
        raise
    except Exception as exc:  # noqa: BLE001
        raise ExtractError(f"PDF parse failed: {exc}") from exc

    method = "pdf+ocr" if ocr_pages else "pdf"
    return "\n\n".join(parts), method


def _extract_docx(blob: bytes) -> str:
    try:
        from docx import Document
    except ImportError as exc:
        raise ExtractError(f"DOCX dependency missing: {exc}") from exc

    try:
        doc = Document(io.BytesIO(blob))
    except Exception as exc:  # noqa: BLE001
        raise ExtractError(f"DOCX parse failed: {exc}") from exc

    parts = [p.text for p in doc.paragraphs if p.text.strip()]
    for table in doc.tables:
        for row in table.rows:
            cells = [cell.text.strip() for cell in row.cells]
            if any(cells):
                parts.append(" | ".join(cells))
    return "\n".join(parts)


def _extract_xlsx(blob: bytes) -> str:
    """Read every visible cell of every worksheet via openpyxl, one
    "sheet : row" line per non-empty row. Returns a flat text dump
    the chunker can split — no formatting / formulas, just values."""
    try:
        from openpyxl import load_workbook
    except ImportError as exc:
        raise ExtractError(f"XLSX dependency missing: {exc}") from exc
    try:
        wb = load_workbook(
            io.BytesIO(blob), read_only=True, data_only=True,
        )
    except Exception as exc:  # noqa: BLE001
        raise ExtractError(f"XLSX parse failed: {exc}") from exc
    parts: list[str] = []
    for sheet in wb.worksheets:
        parts.append(f"# {sheet.title}")
        for row in sheet.iter_rows(values_only=True):
            cells = [str(c) for c in row if c not in (None, "")]
            if cells:
                parts.append(" | ".join(cells))
        parts.append("")
    wb.close()
    return "\n".join(parts).rstrip()


def _extract_pptx(blob: bytes) -> str:
    """python-pptx — pull every text frame on every slide. Each
    slide gets a `## Slide N` header so retrieval can anchor a
    chunk to a slide number."""
    try:
        from pptx import Presentation
    except ImportError as exc:
        raise ExtractError(f"PPTX dependency missing: {exc}") from exc
    try:
        prs = Presentation(io.BytesIO(blob))
    except Exception as exc:  # noqa: BLE001
        raise ExtractError(f"PPTX parse failed: {exc}") from exc
    parts: list[str] = []
    for idx, slide in enumerate(prs.slides, start=1):
        parts.append(f"## Slide {idx}")
        for shape in slide.shapes:
            if shape.has_text_frame:
                for para in shape.text_frame.paragraphs:
                    line = "".join(run.text for run in para.runs).strip()
                    if line:
                        parts.append(line)
            # Tables in slides
            if getattr(shape, "has_table", False) and shape.has_table:
                for row in shape.table.rows:
                    cells = [c.text.strip() for c in row.cells]
                    if any(cells):
                        parts.append(" | ".join(cells))
        # Slide notes — often holds the real content for review decks
        if slide.has_notes_slide:
            notes = slide.notes_slide.notes_text_frame.text.strip()
            if notes:
                parts.append("notes:")
                parts.append(notes)
        parts.append("")
    return "\n".join(parts).rstrip()


def _extract_ole_preview(blob: bytes, label: str) -> str:
    """Generic fallback for the legacy OLE2 office formats
    (.doc / .xls / .ppt). They're CFB compound documents the same
    as HWP 5.x; we pull the most useful text streams and stitch
    them together. Not as complete as the proper office parsers,
    but enough for a "find docs that mention X" hit and avoids
    pulling in heavy dependencies (textract / antiword / xlrd)
    for the increasingly rare legacy formats."""
    try:
        import olefile
    except ImportError as exc:
        raise ExtractError(f"OLE dependency missing: {exc}") from exc
    bio = io.BytesIO(blob)
    if not olefile.isOleFile(bio):
        raise ExtractError(f"{label} is not a valid OLE2 container")
    ole = olefile.OleFileIO(bio)
    parts: list[str] = []
    # Candidates ordered most-useful first.
    candidates = [
        "WordDocument",       # .doc body (binary, but readable strings)
        "0Table", "1Table",  # .doc table streams
        "PowerPoint Document",  # .ppt body
        "PrvText",           # HWP-style preview text (UTF-16LE)
        "SummaryInformation",
        "DocumentSummaryInformation",
        "Workbook", "Book",  # .xls — note xls's binary format is gnarly
    ]
    try:
        for name in candidates:
            if not ole.exists(name):
                continue
            try:
                stream = ole.openstream(name)
                data = stream.read()
                stream.close()
            except Exception:  # noqa: BLE001
                continue
            # Try UTF-16LE first (HWP / many MS streams), then ASCII
            # printable run extraction so the index gets the actual
            # words rather than raw binary noise.
            try:
                text16 = data.decode("utf-16-le", errors="ignore")
            except Exception:  # noqa: BLE001
                text16 = ""
            # Keep printable + Korean text only — strip the binary noise
            # that surrounds real text in these streams.
            import re
            text16 = re.sub(
                r"[^ -~ -ɏ가-힯぀-ヿ一-鿿\n]+",
                " ",
                text16,
            )
            text16 = re.sub(r"\s+", " ", text16).strip()
            if len(text16) >= 32:
                parts.append(text16)
    finally:
        ole.close()
    if not parts:
        raise ExtractError(f"{label}: no readable text streams found")
    return "\n\n".join(parts)


def _looks_like_image(blob: bytes) -> bool:
    """Magic-byte sniff so a clipboard paste with no/wrong extension
    still gets routed to OCR. Covers PNG, JPEG, GIF, BMP, WEBP, TIFF."""
    if len(blob) < 12:
        return False
    head = blob[:12]
    return (
        head.startswith(b"\x89PNG\r\n\x1a\n")  # PNG
        or head.startswith(b"\xff\xd8\xff")     # JPEG
        or head.startswith(b"GIF87a") or head.startswith(b"GIF89a")
        or head.startswith(b"BM")               # BMP
        or (head[:4] == b"RIFF" and head[8:12] == b"WEBP")
        or head.startswith(b"II*\x00") or head.startswith(b"MM\x00*")  # TIFF
    )


def extract(filename: str, blob: bytes) -> Extracted:
    if len(blob) > settings.max_upload_bytes:
        raise ExtractError(
            f"File too large: {len(blob)} bytes (limit {settings.max_upload_bytes})"
        )

    ext = _ext(filename)
    is_image = ext in _IMAGE_EXTENSIONS or (
        not ext and _looks_like_image(blob)
    )

    if ext == ".pdf":
        text, method = _extract_pdf(blob)
    elif ext == ".docx":
        text, method = _extract_docx(blob), "docx"
    elif is_image:
        # Image attachments never 400 — OCR is best-effort. If Tesseract
        # is missing or the image has no readable text we still return a
        # placeholder so the chat can proceed (and vision-capable models
        # can later use the binary out-of-band).
        try:
            text = _ocr_image(blob)
            method = "ocr"
        except ExtractError as exc:
            text = (
                f"[이미지 첨부됨: {filename or 'image'}, {len(blob):,} bytes]\n"
                f"[OCR을 수행할 수 없습니다: {exc}]"
            )
            method = "image-no-ocr"
    elif ext in _TEXT_EXTENSIONS or not ext:
        text, method = _decode_text(blob), "text"
    else:
        # Unknown extension: try as text, last resort.
        text, method = _decode_text(blob), "text"

    text = text.strip()
    if not text:
        if is_image:
            text = (
                f"[이미지 첨부됨: {filename or 'image'}, {len(blob):,} bytes]\n"
                "[OCR 결과 추출 가능한 텍스트가 없습니다. 비전 모델에서 "
                "이미지 내용을 확인할 수 있습니다.]"
            )
            method = "image-no-text"
        else:
            raise ExtractError(
                "No text could be extracted (empty document or unsupported content)."
            )

    text = _truncate(text)
    image_b64 = (
        base64.b64encode(blob).decode("ascii") if is_image else None
    )
    return Extracted(
        filename=filename, text=text, char_count=len(text), method=method,
        image_b64=image_b64,
    )
