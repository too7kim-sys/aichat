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
    # Editing a message un-hides it — the user actively touched it,
    # they expect to see the result in the bubble row immediately.
    msg.hidden = False
    await db.commit()
    await db.refresh(msg)
    return msg


@router.delete("/{session_id}", status_code=204)
async def delete_session(
    session_id: str,
    db: AsyncSession = Depends(get_db),
    user: models.User = Depends(get_current_user),
):
    session = await _load_owned(db, session_id, user.id)
    await db.delete(session)
    await db.commit()
