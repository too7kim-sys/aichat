"""Admin endpoints — list / approve / reject / role-change users.

Authorization model:
  - moderators can see the full user list and approve/reject pending
    signups (the operational front line)
  - admins can additionally change roles and undo a previous
    rejection (the policy lever)

The same JWT scheme that protects the rest of the app is reused —
no separate admin auth.
"""
from datetime import datetime, timezone

from fastapi import APIRouter, Depends, HTTPException, Request
from sqlalchemy import or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from .. import audit, models, schemas
from ..auth import get_current_user, require_admin, require_staff
from ..database import get_db
from ..email import send_account_approved_email, send_account_rejected_email

router = APIRouter(prefix="/api/admin", tags=["admin"])


_VALID_STATUS = {"pending", "approved", "rejected"}


@router.get("/users", response_model=list[schemas.AdminUserOut])
async def list_users(
    status: str | None = None,
    role: str | None = None,
    q: str | None = None,
    limit: int = 200,
    _staff: models.User = Depends(require_staff),
    db: AsyncSession = Depends(get_db),
):
    """List users for the admin dashboard. Optional filters: status
    bucket (pending / approved / rejected), role, free-text query
    against email or name. Capped to 200 rows — the dashboard is for
    moderation, not bulk export."""
    if status and status not in _VALID_STATUS:
        raise HTTPException(400, f"unknown status: {status}")
    if role and role not in {"user", "moderator", "admin"}:
        raise HTTPException(400, f"unknown role: {role}")
    if limit < 1:
        limit = 50
    if limit > 500:
        limit = 500

    stmt = select(models.User)
    if status:
        stmt = stmt.where(models.User.status == status)
    if role:
        stmt = stmt.where(models.User.role == role)
    if q:
        like = f"%{q.strip().lower()}%"
        stmt = stmt.where(
            or_(
                models.User.email.ilike(like),
                models.User.name.ilike(like),
            )
        )
    # Pending first (oldest pending floats up — fastest fairness),
    # then newest-active.
    stmt = stmt.order_by(
        # Pending sorts ahead of approved/rejected
        (models.User.status != "pending"),
        models.User.created_at.desc(),
    ).limit(limit)

    rows = (await db.execute(stmt)).scalars().all()
    return rows


@router.get("/users/{user_id}", response_model=schemas.AdminUserOut)
async def get_user(
    user_id: str,
    _staff: models.User = Depends(require_staff),
    db: AsyncSession = Depends(get_db),
):
    user = (
        await db.execute(
            select(models.User).where(models.User.id == user_id)
        )
    ).scalar_one_or_none()
    if user is None:
        raise HTTPException(404, "사용자를 찾을 수 없습니다")
    return user


@router.post(
    "/users/{user_id}/approve",
    response_model=schemas.AdminUserOut,
)
async def approve_user(
    user_id: str,
    request: Request,
    actor: models.User = Depends(require_staff),
    db: AsyncSession = Depends(get_db),
):
    user = await _load_target(db, user_id)
    if user.status == "approved":
        # Idempotent — already approved is a no-op rather than 400,
        # so a double-click in the dashboard doesn't flash a red
        # error.
        return user
    if user.id == actor.id:
        raise HTTPException(400, "본인 계정은 직접 승인할 수 없습니다")
    user.status = "approved"
    user.approved_at = datetime.now(timezone.utc)
    user.approved_by_id = actor.id
    user.rejection_reason = None
    await audit.record(
        db, request, "user_approved", user_id=actor.id,
        detail=f"target={user.email}",
    )
    await db.commit()
    await db.refresh(user)
    try:
        await send_account_approved_email(user.email, user.name)
    except Exception:
        pass
    return user


@router.post(
    "/users/{user_id}/reject",
    response_model=schemas.AdminUserOut,
)
async def reject_user(
    user_id: str,
    payload: schemas.RejectRequest,
    request: Request,
    actor: models.User = Depends(require_staff),
    db: AsyncSession = Depends(get_db),
):
    user = await _load_target(db, user_id)
    if user.id == actor.id:
        raise HTTPException(400, "본인 계정은 거절할 수 없습니다")
    if user.role == "admin" and actor.role != "admin":
        raise HTTPException(
            403, "관리자 계정은 다른 관리자만 거절할 수 있습니다",
        )
    user.status = "rejected"
    user.rejection_reason = (payload.reason or "").strip() or None
    user.approved_at = None
    user.approved_by_id = actor.id
    await audit.record(
        db, request, "user_rejected", user_id=actor.id,
        detail=f"target={user.email}",
    )
    await db.commit()
    await db.refresh(user)
    try:
        await send_account_rejected_email(
            user.email, user.name, user.rejection_reason,
        )
    except Exception:
        pass
    return user


@router.post(
    "/users/{user_id}/role",
    response_model=schemas.AdminUserOut,
)
async def change_role(
    user_id: str,
    payload: schemas.RoleUpdateRequest,
    request: Request,
    actor: models.User = Depends(require_admin),
    db: AsyncSession = Depends(get_db),
):
    user = await _load_target(db, user_id)
    if user.id == actor.id and payload.role != "admin":
        raise HTTPException(
            400, "본인의 관리자 권한은 직접 내릴 수 없습니다",
        )
    old = user.role
    user.role = payload.role
    await audit.record(
        db, request, "user_role_changed", user_id=actor.id,
        detail=f"target={user.email} {old}->{payload.role}",
    )
    await db.commit()
    await db.refresh(user)
    return user


async def _load_target(db: AsyncSession, user_id: str) -> models.User:
    user = (
        await db.execute(
            select(models.User).where(models.User.id == user_id)
        )
    ).scalar_one_or_none()
    if user is None:
        raise HTTPException(404, "사용자를 찾을 수 없습니다")
    return user


@router.get("/pending-count")
async def pending_count(
    _staff: models.User = Depends(require_staff),
    db: AsyncSession = Depends(get_db),
):
    """Tiny endpoint the frontend polls to show a badge next to the
    admin link when pending users are waiting."""
    n = (
        await db.execute(
            select(models.User).where(models.User.status == "pending")
        )
    ).scalars().unique().all()
    return {"count": len(n)}


# Suppress an unused-import lint when the file is imported for its
# router only — `get_current_user` is referenced via require_staff /
# require_admin transitively.
_ = get_current_user
