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


async def _serialize_admin_user(
    db: AsyncSession, user: models.User
) -> schemas.AdminUserOut:
    """Pack a User row + its additional role grants from the
    user_roles join table so the admin dashboard renders the full
    chip set without an N+1 follow-up. Sorted code list keeps the
    UI deterministic across reloads."""
    out = schemas.AdminUserOut.model_validate(user)
    extras = (
        await db.execute(
            select(models.UserRole.role_code).where(
                models.UserRole.user_id == user.id,
            )
        )
    ).scalars().all()
    out.extra_roles = sorted(extras)
    return out


async def _serialize_admin_users(
    db: AsyncSession, users: list[models.User]
) -> list[schemas.AdminUserOut]:
    """Bulk version of the above — fans the user_roles lookup out in
    one IN query so a 200-user list stays a single round trip."""
    if not users:
        return []
    ids = [u.id for u in users]
    rows = (
        await db.execute(
            select(models.UserRole.user_id, models.UserRole.role_code)
            .where(models.UserRole.user_id.in_(ids))
        )
    ).all()
    bucket: dict[str, list[str]] = {}
    for uid, code in rows:
        bucket.setdefault(uid, []).append(code)
    out: list[schemas.AdminUserOut] = []
    for u in users:
        o = schemas.AdminUserOut.model_validate(u)
        o.extra_roles = sorted(bucket.get(u.id, []))
        out.append(o)
    return out


async def _is_admin_tier(db: AsyncSession, role_code: str) -> bool:
    """A role is admin-tier when its base_role resolves to "admin".
    Covers the built-in `admin` row and any operator-defined role
    that nominated admin as its base."""
    if role_code == "admin":
        return True
    if role_code in {"moderator", "user"}:
        return False
    role = (
        await db.execute(
            select(models.Role).where(models.Role.code == role_code)
        )
    ).scalar_one_or_none()
    return role is not None and role.base_role == "admin"


async def _count_active_admins(
    db: AsyncSession, *, excluding: str | None = None
) -> int:
    """Active admin = any role whose base_role resolves to 'admin'
    AND status='approved'. Custom codes count as long as they sit on
    the admin tier. Used to block actions that would leave the system
    with zero administrators (last-admin self-demote, suspending the
    last admin, etc.)."""
    admin_codes_q = select(models.Role.code).where(
        models.Role.base_role == "admin"
    )
    admin_codes = (await db.execute(admin_codes_q)).scalars().all()
    if not admin_codes:
        admin_codes = ["admin"]
    stmt = select(func.count(models.User.id)).where(
        models.User.role.in_(admin_codes),
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
    # `role` filter is just a string match against User.role — accept
    # any code that exists in the roles table.
    if role:
        exists = (
            await db.execute(select(models.Role).where(models.Role.code == role))
        ).scalar_one_or_none()
        if exists is None:
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
    return await _serialize_admin_users(db, list(rows))


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
    return await _serialize_admin_user(db, user)


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
        return await _serialize_admin_user(db, user)
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
    return await _serialize_admin_user(db, user)


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
    return await _serialize_admin_user(db, user)


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
    # Resolve the target role to its definition row so we know (a)
    # whether the code exists at all, and (b) what permission tier it
    # maps to for the last-admin guard below.
    target_role = (
        await db.execute(
            select(models.Role).where(models.Role.code == payload.role)
        )
    ).scalar_one_or_none()
    if target_role is None:
        raise HTTPException(400, f"unknown role code: {payload.role}")

    # Last-admin guard — block any demotion (admin tier → lower tier)
    # that would leave the system without an active admin. The check
    # uses base_role so a custom "supervisor" role with base_role=admin
    # still counts as an admin for this purpose.
    user_is_admin_tier = await _is_admin_tier(db, user.role)
    target_is_admin_tier = target_role.base_role == "admin"
    if (
        user_is_admin_tier
        and not target_is_admin_tier
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
    return await _serialize_admin_user(db, user)


@router.patch(
    "/users/{user_id}/roles",
    response_model=schemas.AdminUserOut,
)
async def set_user_roles(
    user_id: str,
    payload: schemas.UserRolesUpdateRequest,
    request: Request,
    actor: models.User = Depends(require_admin),
    db: AsyncSession = Depends(get_db),
):
    """Replace the user's *additional* role grants with `role_codes`.
    The primary role (users.role) is left alone — change that via
    the /role endpoint. Unknown codes are silently dropped after
    validation against the roles table, and the primary code is also
    filtered out so it doesn't redundantly appear in both places."""
    user = await _load_target(db, user_id)
    # Validate every code against the roles table in one go — anything
    # the operator passed that doesn't exist gets quietly discarded
    # rather than 400'ing so a stale UI doesn't lose the whole save.
    requested = [c for c in payload.role_codes if c != user.role]
    valid = set()
    if requested:
        valid = set(
            (
                await db.execute(
                    select(models.Role.code).where(
                        models.Role.code.in_(requested),
                    )
                )
            ).scalars().all()
        )
    # Replace all rows for this user in a single statement (delete +
    # re-insert is fine — the join table is tiny).
    existing = (
        await db.execute(
            select(models.UserRole).where(
                models.UserRole.user_id == user_id,
            )
        )
    ).scalars().all()
    for row in existing:
        await db.delete(row)
    for code in valid:
        db.add(models.UserRole(user_id=user_id, role_code=code))
    await audit.record(
        db, request, "user_roles_changed", user_id=actor.id,
        detail=f"target={user.email} extra={sorted(valid)}",
    )
    await db.commit()
    await db.refresh(user)
    return await _serialize_admin_user(db, user)


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
        return await _serialize_admin_user(db, user)
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
    return await _serialize_admin_user(db, user)


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
            return await _serialize_admin_user(db, user)
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
    return await _serialize_admin_user(db, user)


# ── Role definitions (custom + system) ────────────────────────────


@router.get("/roles", response_model=list[schemas.RoleOut])
async def list_roles(
    _staff: models.User = Depends(require_staff),
    db: AsyncSession = Depends(get_db),
):
    """Every role definition — built-in (admin/moderator/user) and
    any operator-added custom codes. Sorted system-first so the
    dashboard renders the canonical tier list before custom entries."""
    rows = (
        await db.execute(
            select(models.Role).order_by(
                models.Role.is_system.desc(),
                models.Role.created_at.asc(),
            )
        )
    ).scalars().all()
    return rows


@router.post("/roles", response_model=schemas.RoleOut, status_code=201)
async def create_role(
    payload: schemas.RoleCreateRequest,
    request: Request,
    actor: models.User = Depends(require_admin),
    db: AsyncSession = Depends(get_db),
):
    """Create a new custom role. `code` is the immutable identifier
    written into User.role; `base_role` controls which require_role()
    checks the new role passes. System codes (admin/moderator/user)
    cannot be re-created."""
    code = payload.code.strip().lower()
    if code in {"admin", "moderator", "user"}:
        raise HTTPException(
            400, f"'{code}'는 시스템 역할 코드라 새로 만들 수 없습니다",
        )
    existing = (
        await db.execute(select(models.Role).where(models.Role.code == code))
    ).scalar_one_or_none()
    if existing is not None:
        raise HTTPException(409, "이미 존재하는 역할 코드입니다")
    role = models.Role(
        code=code,
        name=payload.name.strip(),
        description=(payload.description or "").strip() or None,
        base_role=payload.base_role,
        is_system=False,
        created_by_id=actor.id,
    )
    db.add(role)
    await audit.record(
        db, request, "role_created", user_id=actor.id,
        detail=f"code={code} base={payload.base_role}",
    )
    await db.commit()
    await db.refresh(role)
    return role


@router.patch("/roles/{code}", response_model=schemas.RoleOut)
async def update_role(
    code: str,
    payload: schemas.RoleUpdateBody,
    request: Request,
    actor: models.User = Depends(require_admin),
    db: AsyncSession = Depends(get_db),
):
    """Edit a role's display name / description. base_role is mutable
    for custom roles only — changing it on a system row would break
    the permission semantics other code paths rely on."""
    role = (
        await db.execute(select(models.Role).where(models.Role.code == code))
    ).scalar_one_or_none()
    if role is None:
        raise HTTPException(404, "역할을 찾을 수 없습니다")
    changes: list[str] = []
    if payload.name is not None and payload.name.strip() != role.name:
        role.name = payload.name.strip()
        changes.append("name")
    if payload.description is not None:
        desc = payload.description.strip() or None
        if desc != role.description:
            role.description = desc
            changes.append("description")
    if payload.base_role is not None and payload.base_role != role.base_role:
        if role.is_system:
            raise HTTPException(
                400, "시스템 역할의 base_role은 변경할 수 없습니다",
            )
        role.base_role = payload.base_role
        changes.append("base_role")
    if changes:
        await audit.record(
            db, request, "role_updated", user_id=actor.id,
            detail=f"code={code} fields={','.join(changes)}",
        )
    await db.commit()
    await db.refresh(role)
    return role


@router.delete("/roles/{code}", status_code=204)
async def delete_role(
    code: str,
    request: Request,
    actor: models.User = Depends(require_admin),
    db: AsyncSession = Depends(get_db),
):
    """Remove a custom role. Blocked when (a) the row is a system role
    or (b) any user still references it — admin must first reassign
    those users to a different role."""
    role = (
        await db.execute(select(models.Role).where(models.Role.code == code))
    ).scalar_one_or_none()
    if role is None:
        raise HTTPException(404, "역할을 찾을 수 없습니다")
    if role.is_system:
        raise HTTPException(400, "시스템 역할은 삭제할 수 없습니다")
    in_use = (
        await db.execute(
            select(func.count(models.User.id)).where(models.User.role == code)
        )
    ).scalar() or 0
    if in_use > 0:
        raise HTTPException(
            409,
            f"이 역할을 가진 사용자가 {in_use}명 있습니다. "
            "먼저 모두 다른 역할로 변경하세요.",
        )
    await db.delete(role)
    await audit.record(
        db, request, "role_deleted", user_id=actor.id,
        detail=f"code={code}",
    )
    await db.commit()


async def _load_target(db: AsyncSession, user_id: str) -> models.User:
    """Look up a user row for the admin endpoints to mutate. Returns
    the live SQLAlchemy ORM instance so callers can flip status /
    role and commit — they then run the result through
    `_serialize_admin_user` themselves to build the response."""
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
