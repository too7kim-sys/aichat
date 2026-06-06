"""Shared knowledge-base access resolution.

A user can use a RAG project in three ways:
  1. They own it (project.user_id == user.id) — personal projects.
  2. It's shared (is_shared=True) AND their role code is mapped in
     project_role_access.
  3. It's shared AND their role's base_role is mapped (so a custom
     'editor' role with base_role='moderator' inherits any project
     granted to 'moderator').

`accessible_shared_project_ids` returns the *shared* projects a user
can reach (used for chat auto-search). `can_access_project` answers
the single-project question for endpoint authorization.
"""
from __future__ import annotations

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from .. import models


async def _role_codes_for_user(db: AsyncSession, user: models.User) -> set[str]:
    """The set of role codes a user effectively holds: their own code
    plus their role's base_role (built-in tier). Both are matched
    against project_role_access so admins can grant either the
    specific custom code or the broad tier."""
    codes: set[str] = {user.role}
    role = (
        await db.execute(
            select(models.Role).where(models.Role.code == user.role)
        )
    ).scalar_one_or_none()
    if role is not None:
        codes.add(role.base_role)
    else:
        # user.role is itself a built-in tier (admin/moderator/user)
        # with no row — it still matches grants made to that tier.
        codes.add(user.role)
    return codes


async def accessible_shared_project_ids(
    db: AsyncSession, user: models.User, *, ready_only: bool = True
) -> list[str]:
    """IDs of shared projects this user's role can use. When
    `ready_only` is set (the default for chat), only projects whose
    current snapshot finished indexing are returned so a half-built
    index doesn't leak partial context."""
    codes = await _role_codes_for_user(db, user)
    if not codes:
        return []
    stmt = (
        select(models.Project.id)
        .join(
            models.ProjectRoleAccess,
            models.ProjectRoleAccess.project_id == models.Project.id,
        )
        .where(
            models.Project.is_shared.is_(True),
            models.ProjectRoleAccess.role_code.in_(codes),
        )
    )
    if ready_only:
        stmt = stmt.where(models.Project.status == "ready")
    rows = (await db.execute(stmt)).scalars().all()
    # Dedup — a project can match on both code and base_role.
    return list(dict.fromkeys(rows))


async def can_access_project(
    db: AsyncSession, user: models.User, project: models.Project
) -> bool:
    """Per-project authorization: owner OR (shared AND role mapped)."""
    if project.user_id == user.id:
        return True
    if not project.is_shared:
        return False
    codes = await _role_codes_for_user(db, user)
    if not codes:
        return False
    grant = (
        await db.execute(
            select(models.ProjectRoleAccess).where(
                models.ProjectRoleAccess.project_id == project.id,
                models.ProjectRoleAccess.role_code.in_(codes),
            )
        )
    ).first()
    return grant is not None
