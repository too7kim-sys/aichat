"""cowork 패키지 안에서 여러 라우터가 공유하는 작은 헬퍼."""
from __future__ import annotations

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from ... import models


def _is_admin(user: models.User) -> bool:
    return user.role in ("admin", "moderator")


async def _team_member_ids(db: AsyncSession, team_id: str) -> set[str]:
    rows = (
        await db.execute(
            select(models.TeamMember.user_id).where(
                models.TeamMember.team_id == team_id
            )
        )
    ).scalars().all()
    return set(rows)


async def _user_teams(db: AsyncSession, user_id: str) -> set[str]:
    rows = (
        await db.execute(
            select(models.TeamMember.team_id).where(
                models.TeamMember.user_id == user_id
            )
        )
    ).scalars().all()
    return set(rows)
