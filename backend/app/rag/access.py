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
    """The set of role codes a user effectively holds: their primary
    code (users.role) + every additional code from the user_roles
    join table + each of those rows' base_role (built-in tier).

    Both the specific code and the broad tier are matched against
    project_role_access so admins can grant either, and a user with
    "법무" + "재무" sees everything granted to either code or to the
    base tier they map to."""
    codes: set[str] = {user.role}
    # Additional roles assigned via the many-to-many table.
    extras = (
        await db.execute(
            select(models.UserRole.role_code).where(
                models.UserRole.user_id == user.id,
            )
        )
    ).scalars().all()
    codes.update(extras)

    # Expand every concrete code into its base_role tier so a grant
    # against "moderator" reaches everyone whose role inherits from it.
    rows = (
        await db.execute(
            select(models.Role.base_role).where(
                models.Role.code.in_(codes),
            )
        )
    ).scalars().all()
    codes.update(rows)
    # Any code with no row in the roles table is itself a built-in
    # tier (admin/moderator/user) — keep as-is so grants made to that
    # tier still match.
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


async def accessible_shared_prompt_ids(
    db: AsyncSession, user: models.User
) -> list[str]:
    """IDs of shared prompts this user's role can use. Same resolution
    logic as the project access list: matches `user.role` directly
    against the grant table and also against the user's base_role so
    a grant to 'moderator' covers any custom code with base_role=
    'moderator'."""
    codes = await _role_codes_for_user(db, user)
    if not codes:
        return []
    rows = (
        await db.execute(
            select(models.Prompt.id)
            .join(
                models.PromptRoleAccess,
                models.PromptRoleAccess.prompt_id == models.Prompt.id,
            )
            .where(
                models.Prompt.is_shared.is_(True),
                models.PromptRoleAccess.role_code.in_(codes),
            )
        )
    ).scalars().all()
    return list(dict.fromkeys(rows))


async def _user_in_team(
    db: AsyncSession, user_id: str, team_id: str | None
) -> bool:
    if not team_id:
        return False
    row = (
        await db.execute(
            select(models.TeamMember.user_id).where(
                models.TeamMember.team_id == team_id,
                models.TeamMember.user_id == user_id,
            )
        )
    ).first()
    return row is not None


async def user_team_ids(
    db: AsyncSession, user_id: str
) -> list[str]:
    """All team IDs the user is a member of. Used by list endpoints to
    include team-shared rows without per-row team lookups."""
    rows = (
        await db.execute(
            select(models.TeamMember.team_id).where(
                models.TeamMember.user_id == user_id
            )
        )
    ).scalars().all()
    return list(rows)


async def can_access_prompt(
    db: AsyncSession, user: models.User, prompt: models.Prompt
) -> bool:
    """Per-prompt authorization: owner OR (team member) OR (shared AND role mapped)."""
    if prompt.user_id == user.id:
        return True
    if prompt.team_id and await _user_in_team(db, user.id, prompt.team_id):
        return True
    if not prompt.is_shared:
        return False
    codes = await _role_codes_for_user(db, user)
    if not codes:
        return False
    grant = (
        await db.execute(
            select(models.PromptRoleAccess).where(
                models.PromptRoleAccess.prompt_id == prompt.id,
                models.PromptRoleAccess.role_code.in_(codes),
            )
        )
    ).first()
    return grant is not None


async def can_access_project(
    db: AsyncSession, user: models.User, project: models.Project
) -> bool:
    """Per-project authorization: owner OR (team member) OR (shared AND role mapped)."""
    if project.user_id == user.id:
        return True
    if project.team_id and await _user_in_team(db, user.id, project.team_id):
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
