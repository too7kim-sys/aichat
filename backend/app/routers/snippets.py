"""코드 스니펫 라이브러리 (#71).

사용자 또는 관리자가 자주 쓰는 코드 패턴을 저장 → 워크스페이스 트리
옆 picker 에서 검색·삽입.  scope=personal 은 본인만, scope=team 은
모두 (관리자만 편집).
"""
from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy import or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from .. import models
from ..auth import get_current_user
from ..database import get_db


router = APIRouter(prefix="/api/snippets", tags=["snippets"])


class SnippetIn(BaseModel):
    name: str = Field(min_length=1, max_length=80)
    body: str = Field(min_length=1, max_length=40_000)
    language: str = Field(default="", max_length=40)
    description: str = Field(default="", max_length=200)
    scope: str = Field(default="personal")  # personal | team


class SnippetOut(BaseModel):
    id: str
    scope: str
    name: str
    body: str
    language: str
    description: str
    owned: bool = False


def _is_admin(user: models.User) -> bool:
    return user.role in ("admin", "moderator")


@router.get("", response_model=list[SnippetOut])
async def list_snippets(
    db: AsyncSession = Depends(get_db),
    user: models.User = Depends(get_current_user),
):
    """본인 personal + 모든 team 스니펫."""
    rows = (
        await db.execute(
            select(models.CodeSnippet).where(
                or_(
                    models.CodeSnippet.scope == "team",
                    models.CodeSnippet.user_id == user.id,
                )
            ).order_by(models.CodeSnippet.scope.desc(), models.CodeSnippet.name.asc())
        )
    ).scalars().all()
    out: list[SnippetOut] = []
    for r in rows:
        out.append(
            SnippetOut(
                id=r.id,
                scope=r.scope,
                name=r.name,
                body=r.body,
                language=r.language,
                description=r.description,
                owned=(r.user_id == user.id),
            )
        )
    return out


@router.post("", response_model=SnippetOut)
async def create_snippet(
    payload: SnippetIn,
    db: AsyncSession = Depends(get_db),
    user: models.User = Depends(get_current_user),
):
    scope = payload.scope.strip()
    if scope not in ("personal", "team"):
        raise HTTPException(400, "scope 는 personal / team 중 하나")
    if scope == "team" and not _is_admin(user):
        raise HTTPException(403, "팀 스니펫은 관리자만 만들 수 있어요")
    row = models.CodeSnippet(
        user_id=None if scope == "team" else user.id,
        scope=scope,
        name=payload.name.strip(),
        body=payload.body,
        language=payload.language.strip(),
        description=payload.description.strip(),
    )
    db.add(row)
    await db.commit()
    await db.refresh(row)
    return SnippetOut(
        id=row.id,
        scope=row.scope,
        name=row.name,
        body=row.body,
        language=row.language,
        description=row.description,
        owned=(row.user_id == user.id),
    )


@router.delete("/{snippet_id}", status_code=204)
async def delete_snippet(
    snippet_id: str,
    db: AsyncSession = Depends(get_db),
    user: models.User = Depends(get_current_user),
):
    row = await db.scalar(
        select(models.CodeSnippet).where(models.CodeSnippet.id == snippet_id)
    )
    if not row:
        raise HTTPException(404, "스니펫을 찾을 수 없어요")
    if row.scope == "team":
        if not _is_admin(user):
            raise HTTPException(403, "팀 스니펫은 관리자만 삭제할 수 있어요")
    elif row.user_id != user.id:
        raise HTTPException(403, "본인 스니펫이 아니에요")
    await db.delete(row)
    await db.commit()
