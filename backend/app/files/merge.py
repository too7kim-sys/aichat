"""Format-preserving merge for chat attachments.

Phase 1 scope — same-format-only:
  - .pdf  via PyMuPDF (already a dep)
  - .docx via docxcompose (composes docx-from-template style, preserves
          headers/footers/numbering correctly — better than naive
          element-append)
  - .xlsx via openpyxl (copy each source sheet into a destination
          workbook; sheet names disambiguated on collision)
  - .pptx via python-pptx + a slide-copy helper (python-pptx itself has
          no built-in copy-slide; the helper deep-copies the slide XML
          element and re-links its relationships)
  - .hwpx via zipfile + XML stitching (HWPX is a zip of OWPML XML;
          stitching `Contents/section*.xml` files into one document is
          feasible without any extra dependency)

Mixed-format input is rejected with MergeError in this phase — Phase 2
will add a "convert all to PDF and merge" mode that requires
LibreOffice headless to be installed system-wide.

HWP (the old proprietary binary format) is intentionally not handled
here — Phase 3.

The "with_separators" flag inserts a generated divider between source
documents (a page in PDF, a paragraph heading in DOCX, a new sheet
named like "── filename ──" in XLSX, a divider slide in PPTX, a
section break with a heading in HWPX). When false, sources are
concatenated continuously.
"""
from __future__ import annotations

import copy
import html as _html
import io
import re
import uuid
import zipfile
from dataclasses import dataclass

import fitz  # PyMuPDF — already a dep via pymupdf


class MergeError(RuntimeError):
    """Raised when a merge can't proceed — wrong/mixed extensions,
    corrupt input, unsupported variant. The router turns this into a
    400 response with the message verbatim."""


@dataclass
class MergeInput:
    filename: str
    blob: bytes


@dataclass
class MergeResult:
    filename: str
    content_type: str
    blob: bytes


_SUPPORTED = {".pdf", ".docx", ".xlsx", ".pptx", ".hwpx"}


def _ext(name: str) -> str:
    """Lowercased extension including the dot, or empty string."""
    i = name.rfind(".")
    return name[i:].lower() if i >= 0 else ""


def _common_extension(inputs: list[MergeInput]) -> str:
    if not inputs:
        raise MergeError("병합할 파일이 없습니다.")
    exts = {_ext(i.filename) for i in inputs}
    if len(exts) != 1:
        joined = ", ".join(sorted(e or "(없음)" for e in exts))
        raise MergeError(
            f"같은 형식끼리만 병합할 수 있습니다. 감지된 형식: {joined}",
        )
    ext = next(iter(exts))
    if ext not in _SUPPORTED:
        raise MergeError(f"지원하지 않는 형식입니다: {ext or '(확장자 없음)'}")
    return ext


def _safe_basename(title: str, fallback: str = "merged") -> str:
    cleaned = re.sub(r"[\x00-\x1f\x7f]", "", title or "").strip()
    cleaned = re.sub(r"[\\/]+", " ", cleaned)
    cleaned = re.sub(r"\s+", " ", cleaned)[:80]
    return cleaned or fallback


def merge(
    inputs: list[MergeInput],
    *,
    title: str,
    with_separators: bool,
) -> MergeResult:
    """Dispatch on the (single) extension and build the merged blob."""
    ext = _common_extension(inputs)
    base = _safe_basename(title)
    if ext == ".pdf":
        return _merge_pdf(inputs, base, with_separators)
    if ext == ".docx":
        return _merge_docx(inputs, base, with_separators)
    if ext == ".xlsx":
        return _merge_xlsx(inputs, base, with_separators)
    if ext == ".pptx":
        return _merge_pptx(inputs, base, with_separators)
    if ext == ".hwpx":
        return _merge_hwpx(inputs, base, with_separators)
    # Defensive — _common_extension already filtered.
    raise MergeError(f"지원하지 않는 형식입니다: {ext}")


# --- PDF ---------------------------------------------------------------

def _merge_pdf(
    inputs: list[MergeInput],
    base: str,
    with_separators: bool,
) -> MergeResult:
    dst = fitz.open()
    try:
        for item in inputs:
            try:
                src = fitz.open(stream=item.blob, filetype="pdf")
            except Exception as exc:
                raise MergeError(
                    f"PDF 열기 실패 ({item.filename}): {exc}",
                ) from exc
            try:
                if with_separators:
                    _insert_pdf_divider_page(dst, item.filename)
                dst.insert_pdf(src)
            finally:
                src.close()
        out = dst.tobytes()
    finally:
        dst.close()
    return MergeResult(
        filename=f"{base}.pdf",
        content_type="application/pdf",
        blob=out,
    )


def _insert_pdf_divider_page(dst: "fitz.Document", filename: str) -> None:
    """Append a single A4 page with the source filename centered.
    Used as a separator between source PDFs when the caller asked for
    visible boundaries.

    insert_htmlbox uses the PyMuPDF Story renderer, which falls back
    to system fonts for CJK glyphs — so Korean filenames actually
    show up instead of rendering as boxes (which is what plain
    insert_text with "helv" used to do)."""
    page = dst.new_page(width=595, height=842)  # A4 in points
    label = f"📄 {filename}"
    # Big centered title block — leaves the rest of the page empty so
    # the source's first page begins on the next sheet.
    rect = fitz.Rect(50, 300, 545, 500)
    html = (
        '<div style="font-family: sans-serif; font-size: 20pt; '
        'text-align: center; color: #222;">'
        f"{_html.escape(label)}</div>"
    )
    try:
        page.insert_htmlbox(rect, html)
        return
    except Exception:
        pass
    # Fallback 1 — try a CJK fontname for Korean characters; PyMuPDF
    # ships a few CIDFonts (korea / korea-s) since 1.21.
    try:
        page.insert_text(
            fitz.Point(60, 400), label, fontsize=18, fontname="korea",
        )
        return
    except Exception:
        pass
    # Fallback 2 — plain helv; ASCII parts of the filename will still
    # show, Korean glyphs may render as boxes. Better than nothing.
    try:
        page.insert_text(
            fitz.Point(60, 400), label, fontsize=18, fontname="helv",
        )
    except Exception:
        # Final fallback: page stays blank but the divider is at least
        # there so the source-document boundary is visible.
        pass


# --- DOCX --------------------------------------------------------------

def _merge_docx(
    inputs: list[MergeInput],
    base: str,
    with_separators: bool,
) -> MergeResult:
    try:
        from docx import Document
        from docxcompose.composer import Composer
    except ImportError as exc:
        raise MergeError(
            "DOCX 병합 의존성이 설치돼 있지 않습니다 (python-docx, docxcompose).",
        ) from exc

    # First input becomes the master; subsequent docs are composed in.
    try:
        master = Document(io.BytesIO(inputs[0].blob))
    except Exception as exc:
        raise MergeError(
            f"DOCX 열기 실패 ({inputs[0].filename}): {exc}",
        ) from exc

    if with_separators:
        _append_docx_heading(master, inputs[0].filename)

    composer = Composer(master)
    for item in inputs[1:]:
        try:
            src = Document(io.BytesIO(item.blob))
        except Exception as exc:
            raise MergeError(
                f"DOCX 열기 실패 ({item.filename}): {exc}",
            ) from exc
        if with_separators:
            _append_docx_heading(src, item.filename, leading_page_break=True)
        else:
            # Page-break between docs even without a heading keeps
            # body content from running together mid-page.
            _append_docx_page_break(master)
        composer.append(src)

    buf = io.BytesIO()
    composer.save(buf)
    return MergeResult(
        filename=f"{base}.docx",
        content_type=(
            "application/vnd.openxmlformats-officedocument."
            "wordprocessingml.document"
        ),
        blob=buf.getvalue(),
    )


def _append_docx_heading(
    doc, filename: str, *, leading_page_break: bool = False
) -> None:
    """Prepend a heading paragraph identifying the source file. When
    leading_page_break is set, a hard page break precedes the heading
    so the next document starts on a fresh page."""
    from docx.enum.text import WD_BREAK

    if leading_page_break:
        p = doc.paragraphs[0] if doc.paragraphs else doc.add_paragraph()
        # Insert a page-break run at the very start of the document.
        run = p.insert_paragraph_before().add_run()
        run.add_break(WD_BREAK.PAGE)
    # add a real heading at the doc start — prepending via insert_paragraph_before
    if doc.paragraphs:
        anchor = doc.paragraphs[0]
        heading = anchor.insert_paragraph_before(
            f"📄 {filename}", style="Heading 2"
        )
        _ = heading
    else:
        doc.add_heading(f"📄 {filename}", level=2)


def _append_docx_page_break(doc) -> None:
    from docx.enum.text import WD_BREAK

    p = doc.add_paragraph()
    p.add_run().add_break(WD_BREAK.PAGE)


# --- XLSX --------------------------------------------------------------

def _merge_xlsx(
    inputs: list[MergeInput],
    base: str,
    with_separators: bool,
) -> MergeResult:
    try:
        from copy import copy as _copy

        from openpyxl import Workbook, load_workbook
        from openpyxl.utils import get_column_letter
    except ImportError as exc:
        raise MergeError(
            "XLSX 병합 의존성이 설치돼 있지 않습니다 (openpyxl).",
        ) from exc

    dst = Workbook()
    # Workbook() seeds a default sheet — we drop it once we have a
    # real sheet to anchor on. If we drop it first the workbook
    # becomes invalid (must have ≥1 sheet at save time).
    default_sheet = dst.active

    used_names: set[str] = set()

    def _unique_name(stem: str) -> str:
        """Excel sheet names: ≤31 chars, no []:*?/\\, unique."""
        cleaned = re.sub(r"[\[\]:\*\?/\\]", "_", stem)[:31] or "Sheet"
        candidate = cleaned
        n = 2
        while candidate in used_names or candidate in dst.sheetnames:
            suffix = f" ({n})"
            candidate = (cleaned[: 31 - len(suffix)] + suffix)
            n += 1
        used_names.add(candidate)
        return candidate

    for item in inputs:
        try:
            src = load_workbook(io.BytesIO(item.blob), data_only=False)
        except Exception as exc:
            raise MergeError(
                f"XLSX 열기 실패 ({item.filename}): {exc}",
            ) from exc

        if with_separators:
            divider_name = _unique_name(f"── {item.filename} ──")
            ws = dst.create_sheet(title=divider_name)
            ws["A1"] = f"📄 {item.filename}"
            ws["A2"] = f"({len(src.sheetnames)}개 시트)"
            ws.column_dimensions[get_column_letter(1)].width = 60

        stem = item.filename.rsplit(".", 1)[0]
        for src_name in src.sheetnames:
            src_ws = src[src_name]
            # Sheet name pattern: "<file>::<sheet>" so the user can
            # tell where each sheet came from. Trimmed to fit Excel's
            # 31-char limit by _unique_name.
            new_name = _unique_name(f"{stem}::{src_name}")
            new_ws = dst.create_sheet(title=new_name)
            _copy_worksheet(src_ws, new_ws, _copy=_copy)

    # Drop the placeholder sheet now that real content is in place.
    if default_sheet is not None and default_sheet.title in dst.sheetnames:
        del dst[default_sheet.title]

    buf = io.BytesIO()
    dst.save(buf)
    return MergeResult(
        filename=f"{base}.xlsx",
        content_type=(
            "application/vnd.openxmlformats-officedocument."
            "spreadsheetml.sheet"
        ),
        blob=buf.getvalue(),
    )


def _copy_worksheet(src_ws, dst_ws, *, _copy) -> None:
    """Copy cells, basic styles, merged ranges and column widths from
    one openpyxl worksheet to another. Doesn't try to clone every
    chart/pivot/image — those are explicitly out of scope for the
    same-format merge in Phase 1, and we surface that as a soft
    limitation in the UI."""
    for row in src_ws.iter_rows():
        for cell in row:
            new_cell = dst_ws.cell(
                row=cell.row, column=cell.column, value=cell.value,
            )
            if cell.has_style:
                new_cell.font = _copy(cell.font)
                new_cell.fill = _copy(cell.fill)
                new_cell.border = _copy(cell.border)
                new_cell.alignment = _copy(cell.alignment)
                new_cell.number_format = cell.number_format
                new_cell.protection = _copy(cell.protection)
    for mr in src_ws.merged_cells.ranges:
        dst_ws.merge_cells(str(mr))
    for col_letter, dim in src_ws.column_dimensions.items():
        dst_ws.column_dimensions[col_letter].width = dim.width
    for row_idx, dim in src_ws.row_dimensions.items():
        dst_ws.row_dimensions[row_idx].height = dim.height


# --- PPTX --------------------------------------------------------------

def _merge_pptx(
    inputs: list[MergeInput],
    base: str,
    with_separators: bool,
) -> MergeResult:
    try:
        from pptx import Presentation
    except ImportError as exc:
        raise MergeError(
            "PPTX 병합 의존성이 설치돼 있지 않습니다 (python-pptx).",
        ) from exc

    # The first presentation becomes the master (its slide masters,
    # theme, page size are kept). Subsequent slides are appended.
    try:
        dst_prs = Presentation(io.BytesIO(inputs[0].blob))
    except Exception as exc:
        raise MergeError(
            f"PPTX 열기 실패 ({inputs[0].filename}): {exc}",
        ) from exc

    if with_separators:
        _append_pptx_divider(dst_prs, inputs[0].filename)
        # Move the divider to the very front so the source-1 divider
        # precedes source-1's own slides. (python-pptx appends at end
        # by default — we shuffle it.)
        _move_slide_to_front(dst_prs, -1, target_idx=0)

    for item in inputs[1:]:
        try:
            src_prs = Presentation(io.BytesIO(item.blob))
        except Exception as exc:
            raise MergeError(
                f"PPTX 열기 실패 ({item.filename}): {exc}",
            ) from exc
        if with_separators:
            _append_pptx_divider(dst_prs, item.filename)
        for src_slide in src_prs.slides:
            _copy_slide(dst_prs, src_slide)

    buf = io.BytesIO()
    dst_prs.save(buf)
    return MergeResult(
        filename=f"{base}.pptx",
        content_type=(
            "application/vnd.openxmlformats-officedocument."
            "presentationml.presentation"
        ),
        blob=buf.getvalue(),
    )


def _append_pptx_divider(prs, filename: str) -> None:
    """Append a simple title-only slide naming the source file. Uses
    layout 5 (Title Only) when available, falls back to layout 0."""
    layouts = prs.slide_layouts
    layout = layouts[5] if len(layouts) > 5 else layouts[0]
    slide = prs.slides.add_slide(layout)
    if slide.shapes.title is not None:
        slide.shapes.title.text = f"📄 {filename}"


def _copy_slide(dst_prs, src_slide) -> None:
    """Append a copy of src_slide to dst_prs.

    python-pptx has no native copy-slide method. The widely-used
    workaround is to add a blank slide, deep-copy every shape element
    from the source into it, and patch the slide's relationships so
    embedded images and charts continue to resolve. This handles the
    common cases (text, shapes, raster images); embedded objects with
    custom relationships (linked charts, OLE objects) may need
    re-linking — we accept that loss for Phase 1 and surface it as a
    UI caveat."""
    from pptx.oxml.ns import qn

    # Match the source layout when the dest presentation has a layout
    # at the same index; otherwise fall back to the first layout.
    src_layout_idx = list(
        src_slide.slide_layout.slide_master.slide_layouts
    ).index(src_slide.slide_layout)
    layouts = dst_prs.slide_layouts
    layout = layouts[src_layout_idx] if src_layout_idx < len(layouts) else layouts[0]
    new_slide = dst_prs.slides.add_slide(layout)

    # Remove placeholders the layout pre-seeded — the deep-copied
    # source spTree will bring its own shapes.
    for shp in list(new_slide.shapes):
        shp.element.getparent().remove(shp.element)

    src_spTree = src_slide.shapes._spTree
    dst_spTree = new_slide.shapes._spTree
    for el in list(src_spTree):
        # Skip nvGrpSpPr / grpSpPr — those describe the spTree group
        # itself, not shapes.
        if el.tag in (qn("p:nvGrpSpPr"), qn("p:grpSpPr")):
            continue
        dst_spTree.append(copy.deepcopy(el))

    # Re-link image relationships so the cloned <a:blip r:embed="rIdN">
    # references point at copies of the source image parts in the dest
    # package.
    _rewire_slide_image_rels(src_slide, new_slide)


def _rewire_slide_image_rels(src_slide, new_slide) -> None:
    """Walk the cloned slide for r:embed references and republish each
    referenced image part in the destination package, then rewrite the
    embed id to the new relationship."""
    from pptx.oxml.ns import qn

    # Map src rId → dst rId so identical images referenced twice in
    # one slide share a single dest part.
    rel_map: dict[str, str] = {}
    for blip in new_slide.shapes._spTree.iter(qn("a:blip")):
        src_rid = blip.get(qn("r:embed"))
        if not src_rid:
            continue
        if src_rid in rel_map:
            blip.set(qn("r:embed"), rel_map[src_rid])
            continue
        try:
            src_part = src_slide.part.related_part(src_rid)
        except KeyError:
            continue
        # Copy the image blob into the destination package and bind
        # it under a new relationship id.
        new_rid = new_slide.part.relate_to(src_part, _image_reltype())
        rel_map[src_rid] = new_rid
        blip.set(qn("r:embed"), new_rid)


def _image_reltype() -> str:
    """Hard-coded so we don't depend on an internal python-pptx constant
    whose import path varies by version."""
    return (
        "http://schemas.openxmlformats.org/officeDocument/2006/"
        "relationships/image"
    )


def _move_slide_to_front(prs, src_idx: int, target_idx: int) -> None:
    """Reorder slides in a presentation. src_idx can be negative
    (Python-style) — resolved against the current slide count."""
    slides = prs.slides
    sldIdLst = slides._sldIdLst
    children = list(sldIdLst)
    if src_idx < 0:
        src_idx = len(children) + src_idx
    moving = children[src_idx]
    sldIdLst.remove(moving)
    sldIdLst.insert(target_idx, moving)


# --- HWPX --------------------------------------------------------------
#
# HWPX is a ZIP container holding OWPML-compliant XML (the modern HWP
# format used by Hancom Office Hangul 2014+). Structure:
#   mimetype                              (uncompressed, first entry)
#   META-INF/container.xml                (points to Contents/content.hpf)
#   Contents/content.hpf                  (manifest)
#   Contents/header.xml                   (paragraph/character styles)
#   Contents/section0.xml                 (body — section 0)
#   Contents/section1.xml                 (optional — section 1, etc.)
#   Contents/version.xml
#   BinData/*                             (embedded images / OLE)
#
# Merge strategy: keep the first file's package as the base, append
# each subsequent file's <hs:sec ...>...</hs:sec> blocks from their
# Contents/section*.xml as additional sections in the base. Embedded
# BinData files are copied over with renamed paths and the content.hpf
# manifest is updated to register the new section parts.

def _merge_hwpx(
    inputs: list[MergeInput],
    base: str,
    with_separators: bool,
) -> MergeResult:
    # Validate every input is a real HWPX (zip with the expected
    # mimetype) before we start mutating anything.
    parsed: list[zipfile.ZipFile] = []
    try:
        for item in inputs:
            try:
                zf = zipfile.ZipFile(io.BytesIO(item.blob), "r")
            except zipfile.BadZipFile as exc:
                raise MergeError(
                    f"HWPX 열기 실패 ({item.filename}): 손상된 파일",
                ) from exc
            try:
                mt = zf.read("mimetype").decode("ascii", "replace")
            except KeyError as exc:
                raise MergeError(
                    f"HWPX 파일이 아닙니다 ({item.filename}): mimetype 누락",
                ) from exc
            if "hwp" not in mt:
                raise MergeError(
                    f"HWPX 파일이 아닙니다 ({item.filename}): "
                    f"mimetype={mt!r}",
                )
            parsed.append(zf)

        out_buf = io.BytesIO()
        with zipfile.ZipFile(out_buf, "w", zipfile.ZIP_DEFLATED) as out_zip:
            _build_merged_hwpx(parsed, out_zip, with_separators, inputs)
        return MergeResult(
            filename=f"{base}.hwpx",
            content_type="application/vnd.hancom.hwpx",
            blob=out_buf.getvalue(),
        )
    finally:
        for zf in parsed:
            zf.close()


def _build_merged_hwpx(
    parsed: list[zipfile.ZipFile],
    out: zipfile.ZipFile,
    with_separators: bool,
    inputs: list[MergeInput],
) -> None:
    """Construct the merged HWPX in `out` from the base (parsed[0])
    plus body sections lifted from parsed[1:].

    Conservative strategy — covers the common case (text content +
    embedded images) without breaking on edge cases:

    1. Copy the base package wholesale except the section files and
       content.hpf manifest, both of which we re-emit.
    2. Lift section bodies from each input; BinData parts (images)
       are copied with a per-input prefix and rId references inside
       the lifted XML are rewritten to match.
    3. Re-emit content.hpf listing every section we added.
    """
    # Copy the base package's files first — except those we re-emit.
    base = parsed[0]
    skip = {"Contents/content.hpf"}
    section_pattern = re.compile(r"^Contents/section\d+\.xml$")
    base_sections: list[tuple[str, bytes]] = []
    for name in base.namelist():
        data = base.read(name)
        if section_pattern.match(name):
            base_sections.append((name, data))
            continue
        if name in skip:
            continue
        out.writestr(name, data)

    # Sections we'll register in content.hpf, ordered. Each entry:
    # (href, media_type). They're written under fresh section indices.
    section_hrefs: list[str] = []
    next_section_idx = 0

    def write_section(xml_bytes: bytes) -> None:
        nonlocal next_section_idx
        href = f"Contents/section{next_section_idx}.xml"
        next_section_idx += 1
        out.writestr(href, xml_bytes)
        section_hrefs.append(href)

    # Base sections first.
    for _, data in base_sections:
        if with_separators:
            data = _inject_hwpx_heading(data, inputs[0].filename)
        write_section(data)

    # Then each subsequent file's sections. BinData parts get a
    # per-input prefix to avoid collisions with the base package's
    # existing BinData/.
    for src_idx, src_zip in enumerate(parsed[1:], start=1):
        src_input = inputs[src_idx]
        bindata_rename = _copy_hwpx_bindata(src_zip, out, prefix=f"m{src_idx}_")
        for name in src_zip.namelist():
            if not section_pattern.match(name):
                continue
            data = src_zip.read(name)
            # Rewrite BinData href references inside the section XML
            # to point at the renamed parts.
            for old, new in bindata_rename.items():
                data = data.replace(old.encode("utf-8"), new.encode("utf-8"))
            if with_separators:
                data = _inject_hwpx_heading(data, src_input.filename)
            write_section(data)

    # Re-emit content.hpf with the full section list. We can't blindly
    # copy the original because its <manifest> only knew about the
    # base's sections — the new section parts need registering.
    try:
        base_hpf = base.read("Contents/content.hpf").decode("utf-8")
    except KeyError as exc:
        raise MergeError("HWPX 매니페스트(content.hpf) 누락") from exc
    new_hpf = _rewrite_hpf_manifest(base_hpf, section_hrefs)
    out.writestr("Contents/content.hpf", new_hpf.encode("utf-8"))


def _copy_hwpx_bindata(
    src_zip: zipfile.ZipFile,
    out: zipfile.ZipFile,
    *,
    prefix: str,
) -> dict[str, str]:
    """Copy BinData/* from src_zip into out, renaming with `prefix`
    to avoid collisions. Returns a {old_path: new_path} map so the
    caller can rewrite section XML references."""
    mapping: dict[str, str] = {}
    for name in src_zip.namelist():
        if not name.startswith("BinData/"):
            continue
        leaf = name[len("BinData/"):]
        new_leaf = f"{prefix}{leaf}"
        new_path = f"BinData/{new_leaf}"
        try:
            out.writestr(new_path, src_zip.read(name))
        except Exception:
            # If the dest already has this exact path (unlikely with
            # the per-input prefix), skip — better than crashing.
            continue
        mapping[name] = new_path
    return mapping


def _rewrite_hpf_manifest(base_hpf: str, section_hrefs: list[str]) -> str:
    """Rewrite the <manifest> in content.hpf so it lists exactly the
    section parts we wrote. Other manifest items (header.xml,
    version.xml, BinData entries from the base) are preserved
    verbatim — we only edit the section-typed items.

    HWPX content.hpf uses OPF-flavored XML:
        <manifest>
          <item id="..." href="Contents/section0.xml"
                media-type="application/xml"/>
          ...
        </manifest>
    """
    # Remove existing section items.
    cleaned = re.sub(
        r'\s*<item[^>]*href="Contents/section\d+\.xml"[^>]*/>',
        "",
        base_hpf,
    )
    # Build new section entries, keeping the generated ids so we can
    # reference them from <spine> below.
    item_ids: list[str] = []
    new_items: list[str] = []
    for i, href in enumerate(section_hrefs):
        item_id = f"sec{i}_{uuid.uuid4().hex[:8]}"
        item_ids.append(item_id)
        new_items.append(
            f'    <item id="{item_id}" href="{href}" '
            f'media-type="application/xml"/>'
        )
    if "</manifest>" not in cleaned:
        raise MergeError("HWPX content.hpf: </manifest> 태그를 찾지 못함")
    cleaned = cleaned.replace(
        "</manifest>",
        "\n".join(new_items) + "\n  </manifest>",
        1,
    )
    new_spine = (
        "<spine>\n"
        + "\n".join(f'    <itemref idref="{iid}"/>' for iid in item_ids)
        + "\n  </spine>"
    )
    cleaned = re.sub(
        r"<spine\b[^>]*>.*?</spine>",
        new_spine,
        cleaned,
        count=1,
        flags=re.DOTALL,
    )
    return cleaned


def _inject_hwpx_heading(section_xml: bytes, filename: str) -> bytes:
    """Insert a labelled paragraph at the top of a HWPX section so the
    user can see where each source begins. Best-effort — if the
    expected anchor isn't present (uncommon section variant), the
    section is returned unmodified."""
    text = section_xml.decode("utf-8", "replace")
    # OWPML paragraph elements are <hp:p ...>. Insert a heading-ish
    # paragraph right after the opening <hs:sec ...> tag.
    label = (
        f'<hp:p id="0" paraPrIDRef="0" styleIDRef="0" pageBreak="0" '
        f'columnBreak="0" merged="0">'
        f'<hp:run charPrIDRef="0">'
        f'<hp:t>📄 {_xml_escape(filename)}</hp:t>'
        f'</hp:run></hp:p>'
    )
    new_text, n = re.subn(
        r"(<hs:sec\b[^>]*>)",
        r"\1" + label,
        text,
        count=1,
    )
    if n == 0:
        return section_xml
    return new_text.encode("utf-8")


def _xml_escape(s: str) -> str:
    return (
        s.replace("&", "&amp;")
        .replace("<", "&lt;")
        .replace(">", "&gt;")
        .replace('"', "&quot;")
        .replace("'", "&apos;")
    )
