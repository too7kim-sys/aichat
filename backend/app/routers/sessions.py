from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from .. import models, schemas
from ..auth import get_current_user
from ..database import get_db

router = APIRouter(prefix="/api/sessions", tags=["sessions"])


@router.get("", response_model=list[schemas.SessionOut])
async def list_sessions(
    db: AsyncSession = Depends(get_db),
    user: models.User = Depends(get_current_user),
):
    result = await db.execute(
        select(models.Session)
        .where(models.Session.user_id == user.id)
        .order_by(models.Session.updated_at.desc())
    )
    return result.scalars().all()


@router.post("", response_model=schemas.SessionOut)
async def create_session(
    payload: schemas.SessionCreate,
    db: AsyncSession = Depends(get_db),
    user: models.User = Depends(get_current_user),
):
    # Validate the chat-project link, if any — silently dropping a
    # bad id would scatter sessions outside the folder the user just
    # picked from the sidebar.
    if payload.chat_project_id is not None:
        owned = await db.scalar(
            select(models.ChatProject.id).where(
                models.ChatProject.id == payload.chat_project_id,
                models.ChatProject.user_id == user.id,
            )
        )
        if not owned:
            raise HTTPException(404, "chat project not found")
    session = models.Session(
        title=payload.title,
        user_id=user.id,
        chat_project_id=payload.chat_project_id,
    )
    db.add(session)
    await db.commit()
    await db.refresh(session)
    return session


async def _load_owned(db: AsyncSession, session_id: str, user_id: str) -> models.Session:
    result = await db.execute(
        select(models.Session)
        .where(models.Session.id == session_id, models.Session.user_id == user_id)
        .options(selectinload(models.Session.messages))
    )
    session = result.scalar_one_or_none()
    if not session:
        raise HTTPException(404, "session not found")
    return session


@router.get("/{session_id}", response_model=schemas.SessionDetail)
async def get_session(
    session_id: str,
    db: AsyncSession = Depends(get_db),
    user: models.User = Depends(get_current_user),
):
    return await _load_owned(db, session_id, user.id)


@router.patch("/{session_id}", response_model=schemas.SessionOut)
async def update_session(
    session_id: str,
    payload: schemas.SessionUpdate,
    db: AsyncSession = Depends(get_db),
    user: models.User = Depends(get_current_user),
):
    session = await _load_owned(db, session_id, user.id)
    session.title = payload.title.strip()
    await db.commit()
    await db.refresh(session)
    return session


@router.patch("/{session_id}/chat-project", response_model=schemas.SessionOut)
async def move_session_to_chat_project(
    session_id: str,
    payload: schemas.SessionMove,
    db: AsyncSession = Depends(get_db),
    user: models.User = Depends(get_current_user),
):
    """Move a session into a chat project (folder) or detach it
    (pass `chat_project_id: null`). The frontend uses this from the
    session row's "프로젝트로 이동" menu."""
    session = await _load_owned(db, session_id, user.id)
    if payload.chat_project_id is not None:
        owned = await db.scalar(
            select(models.ChatProject.id).where(
                models.ChatProject.id == payload.chat_project_id,
                models.ChatProject.user_id == user.id,
            )
        )
        if not owned:
            raise HTTPException(404, "chat project not found")
    session.chat_project_id = payload.chat_project_id
    await db.commit()
    await db.refresh(session)
    return session


@router.patch(
    "/{session_id}/messages/{message_id}",
    response_model=schemas.MessageOut,
)
async def update_message(
    session_id: str,
    message_id: str,
    payload: schemas.MessageUpdate,
    db: AsyncSession = Depends(get_db),
    user: models.User = Depends(get_current_user),
):
    """Edit a single message's content in place. Chat panel uses
    this from the pencil action on assistant bubbles + the
    transcript export flow uses it to fix a mis-transcription
    before downloading the 회의록."""
    session = await _load_owned(db, session_id, user.id)
    msg = next((m for m in session.messages if m.id == message_id), None)
    if msg is None:
        raise HTTPException(404, "message not found")
    msg.content = payload.content
    # Don't un-hide on edit — the hidden flag also marks transcript-
    # derived ("meeting") sessions for Cowork's orphan-row backfill,
    # so flipping it on a routine fix to the raw transcript would
    # make the meeting disappear from Cowork after the audio is
    # deleted. The bubble's own collapsed state opens optimistically
    # on save, which is what the user actually wants visually.
    await db.commit()
    await db.refresh(msg)
    return msg


@router.patch(
    "/{session_id}/messages/{message_id}/meta",
    response_model=schemas.MessageOut,
)
async def update_message_meta(
    session_id: str,
    message_id: str,
    payload: schemas.MessageMetaUpdate,
    db: AsyncSession = Depends(get_db),
    user: models.User = Depends(get_current_user),
):
    """별표(starred) + 답변 평가(feedback) 토글. 본문 수정과 분리해서
    독립 엔드포인트로 둬 — 별표 한 번 누르는 데 content 전체 페이로드
    를 보낼 필요가 없게."""
    session = await _load_owned(db, session_id, user.id)
    msg = next((m for m in session.messages if m.id == message_id), None)
    if msg is None:
        raise HTTPException(404, "message not found")
    if payload.starred is not None:
        msg.starred = bool(payload.starred)
    if payload.feedback is not None:
        msg.feedback = int(payload.feedback)
        # 평가가 0 으로 돌아가면 메모도 자동 정리.
        if msg.feedback == 0:
            msg.feedback_note = None
    if payload.feedback_note is not None:
        note = payload.feedback_note.strip()
        msg.feedback_note = note or None
    await db.commit()
    await db.refresh(msg)
    return msg


@router.get(
    "/_starred",
    response_model=list[schemas.MessageOut],
)
async def list_starred_messages(
    db: AsyncSession = Depends(get_db),
    user: models.User = Depends(get_current_user),
    limit: int = 100,
):
    """사용자가 별표한 메시지 모음 (최신순). 사이드바의 "별표한 답변"
    탭이 사용. 다른 세션의 메시지를 한 화면에 모으는 게 핵심."""
    from sqlalchemy.orm import aliased
    SessAlias = aliased(models.Session)
    rows = (
        await db.execute(
            select(models.Message)
            .join(SessAlias, models.Message.session_id == SessAlias.id)
            .where(
                SessAlias.user_id == user.id,
                models.Message.starred.is_(True),
            )
            .order_by(models.Message.created_at.desc())
            .limit(max(1, min(int(limit or 100), 500)))
        )
    ).scalars().all()
    return rows


@router.get("/{session_id}/export.docx")
async def export_session_docx(
    session_id: str,
    include: str = "all",
    mask_pii: bool = False,
    db: AsyncSession = Depends(get_db),
    user: models.User = Depends(get_current_user),
):
    """현재 세션을 DOCX 로 내보내기. include:
      · all (기본)  — 모든 메시지 (숨김 제외)
      · summary    — 어시스턴트 답변만
      · starred    — 사용자가 별표한 메시지만
    """
    import io
    import urllib.parse
    try:
        from docx import Document
        from docx.shared import Pt
        from docx.enum.text import WD_ALIGN_PARAGRAPH
    except ImportError as exc:
        raise HTTPException(
            500, "python-docx 가 설치돼 있지 않습니다."
        ) from exc

    sess = await _load_owned(db, session_id, user.id)
    msgs = [m for m in sess.messages if not m.hidden]
    if include == "summary":
        msgs = [m for m in msgs if m.role == "assistant"]
    elif include == "starred":
        msgs = [m for m in msgs if m.starred]

    doc = Document()
    title = doc.add_heading(sess.title or "대화 내보내기", level=0)
    title.alignment = WD_ALIGN_PARAGRAPH.CENTER
    meta = doc.add_paragraph()
    meta.alignment = WD_ALIGN_PARAGRAPH.CENTER
    bits = [
        f"작성 일시: {sess.updated_at.strftime('%Y-%m-%d %H:%M')}",
        f"메시지 수: {len(msgs)}",
    ]
    if include != "all":
        bits.append(
            "범위: " + ("어시스턴트 답변만" if include == "summary" else "별표한 메시지만")
        )
    mr = meta.add_run("  ·  ".join(bits))
    mr.italic = True
    mr.font.size = Pt(10)
    doc.add_paragraph()  # spacer

    from .. import pii_mask
    def _maybe_mask(s: str | None) -> str:
        return pii_mask.mask(s or "") if mask_pii else (s or "")

    for m in msgs:
        role_label = "🧑 사용자" if m.role == "user" else "🤖 답변"
        head = doc.add_paragraph()
        hr = head.add_run(role_label)
        hr.bold = True
        hr.font.size = Pt(11)
        if m.feedback == 1:
            head.add_run("   👍")
        elif m.feedback == -1:
            head.add_run("   👎")
        if m.starred:
            head.add_run("   ★")
        body = doc.add_paragraph(_maybe_mask(m.content))
        body.paragraph_format.space_after = Pt(8)
        if m.feedback_note:
            note = doc.add_paragraph()
            nr = note.add_run("  메모: " + _maybe_mask(m.feedback_note))
            nr.italic = True
            nr.font.size = Pt(9)
        doc.add_paragraph()  # spacer

    buf = io.BytesIO()
    doc.save(buf)
    buf.seek(0)

    safe = urllib.parse.quote((sess.title or "session").replace("/", "_"))
    headers = {
        "Content-Disposition": f"attachment; filename*=UTF-8''{safe}.docx"
    }
    from fastapi.responses import Response
    return Response(
        content=buf.read(),
        media_type=(
            "application/vnd.openxmlformats-officedocument."
            "wordprocessingml.document"
        ),
        headers=headers,
    )


@router.get("/{session_id}/export.hwpx")
async def export_session_hwpx(
    session_id: str,
    include: str = "all",
    mask_pii: bool = False,
    db: AsyncSession = Depends(get_db),
    user: models.User = Depends(get_current_user),
):
    """세션을 HWPX (한컴 오픈 XML) 로 내보내기. include = all | summary
    | starred. mask_pii=true 면 PII 자동 마스킹."""
    import urllib.parse
    from fastapi.responses import Response
    from .. import hwpx_export, pii_mask

    sess = await _load_owned(db, session_id, user.id)
    msgs = [m for m in sess.messages if not m.hidden]
    if include == "summary":
        msgs = [m for m in msgs if m.role == "assistant"]
    elif include == "starred":
        msgs = [m for m in msgs if m.starred]

    def _maybe_mask(s: str | None) -> str:
        return pii_mask.mask(s or "") if mask_pii else (s or "")

    paragraphs: list[str] = []
    paragraphs.append(sess.title or "대화 내보내기")
    paragraphs.append("")
    paragraphs.append(
        f"작성 일시: {sess.updated_at.strftime('%Y-%m-%d %H:%M')}"
        f"   ·   메시지 {len(msgs)}건"
    )
    paragraphs.append("")

    for m in msgs:
        role_label = "[사용자]" if m.role == "user" else "[답변]"
        marks = []
        if m.feedback == 1:
            marks.append("👍")
        elif m.feedback == -1:
            marks.append("👎")
        if m.starred:
            marks.append("★")
        head = role_label + ("   " + " ".join(marks) if marks else "")
        paragraphs.append(head)
        paragraphs.append(_maybe_mask(m.content))
        if m.feedback_note:
            paragraphs.append("  메모: " + _maybe_mask(m.feedback_note))
        paragraphs.append("")

    data = hwpx_export.build_hwpx(sess.title or "대화", paragraphs)
    safe = urllib.parse.quote((sess.title or "session").replace("/", "_"))
    return Response(
        content=data,
        media_type="application/hwp+zip",
        headers={
            "Content-Disposition": f"attachment; filename*=UTF-8''{safe}.hwpx"
        },
    )


@router.delete("/{session_id}", status_code=204)
async def delete_session(
    session_id: str,
    db: AsyncSession = Depends(get_db),
    user: models.User = Depends(get_current_user),
):
    session = await _load_owned(db, session_id, user.id)
    await db.delete(session)
    await db.commit()
