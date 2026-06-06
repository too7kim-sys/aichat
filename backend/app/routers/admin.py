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
from sqlalchemy import func, or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from .. import app_settings, audit, models, schemas
from ..auth import get_current_user, require_admin, require_staff
from ..database import get_db
from ..email import send_account_approved_email, send_account_rejected_email

router = APIRouter(prefix="/api/admin", tags=["admin"])


_VALID_STATUS = {"pending", "approved", "rejected", "suspended"}


async def _count_active_admins(
    db: AsyncSession, *, excluding: str | None = None
) -> int:
    """Active admin = role='admin' AND status='approved'. Used to
    block actions that would leave the system with zero administrators
    (last-admin self-demote, suspending the last admin, etc.)."""
    stmt = select(func.count(models.User.id)).where(
        models.User.role == "admin",
        models.User.status == "approved",
    )
    if excluding:
        stmt = stmt.where(models.User.id != excluding)
    return (await db.execute(stmt)).scalar() or 0


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
    # Block rejecting the last active admin — would leave the system
    # with no one able to flip roles / lift suspensions / change
    # policy. Applies even when the actor IS an admin (you can't
    # reject your last admin colleague if you're rejecting yourself
    # — but that path is already blocked by the self-check above).
    if user.role == "admin" and user.status == "approved":
        if await _count_active_admins(db, excluding=user.id) < 1:
            raise HTTPException(
                400, "마지막 관리자(admin) 계정은 거절할 수 없습니다",
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
    # Last-admin guard — block any admin demotion (admin → moderator
    # or user) that would leave the system without an active admin.
    # The actor.id != user.id branch above means this only triggers
    # for "demote some other admin"; the self-demote path was already
    # closed.
    if (
        user.role == "admin"
        and payload.role != "admin"
        and user.status == "approved"
    ):
        if await _count_active_admins(db, excluding=user.id) < 1:
            raise HTTPException(
                400,
                "마지막 관리자(admin) 권한은 내릴 수 없습니다. "
                "먼저 다른 사용자를 관리자로 승격하세요.",
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


@router.post(
    "/users/{user_id}/suspend",
    response_model=schemas.AdminUserOut,
)
async def suspend_user(
    user_id: str,
    payload: schemas.SuspendRequest,
    request: Request,
    actor: models.User = Depends(require_staff),
    db: AsyncSession = Depends(get_db),
):
    """Temporarily block an already-approved account. Distinct from
    rejection (terminal): a suspended user can be reactivated later
    with /unsuspend. Suspended sessions/JWTs are killed on the next
    request via get_current_user's status gate."""
    user = await _load_target(db, user_id)
    if user.id == actor.id:
        raise HTTPException(400, "본인 계정은 직접 정지할 수 없습니다")
    if user.status == "suspended":
        # Idempotent — already suspended is a no-op so a double-click
        # in the dashboard doesn't flash an error.
        return user
    if user.status != "approved":
        raise HTTPException(
            400,
            f"활성 상태인 사용자만 정지할 수 있습니다 (현재: {user.status})",
        )
    # Privilege guard — only admins can suspend an admin or a
    # moderator. Moderators can suspend regular users only.
    if user.role in {"admin", "moderator"} and actor.role != "admin":
        raise HTTPException(
            403,
            "관리자/운영자 계정은 다른 관리자(admin)만 정지할 수 있습니다",
        )
    # Last-admin guard — suspending the only remaining admin would
    # lock the system out of role/policy changes.
    if user.role == "admin":
        if await _count_active_admins(db, excluding=user.id) < 1:
            raise HTTPException(
                400,
                "마지막 관리자(admin)는 정지할 수 없습니다. "
                "먼저 다른 사용자를 관리자로 승격하세요.",
            )
    user.status = "suspended"
    user.suspended_at = datetime.now(timezone.utc)
    user.suspended_by_id = actor.id
    user.suspension_reason = (payload.reason or "").strip() or None
    await audit.record(
        db, request, "user_suspended", user_id=actor.id,
        detail=f"target={user.email}",
    )
    await db.commit()
    await db.refresh(user)
    return user


@router.post(
    "/users/{user_id}/unsuspend",
    response_model=schemas.AdminUserOut,
)
async def unsuspend_user(
    user_id: str,
    request: Request,
    actor: models.User = Depends(require_staff),
    db: AsyncSession = Depends(get_db),
):
    """Lift a suspension — moves the user back to 'approved'.
    Suspension metadata (who/when/why) is preserved as null so the
    audit trail stays clean for the next admin to look at the row."""
    user = await _load_target(db, user_id)
    if user.status != "suspended":
        # Idempotent if the row is already active.
        if user.status == "approved":
            return user
        raise HTTPException(
            400,
            f"정지 상태인 사용자만 해제할 수 있습니다 (현재: {user.status})",
        )
    user.status = "approved"
    user.suspended_at = None
    user.suspended_by_id = None
    user.suspension_reason = None
    await audit.record(
        db, request, "user_unsuspended", user_id=actor.id,
        detail=f"target={user.email}",
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


@router.get("/settings", response_model=schemas.AppSettingsOut)
async def get_settings(
    _staff: models.User = Depends(require_staff),
    db: AsyncSession = Depends(get_db),
):
    """Current runtime settings — readable by staff so moderators
    can see the active policy even though only admins can flip it."""
    return schemas.AppSettingsOut(
        auto_approve_signups=await app_settings.get_bool(
            db, app_settings.KEY_AUTO_APPROVE_SIGNUPS,
        ),
    )


@router.put("/settings", response_model=schemas.AppSettingsOut)
async def update_settings(
    payload: schemas.AppSettingsUpdate,
    request: Request,
    actor: models.User = Depends(require_admin),
    db: AsyncSession = Depends(get_db),
):
    """Flip runtime app settings. Admin-only — moderators can act on
    the approval queue but shouldn't unilaterally change the policy
    that creates the queue in the first place."""
    if payload.auto_approve_signups is not None:
        old = await app_settings.get_bool(
            db, app_settings.KEY_AUTO_APPROVE_SIGNUPS,
        )
        new = payload.auto_approve_signups
        if old != new:
            await app_settings.set_bool(
                db,
                app_settings.KEY_AUTO_APPROVE_SIGNUPS,
                new,
                actor_id=actor.id,
            )
            await audit.record(
                db, request, "settings_changed",
                user_id=actor.id,
                detail=f"auto_approve_signups: {old}→{new}",
            )
    await db.commit()
    return schemas.AppSettingsOut(
        auto_approve_signups=await app_settings.get_bool(
            db, app_settings.KEY_AUTO_APPROVE_SIGNUPS,
        ),
    )


# Suppress an unused-import lint when the file is imported for its
# router only — `get_current_user` is referenced via require_staff /
# require_admin transitively.
_ = get_current_user
