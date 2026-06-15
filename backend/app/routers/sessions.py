import logging
from datetime import datetime, timedelta

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel, Field
from sqlalchemy import select, update
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from .. import models, schemas
from ..auth import get_current_user
from ..database import get_db

log = logging.getLogger("uvicorn.error")

router = APIRouter(prefix="/api/sessions", tags=["sessions"])


@router.get("", response_model=list[schemas.SessionOut])
async def list_sessions(
    deleted: bool = False,
    db: AsyncSession = Depends(get_db),
    user: models.User = Depends(get_current_user),
):
    """기본 = 정상 세션만.  deleted=true 면 휴지통 (deleted_at IS NOT NULL).
    핀 고정된 세션이 먼저, 그 다음 updated_at desc.
    """
    q = select(models.Session).where(models.Session.user_id == user.id)
    if deleted:
        q = q.where(models.Session.deleted_at.is_not(None))
        q = q.order_by(models.Session.deleted_at.desc())
    else:
        q = q.where(models.Session.deleted_at.is_(None))
        q = q.order_by(
            models.Session.pinned.desc(),
            models.Session.updated_at.desc(),
        )
    result = await db.execute(q)
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
    request: Request,
    db: AsyncSession = Depends(get_db),
    user: models.User = Depends(get_current_user),
):
    session = await _load_owned(db, session_id, user.id)
    # 잠긴 세션은 X-Session-Passphrase 헤더가 일치해야 본문 노출 (#52).
    # 헤더가 없으면 403 — UI 는 '잠금' 상태로 비번 입력칸을 띄움.
    if session.passphrase_hash:
        sent = request.headers.get("x-session-passphrase") or ""
        import hashlib as _hh
        if _hh.sha256(sent.encode("utf-8")).hexdigest() != session.passphrase_hash:
            raise HTTPException(403, "이 세션은 잠겨 있어요")
    return session


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
    if payload.tags is not None:
        # 빈 리스트 = 태그 모두 제거.  최대 8개, 각 24자.
        import json as _json

        cleaned = [
            t.strip()[:24] for t in payload.tags if isinstance(t, str) and t.strip()
        ][:8]
        msg.tags = _json.dumps(cleaned, ensure_ascii=False) if cleaned else None
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


@router.post("/{session_id}/messages/{message_id}/branch", response_model=schemas.SessionOut)
async def branch_from_message(
    session_id: str,
    message_id: str,
    db: AsyncSession = Depends(get_db),
    user: models.User = Depends(get_current_user),
):
    """주어진 메시지 시점에서 새 세션으로 분기. 그 메시지(포함) 까지의
    히스토리를 새 Session 으로 복사 + 같은 폴더(project)·워크스페이스
    링크 그대로 유지. 분기점 이후는 안 따라간다. UI 가 새 세션으로
    이동시키는 흐름은 onSwitchSession 콜백."""
    session = await _load_owned(db, session_id, user.id)
    target = next((m for m in session.messages if m.id == message_id), None)
    if target is None:
        raise HTTPException(404, "message not found")
    pivot = target.created_at

    new_session = models.Session(
        user_id=user.id,
        title=f"↩ {session.title}",
        project_id=session.project_id,
        chat_project_id=session.chat_project_id,
        workspace_id=session.workspace_id,
        code_focused=session.code_focused,
    )
    db.add(new_session)
    await db.flush()

    copied = 0
    for m in sorted(session.messages, key=lambda x: x.created_at):
        if m.created_at > pivot:
            break
        db.add(models.Message(
            session_id=new_session.id,
            role=m.role,
            provider=m.provider,
            content=m.content,
            attachments_summary=m.attachments_summary,
            hidden=m.hidden,
        ))
        copied += 1
    await db.commit()
    await db.refresh(new_session)
    log.info(
        "session branch: %s → %s (copied %d msgs at %s)",
        session_id, new_session.id, copied, pivot,
    )
    return new_session


@router.post("/{session_id}/messages/{message_id}/rewind", status_code=204)
async def rewind_after_message(
    session_id: str,
    message_id: str,
    db: AsyncSession = Depends(get_db),
    user: models.User = Depends(get_current_user),
):
    """주어진 메시지 이후 모든 메시지 삭제 — "수정 후 다시 보내기"
    플로우에서 사용. 프런트는 이 호출 직후 streamChat 으로 재생성
    트리거. 대상 message_id 자체는 보존."""
    session = await _load_owned(db, session_id, user.id)
    target = next((m for m in session.messages if m.id == message_id), None)
    if target is None:
        raise HTTPException(404, "message not found")
    pivot = target.created_at
    for m in list(session.messages):
        if m.created_at > pivot:
            await db.delete(m)
    await db.commit()
    return None


@router.delete("/{session_id}", status_code=204)
async def delete_session(
    session_id: str,
    permanent: bool = False,
    db: AsyncSession = Depends(get_db),
    user: models.User = Depends(get_current_user),
):
    """기본 = 휴지통으로 이동 (deleted_at = now()).  30 일 뒤 백엔드
    부팅 시 자동 영구 삭제.  permanent=true 면 즉시 hard delete.
    """
    session = await _load_owned(db, session_id, user.id)
    if permanent or session.deleted_at is not None:
        await db.delete(session)
    else:
        session.deleted_at = datetime.utcnow()
    await db.commit()


@router.post("/{session_id}/restore", response_model=schemas.SessionOut)
async def restore_session(
    session_id: str,
    db: AsyncSession = Depends(get_db),
    user: models.User = Depends(get_current_user),
):
    """휴지통에서 복원."""
    session = await _load_owned(db, session_id, user.id)
    if session.deleted_at is None:
        return session  # 이미 정상
    session.deleted_at = None
    await db.commit()
    await db.refresh(session)
    return session


class PinPayload(BaseModel):
    pinned: bool


@router.patch("/{session_id}/pin", response_model=schemas.SessionOut)
async def pin_session(
    session_id: str,
    payload: PinPayload,
    db: AsyncSession = Depends(get_db),
    user: models.User = Depends(get_current_user),
):
    """사이드바 상단 고정 토글."""
    session = await _load_owned(db, session_id, user.id)
    session.pinned = bool(payload.pinned)
    await db.commit()
    await db.refresh(session)
    return session


class BulkPayload(BaseModel):
    session_ids: list[str]
    action: str  # "delete" | "restore" | "permanent-delete" | "pin" | "unpin"


@router.post("/bulk", status_code=204)
async def bulk_action(
    payload: BulkPayload,
    db: AsyncSession = Depends(get_db),
    user: models.User = Depends(get_current_user),
):
    """여러 세션에 동일 작업 적용 (#30).  대량 삭제·복원·핀 토글."""
    if not payload.session_ids:
        return
    if payload.action not in {
        "delete",
        "restore",
        "permanent-delete",
        "pin",
        "unpin",
    }:
        raise HTTPException(400, f"unknown action: {payload.action}")
    # 본인 소유만 영향 — IN 절 + user_id 조건.
    rows = (
        await db.execute(
            select(models.Session).where(
                models.Session.id.in_(payload.session_ids),
                models.Session.user_id == user.id,
            )
        )
    ).scalars().all()
    now = datetime.utcnow()
    for s in rows:
        if payload.action == "delete":
            if s.deleted_at is None:
                s.deleted_at = now
        elif payload.action == "restore":
            s.deleted_at = None
        elif payload.action == "permanent-delete":
            await db.delete(s)
        elif payload.action == "pin":
            s.pinned = True
        elif payload.action == "unpin":
            s.pinned = False
    await db.commit()


# ── 세션 공유 링크 (#38) ─────────────────────────────────────
import secrets as _secrets


class ShareCreatePayload(BaseModel):
    expires_days: int | None = None  # None = 무기한


class ShareOut(BaseModel):
    id: str
    token: str
    url: str
    expires_at: datetime | None
    created_at: datetime


@router.post("/{session_id}/share", response_model=ShareOut)
async def create_share(
    session_id: str,
    payload: ShareCreatePayload | None = None,
    db: AsyncSession = Depends(get_db),
    user: models.User = Depends(get_current_user),
):
    """공유 토큰 생성.  세션 소유자만 호출 가능.  expires_days 지정 시
    그 시점부터 만료, 미지정이면 무기한 (사용자가 직접 revoke 가능).
    """
    session = await _load_owned(db, session_id, user.id)
    days = (payload.expires_days if payload else None) or 0
    expires_at = (
        datetime.utcnow() + timedelta(days=days) if days > 0 else None
    )
    row = models.SessionShare(
        session_id=session.id,
        token=_secrets.token_urlsafe(24),
        created_by_id=user.id,
        expires_at=expires_at,
    )
    db.add(row)
    await db.commit()
    await db.refresh(row)
    return ShareOut(
        id=row.id,
        token=row.token,
        url=f"/share/{row.token}",
        expires_at=row.expires_at,
        created_at=row.created_at,
    )


@router.delete("/{session_id}/share/{share_id}", status_code=204)
async def revoke_share(
    session_id: str,
    share_id: str,
    db: AsyncSession = Depends(get_db),
    user: models.User = Depends(get_current_user),
):
    """공유 링크 회수.  세션 소유자만."""
    session = await _load_owned(db, session_id, user.id)
    row = await db.scalar(
        select(models.SessionShare).where(
            models.SessionShare.id == share_id,
            models.SessionShare.session_id == session.id,
        )
    )
    if not row:
        raise HTTPException(404, "공유 링크를 찾을 수 없어요")
    await db.delete(row)
    await db.commit()


@router.get("/_share/{token}", response_model=schemas.SessionDetail)
async def get_shared(
    token: str,
    db: AsyncSession = Depends(get_db),
    user: models.User = Depends(get_current_user),
):
    """토큰으로 공유된 세션을 읽기 전용으로 불러옴.  로그인은 여전히
    필요 — 폐쇄망 원칙상 anon 접근은 비활성.  만료된 토큰은 404.
    """
    share = await db.scalar(
        select(models.SessionShare).where(models.SessionShare.token == token)
    )
    if not share:
        raise HTTPException(404, "공유 링크를 찾을 수 없어요")
    if share.expires_at and share.expires_at < datetime.utcnow():
        raise HTTPException(410, "공유 링크가 만료됐어요")
    sess = await db.scalar(
        select(models.Session)
        .where(models.Session.id == share.session_id)
        .options(selectinload(models.Session.messages))
    )
    if not sess:
        raise HTTPException(404, "원본 세션을 찾을 수 없어요")
    return sess


# ── 세션 비밀번호 잠금 (#52) ────────────────────────────────
import hashlib as _hashlib


def _hash_passphrase(p: str) -> str:
    return _hashlib.sha256(p.encode("utf-8")).hexdigest()


class LockPayload(BaseModel):
    passphrase: str | None = None  # None / "" = 해제


@router.patch("/{session_id}/lock", response_model=schemas.SessionOut)
async def lock_session(
    session_id: str,
    payload: LockPayload,
    db: AsyncSession = Depends(get_db),
    user: models.User = Depends(get_current_user),
):
    """세션에 비밀번호 잠금 설정/해제.  잠그면 이후 GET 호출이
    X-Session-Passphrase 헤더 없이는 403 으로 거부."""
    session = await _load_owned(db, session_id, user.id)
    p = (payload.passphrase or "").strip()
    session.passphrase_hash = _hash_passphrase(p) if p else None
    await db.commit()
    await db.refresh(session)
    return session


class UnlockPayload(BaseModel):
    passphrase: str


@router.post("/{session_id}/unlock", response_model=schemas.SessionDetail)
async def unlock_session(
    session_id: str,
    payload: UnlockPayload,
    db: AsyncSession = Depends(get_db),
    user: models.User = Depends(get_current_user),
):
    """비밀번호 확인 후 세션 본문을 반환.  잠긴 세션을 GET 으로 직접
    못 받게 한 뒤, 별도 POST 로 비번을 검사하면 응답 본문에 메시지
    까지 함께 노출."""
    session = await _load_owned(db, session_id, user.id)
    if not session.passphrase_hash:
        return session  # 이미 해제됨
    if session.passphrase_hash != _hash_passphrase(payload.passphrase):
        raise HTTPException(403, "비밀번호가 일치하지 않아요")
    return session


# ── 자동 제목 (#50) ──────────────────────────────────────────
class AutoTitlePayload(BaseModel):
    force: bool = False  # 기본은 'New chat' 같은 기본 제목일 때만 갱신


@router.post("/{session_id}/auto-title", response_model=schemas.SessionOut)
async def auto_title(
    session_id: str,
    payload: AutoTitlePayload | None = None,
    db: AsyncSession = Depends(get_db),
    user: models.User = Depends(get_current_user),
):
    """첫 사용자 메시지를 기반으로 짧은 제목을 AI 가 추천 → Session.title
    에 반영.  force=False (기본) 이면 'New chat' / 'Untitled' 같이 기본
    제목일 때만 덮어쓰기.  메시지가 없으면 그대로.
    """
    import httpx
    from ..config import settings as _settings

    session = await _load_owned(db, session_id, user.id)
    p = payload or AutoTitlePayload()
    default_titles = {"New chat", "Untitled", "새 대화", "(제목 없음)"}
    if not p.force and session.title not in default_titles:
        return session
    first_user = next(
        (m for m in session.messages if m.role == "user"), None
    )
    if first_user is None or not (first_user.content or "").strip():
        return session
    body = first_user.content.strip()[:1200]
    sys_prompt = (
        "다음 사용자 메시지를 가장 잘 요약하는 짧고 명확한 한국어 제목을 "
        "한 줄로 만들어 주세요.  10~30자 이내, 부호·따옴표 없이, 명사구 "
        "위주.  반드시 본문 외의 설명이나 머리말을 붙이지 마세요."
    )
    timeout = httpx.Timeout(30.0, connect=5.0)
    try:
        async with httpx.AsyncClient(timeout=timeout) as client:
            r = await client.post(
                f"{_settings.ollama_base_url.rstrip('/')}/api/chat",
                json={
                    "model": _settings.ollama_model,
                    "stream": False,
                    "messages": [
                        {"role": "system", "content": sys_prompt},
                        {"role": "user", "content": body},
                    ],
                },
            )
        if r.status_code < 400:
            text = ((r.json() or {}).get("message") or {}).get("content") or ""
            new_title = text.strip().split("\n")[0].strip().strip('"').strip("'")
            if 1 <= len(new_title) <= 60:
                session.title = new_title
                await db.commit()
                await db.refresh(session)
    except Exception as exc:  # noqa: BLE001
        log.warning("auto-title failed: %s", exc)
    return session


# ── 모델 비교 (#47) ───────────────────────────────────────────
class CompareInput(BaseModel):
    prompt: str = Field(min_length=1, max_length=20_000)
    models: list[str] = Field(min_length=1, max_length=4)


@router.post("/{session_id}/compare")
async def compare_models(
    session_id: str,
    payload: CompareInput,
    db: AsyncSession = Depends(get_db),
    user: models.User = Depends(get_current_user),
):
    """같은 prompt 를 여러 Ollama 모델에 병렬로 보내, 결과를 모두 반환.
    세션에는 저장하지 *않음* — 사용자가 비교한 뒤 마음에 드는 모델을
    골라 일반 채팅으로 보내는 흐름.  최대 4개 모델."""
    import asyncio
    import httpx
    from ..config import settings as _settings

    await _load_owned(db, session_id, user.id)
    models_list = [m.strip() for m in payload.models if m and m.strip()][:4]
    if not models_list:
        raise HTTPException(400, "모델을 1~4개 지정해 주세요")

    async def _one(model: str) -> dict:
        timeout = httpx.Timeout(120.0, connect=5.0)
        try:
            async with httpx.AsyncClient(timeout=timeout) as client:
                t0 = datetime.utcnow()
                r = await client.post(
                    f"{_settings.ollama_base_url.rstrip('/')}/api/chat",
                    json={
                        "model": model,
                        "stream": False,
                        "messages": [
                            {"role": "user", "content": payload.prompt},
                        ],
                    },
                )
            ms = int((datetime.utcnow() - t0).total_seconds() * 1000)
            if r.status_code >= 400:
                return {"model": model, "error": f"HTTP {r.status_code}", "latency_ms": ms}
            data = r.json() or {}
            text = (data.get("message") or {}).get("content") or ""
            return {"model": model, "content": text, "latency_ms": ms}
        except Exception as exc:  # noqa: BLE001
            return {"model": model, "error": f"{type(exc).__name__}: {exc}"}

    results = await asyncio.gather(*(_one(m) for m in models_list))
    return {"prompt": payload.prompt, "results": results}


# ── 메시지 번역 (#40) ────────────────────────────────────────
class TranslatePayload(BaseModel):
    target: str = "ko"  # ko | en | ja | zh ...


@router.post("/{session_id}/messages/{message_id}/translate")
async def translate_message(
    session_id: str,
    message_id: str,
    payload: TranslatePayload,
    db: AsyncSession = Depends(get_db),
    user: models.User = Depends(get_current_user),
):
    """메시지 본문을 다른 언어로 번역.  세션 저장은 안 함 — 결과 텍스트
    만 응답.  Ollama 의 일반 chat 엔드포인트를 1회 호출 (stream=false).
    """
    import httpx
    from ..config import settings as _settings

    session = await _load_owned(db, session_id, user.id)
    msg = next((m for m in session.messages if m.id == message_id), None)
    if msg is None:
        raise HTTPException(404, "message not found")
    body = (msg.content or "").strip()
    if not body:
        return {"text": "", "target": payload.target}

    target_label = {
        "ko": "한국어",
        "en": "English",
        "ja": "일본어",
        "zh": "중국어 간체",
    }.get(payload.target, payload.target)

    sys_prompt = (
        f"You are a professional translator.  Translate the following text "
        f"into {target_label}.  Preserve formatting (markdown, code fences, "
        f"line breaks).  Do not add any commentary or preamble — output the "
        f"translated text only.  If a sentence is already in the target "
        f"language, leave it as-is."
    )

    timeout = httpx.Timeout(60.0, connect=5.0)
    try:
        async with httpx.AsyncClient(timeout=timeout) as client:
            r = await client.post(
                f"{_settings.ollama_base_url.rstrip('/')}/api/chat",
                json={
                    "model": _settings.ollama_model,
                    "stream": False,
                    "messages": [
                        {"role": "system", "content": sys_prompt},
                        {"role": "user", "content": body},
                    ],
                },
            )
        if r.status_code >= 400:
            raise HTTPException(502, f"Ollama {r.status_code}: {r.text[:200]}")
        data = r.json()
        text = (data.get("message") or {}).get("content") or ""
    except HTTPException:
        raise
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(502, f"번역 실패: {exc}") from exc

    return {"text": text.strip(), "target": payload.target}


async def purge_expired_trash(retention_days: int = 30) -> int:
    """30 일 지난 휴지통 행 영구 삭제.  lifespan 부팅 시 1 회 호출."""
    from sqlalchemy import delete as _del

    cutoff = datetime.utcnow() - timedelta(days=max(1, retention_days))
    from ..database import SessionLocal

    async with SessionLocal() as db:
        result = await db.execute(
            _del(models.Session).where(
                models.Session.deleted_at.is_not(None),
                models.Session.deleted_at < cutoff,
            )
        )
        await db.commit()
        return result.rowcount or 0
