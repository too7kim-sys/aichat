"""Prompt library CRUD — personal + shared (role-mapped) prompts.

Shape mirrors `routers/projects` closely:
  - GET /api/prompts          owned + accessible shared, with `owned`
                              flag so the UI can hide edit/delete
  - POST /api/prompts         create (shared requires admin)
  - GET /api/prompts/{id}     single (authorised)
  - PATCH /api/prompts/{id}   edit (owner or admin for shared)
  - DELETE /api/prompts/{id}  delete (owner or admin for shared)
  - PATCH /api/prompts/{id}/access  replace role grants (admin)
"""
from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, Request
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from .. import audit, models, schemas
from ..auth import get_current_user, require_admin
from ..database import get_db
from ..rag.access import (
    accessible_shared_prompt_ids,
    can_access_prompt,
    user_team_ids,
)

router = APIRouter(prefix="/api/prompts", tags=["prompts"])


async def _is_admin(db: AsyncSession, user: models.User) -> bool:
    if user.role == "admin":
        return True
    if user.role in {"moderator", "user"}:
        return False
    role = (
        await db.execute(
            select(models.Role).where(models.Role.code == user.role)
        )
    ).scalar_one_or_none()
    return role is not None and role.base_role == "admin"


async def _role_codes_for_prompt(db: AsyncSession, prompt_id: str) -> list[str]:
    rows = (
        await db.execute(
            select(models.PromptRoleAccess.role_code).where(
                models.PromptRoleAccess.prompt_id == prompt_id
            )
        )
    ).scalars().all()
    return list(rows)


async def _set_prompt_roles(
    db: AsyncSession, prompt_id: str, role_codes: list[str]
) -> None:
    valid = set(
        (
            await db.execute(
                select(models.Role.code).where(
                    models.Role.code.in_(role_codes)
                )
            )
        ).scalars().all()
    )
    existing = (
        await db.execute(
            select(models.PromptRoleAccess).where(
                models.PromptRoleAccess.prompt_id == prompt_id
            )
        )
    ).scalars().all()
    for row in existing:
        await db.delete(row)
    for code in valid:
        db.add(
            models.PromptRoleAccess(prompt_id=prompt_id, role_code=code)
        )


async def _serialize_prompt(
    db: AsyncSession, prompt: models.Prompt, user: models.User
) -> schemas.PromptOut:
    out = schemas.PromptOut.model_validate(prompt)
    out.owned = prompt.user_id == user.id
    if prompt.is_shared:
        out.role_codes = await _role_codes_for_prompt(db, prompt.id)
    return out


@router.get("", response_model=list[schemas.PromptOut])
async def list_prompts(
    db: AsyncSession = Depends(get_db),
    user: models.User = Depends(get_current_user),
):
    """Owned personal prompts + accessible shared prompts. Owned ones
    come back with owned=True; shared the user merely consumes get
    owned=False so the UI hides edit/delete."""
    owned = (
        await db.execute(
            select(models.Prompt)
            .where(models.Prompt.user_id == user.id)
            .order_by(models.Prompt.updated_at.desc())
        )
    ).scalars().all()

    shared_ids = await accessible_shared_prompt_ids(db, user)
    owned_ids = {p.id for p in owned}
    extra_ids = set(pid for pid in shared_ids if pid not in owned_ids)

    # Team-shared prompts the user can see by team membership (#95).
    team_ids = await user_team_ids(db, user.id)
    if team_ids:
        team_prompt_ids = (
            await db.execute(
                select(models.Prompt.id).where(
                    models.Prompt.team_id.in_(team_ids),
                    models.Prompt.user_id != user.id,
                )
            )
        ).scalars().all()
        extra_ids.update(team_prompt_ids)

    shared: list[models.Prompt] = []
    if extra_ids:
        shared = list(
            (
                await db.execute(
                    select(models.Prompt)
                    .where(models.Prompt.id.in_(extra_ids))
                    .order_by(models.Prompt.updated_at.desc())
                )
            ).scalars().all()
        )

    out: list[schemas.PromptOut] = []
    for p in [*owned, *shared]:
        out.append(await _serialize_prompt(db, p, user))
    return out


@router.post("", response_model=schemas.PromptOut, status_code=201)
async def create_prompt(
    payload: schemas.PromptCreate,
    request: Request,
    db: AsyncSession = Depends(get_db),
    user: models.User = Depends(get_current_user),
):
    code = payload.code.strip().lower()
    existing = (
        await db.execute(
            select(models.Prompt).where(models.Prompt.code == code)
        )
    ).scalar_one_or_none()
    if existing is not None:
        raise HTTPException(409, "이미 존재하는 프롬프트 코드입니다")
    if payload.is_shared and not await _is_admin(db, user):
        raise HTTPException(
            403, "공유 프롬프트는 관리자(admin)만 만들 수 있습니다",
        )
    prompt = models.Prompt(
        user_id=user.id,
        code=code,
        name=payload.name.strip(),
        description=(payload.description or "").strip() or None,
        body=payload.body,
        category=(payload.category or "").strip() or None,
        tags=(payload.tags or "").strip() or None,
        is_shared=payload.is_shared,
        team_id=payload.team_id or None,
    )
    db.add(prompt)
    await db.flush()
    if payload.is_shared and payload.role_codes:
        await _set_prompt_roles(db, prompt.id, payload.role_codes)
    await audit.record(
        db, request, "prompt_created", user_id=user.id,
        detail=f"code={code} shared={payload.is_shared}",
    )
    await db.commit()
    await db.refresh(prompt)
    return await _serialize_prompt(db, prompt, user)


async def _load_prompt(db: AsyncSession, prompt_id: str) -> models.Prompt:
    p = (
        await db.execute(
            select(models.Prompt).where(models.Prompt.id == prompt_id)
        )
    ).scalar_one_or_none()
    if p is None:
        raise HTTPException(404, "prompt not found")
    return p


@router.get("/{prompt_id}", response_model=schemas.PromptOut)
async def get_prompt(
    prompt_id: str,
    db: AsyncSession = Depends(get_db),
    user: models.User = Depends(get_current_user),
):
    p = await _load_prompt(db, prompt_id)
    if not await can_access_prompt(db, user, p):
        raise HTTPException(403, "권한이 없습니다")
    return await _serialize_prompt(db, p, user)


@router.patch("/{prompt_id}", response_model=schemas.PromptOut)
async def update_prompt(
    prompt_id: str,
    payload: schemas.PromptUpdate,
    request: Request,
    db: AsyncSession = Depends(get_db),
    user: models.User = Depends(get_current_user),
):
    p = await _load_prompt(db, prompt_id)
    is_owner = p.user_id == user.id
    is_admin = await _is_admin(db, user)
    if not is_owner and not is_admin:
        raise HTTPException(403, "권한이 없습니다")

    if payload.name is not None:
        p.name = payload.name.strip()
    if payload.description is not None:
        p.description = (payload.description or "").strip() or None
    if payload.body is not None:
        p.body = payload.body
    if payload.category is not None:
        p.category = (payload.category or "").strip() or None
    if payload.tags is not None:
        p.tags = (payload.tags or "").strip() or None
    if payload.is_shared is not None and payload.is_shared != p.is_shared:
        if not is_admin:
            raise HTTPException(
                403, "공유 토글은 관리자만 변경할 수 있습니다",
            )
        p.is_shared = payload.is_shared
    if payload.role_codes is not None:
        if not is_admin:
            raise HTTPException(
                403, "역할 매핑은 관리자만 변경할 수 있습니다",
            )
        await _set_prompt_roles(db, p.id, payload.role_codes)
    if payload.team_id is not None:
        p.team_id = payload.team_id or None
    await audit.record(
        db, request, "prompt_updated", user_id=user.id,
        detail=f"id={p.id}",
    )
    await db.commit()
    await db.refresh(p)
    return await _serialize_prompt(db, p, user)


@router.delete("/{prompt_id}", status_code=204)
async def delete_prompt(
    prompt_id: str,
    request: Request,
    db: AsyncSession = Depends(get_db),
    user: models.User = Depends(get_current_user),
):
    p = await _load_prompt(db, prompt_id)
    is_owner = p.user_id == user.id
    is_admin = await _is_admin(db, user)
    if not is_owner and not is_admin:
        raise HTTPException(403, "권한이 없습니다")
    await audit.record(
        db, request, "prompt_deleted", user_id=user.id,
        detail=f"id={p.id} code={p.code}",
    )
    await db.delete(p)
    await db.commit()


@router.patch("/{prompt_id}/access", response_model=schemas.PromptOut)
async def update_prompt_access(
    prompt_id: str,
    payload: schemas.ProjectAccessUpdate,  # shape is identical
    request: Request,
    db: AsyncSession = Depends(get_db),
    actor: models.User = Depends(require_admin),
):
    p = await _load_prompt(db, prompt_id)
    if not p.is_shared:
        p.is_shared = True
    await _set_prompt_roles(db, p.id, payload.role_codes)
    await audit.record(
        db, request, "prompt_access_changed", user_id=actor.id,
        detail=f"id={p.id} roles={','.join(payload.role_codes)}",
    )
    await db.commit()
    await db.refresh(p)
    return await _serialize_prompt(db, p, actor)
