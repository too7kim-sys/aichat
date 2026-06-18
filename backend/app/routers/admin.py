"""Admin endpoints — list / approve / reject / role-change users.

Authorization model:
  - moderators can see the full user list and approve/reject pending
    signups (the operational front line)
  - admins can additionally change roles and undo a previous
    rejection (the policy lever)

The same JWT scheme that protects the rest of the app is reused —
no separate admin auth.
"""
import os
from datetime import datetime, timezone
from pathlib import Path

from fastapi import APIRouter, Depends, HTTPException, Request
from sqlalchemy import func, or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from .. import app_settings, audit, models, schemas
from ..auth import get_current_user, require_admin, require_staff
from ..config import settings
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
        rag_query_rewrite=await app_settings.get_bool(
            db, app_settings.KEY_RAG_QUERY_REWRITE,
        ),
        rag_llm_rerank=await app_settings.get_bool(
            db, app_settings.KEY_RAG_LLM_RERANK,
        ),
        rag_mmr=await app_settings.get_bool(
            db, app_settings.KEY_RAG_MMR,
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
    async def _maybe_flip(key: str, new_val: bool | None, label: str) -> None:
        if new_val is None:
            return
        old = await app_settings.get_bool(db, key)
        if old == new_val:
            return
        await app_settings.set_bool(db, key, new_val, actor_id=actor.id)
        await audit.record(
            db, request, "settings_changed",
            user_id=actor.id,
            detail=f"{label}: {old}→{new_val}",
        )

    await _maybe_flip(
        app_settings.KEY_AUTO_APPROVE_SIGNUPS,
        payload.auto_approve_signups,
        "auto_approve_signups",
    )
    await _maybe_flip(
        app_settings.KEY_RAG_QUERY_REWRITE,
        payload.rag_query_rewrite,
        "rag_query_rewrite",
    )
    await _maybe_flip(
        app_settings.KEY_RAG_LLM_RERANK,
        payload.rag_llm_rerank,
        "rag_llm_rerank",
    )
    await _maybe_flip(
        app_settings.KEY_RAG_MMR,
        payload.rag_mmr,
        "rag_mmr",
    )
    await db.commit()
    return schemas.AppSettingsOut(
        auto_approve_signups=await app_settings.get_bool(
            db, app_settings.KEY_AUTO_APPROVE_SIGNUPS,
        ),
        rag_query_rewrite=await app_settings.get_bool(
            db, app_settings.KEY_RAG_QUERY_REWRITE,
        ),
        rag_llm_rerank=await app_settings.get_bool(
            db, app_settings.KEY_RAG_LLM_RERANK,
        ),
        rag_mmr=await app_settings.get_bool(
            db, app_settings.KEY_RAG_MMR,
        ),
    )


# ── 오류 모니터링 ──────────────────────────────────────────────────────
# 운영자가 SSH·로그 안 보고도 최근에 실패한 작업을 한 화면에서 볼 수
# 있게 transcripts / projects / workflows 의 실패 행을 모아 반환한다.
# 각 카테고리별로 가장 최근 50건까지.


@router.get("/errors")
async def list_errors(
    limit: int = 50,
    _staff: models.User = Depends(require_staff),
    db: AsyncSession = Depends(get_db),
):
    """관리자 화면용 — 최근 실패한 작업을 카테고리별로 모아 반환.

    Returns:
      {
        "transcripts": [{id, user_email, source_filename, error, updated_at}, ...],
        "projects":    [{id, owner_email, name, error, updated_at}, ...],
        "workflows":   [{id, user_email, name, last_error, last_run_at}, ...],
      }
    """
    limit = max(1, min(int(limit or 50), 200))

    # 사용자 id → email 캐시. 작은 매핑이라 한 번에 다 끌어와 in-memory 매칭.
    users_q = await db.execute(select(models.User.id, models.User.email))
    email_of = {uid: em for (uid, em) in users_q.all()}

    # 1. 전사 실패
    tr_rows = (
        await db.execute(
            select(models.Transcript)
            .where(models.Transcript.status == "failed")
            .order_by(models.Transcript.updated_at.desc())
            .limit(limit)
        )
    ).scalars().all()

    # 2. RAG 프로젝트 실패
    pr_rows = (
        await db.execute(
            select(models.Project)
            .where(models.Project.status == "failed")
            .order_by(models.Project.updated_at.desc())
            .limit(limit)
        )
    ).scalars().all()

    # 3. 워크플로 마지막 실행 실패
    wf_rows = (
        await db.execute(
            select(models.Workflow)
            .where(models.Workflow.last_run_status == "failed")
            .order_by(models.Workflow.last_run_at.desc().nullslast())
            .limit(limit)
        )
    ).scalars().all()

    return {
        "transcripts": [
            {
                "id": t.id,
                "user_email": email_of.get(t.user_id, "(unknown)"),
                "source_filename": t.source_filename,
                "session_id": t.session_id,
                "error": (t.error or "")[:2000],
                "created_at": t.created_at.isoformat() if t.created_at else None,
                "updated_at": t.updated_at.isoformat() if t.updated_at else None,
            }
            for t in tr_rows
        ],
        "projects": [
            {
                "id": p.id,
                "owner_email": email_of.get(p.user_id, "(unknown)"),
                "name": p.name,
                "source_type": p.source_type,
                "error": (p.error or "")[:2000],
                "created_at": p.created_at.isoformat() if p.created_at else None,
                "updated_at": p.updated_at.isoformat() if p.updated_at else None,
            }
            for p in pr_rows
        ],
        "workflows": [
            {
                "id": w.id,
                "user_email": email_of.get(w.user_id, "(unknown)"),
                "name": w.name,
                "last_error": (w.last_error or "")[:2000],
                "last_session_id": w.last_session_id,
                "last_run_at": (
                    w.last_run_at.isoformat() if w.last_run_at else None
                ),
            }
            for w in wf_rows
        ],
        # 백엔드 일반 오류 — 미들웨어/로깅 핸들러가 자동 캡처한 항목.
        # transcripts/projects/workflows 의 status=failed 외에 채팅·파일
        # 업로드·인증 등에서 발생하는 모든 예외 + 5xx + 413/429 가 여기.
        "app_errors": await _list_app_errors(limit),
    }


async def _list_app_errors(limit: int) -> list[dict]:
    """ErrorLog 최근 N개 — 관리자 패널의 '백엔드 일반 오류' 섹션용."""
    from ..error_log import recent as _recent
    return await _recent(limit)


# ── 감사 로그 뷰어 ─────────────────────────────────────────────────────
# audit_log 테이블에 이미 로그인/회원가입/비번변경 같은 이벤트가 쌓여
# 있다. 관리자가 검색·필터해서 한 화면에서 볼 수 있게 노출.


@router.get("/search-quality")
async def list_search_quality(
    limit: int = 100,
    only_misses: bool = False,
    _staff: models.User = Depends(require_staff),
    db: AsyncSession = Depends(get_db),
):
    """RAG 검색 품질 로그 (#110).  최근 항목순.  only_misses=true 면
    hit_count==0 또는 top_score<0.3 인 '잘 안 됐을 가능성' 만 본다."""
    limit = max(1, min(int(limit or 100), 500))
    q = (
        select(models.SearchQualityLog)
        .order_by(models.SearchQualityLog.created_at.desc())
        .limit(limit)
    )
    if only_misses:
        q = q.where(
            (models.SearchQualityLog.hit_count == 0)
            | (models.SearchQualityLog.top_score < 0.3)
        )
    rows = (await db.execute(q)).scalars().all()
    user_ids = {r.user_id for r in rows if r.user_id}
    emails: dict[str, str] = {}
    if user_ids:
        for uid, em in (
            await db.execute(
                select(models.User.id, models.User.email)
                .where(models.User.id.in_(user_ids))
            )
        ).all():
            emails[uid] = em
    return [
        {
            "id": r.id,
            "user_email": emails.get(r.user_id or "", "—"),
            "query": r.query,
            "project_ids": (r.project_ids or "").split(",") if r.project_ids else [],
            "top_score": float(r.top_score or 0.0),
            "hit_count": int(r.hit_count or 0),
            "elapsed_ms": int(r.elapsed_ms or 0),
            "created_at": r.created_at.isoformat() if r.created_at else None,
        }
        for r in rows
    ]


@router.get("/audit")
async def list_audit(
    limit: int = 100,
    event: str | None = None,
    user_q: str | None = None,
    date_from: str | None = None,
    date_to: str | None = None,
    _staff: models.User = Depends(require_staff),
    db: AsyncSession = Depends(get_db),
):
    """감사 로그 검색. `event` + `user_q` (이메일 부분 일치) + 날짜
    범위(`date_from` / `date_to`, ISO 8601 또는 YYYY-MM-DD) 로 좁힐 수
    있고 항상 최신순. 기본 100건."""
    limit = max(1, min(int(limit or 100), 500))

    q = select(models.AuditLog).order_by(models.AuditLog.created_at.desc())
    if event:
        q = q.where(models.AuditLog.event == event.strip())
    if user_q and user_q.strip():
        sub = (
            select(models.User.id)
            .where(models.User.email.ilike(f"%{user_q.strip()}%"))
        )
        q = q.where(models.AuditLog.user_id.in_(sub))
    if date_from:
        try:
            dt = datetime.fromisoformat(date_from)
            q = q.where(models.AuditLog.created_at >= dt)
        except ValueError:
            pass
    if date_to:
        try:
            dt = datetime.fromisoformat(date_to)
            q = q.where(models.AuditLog.created_at <= dt)
        except ValueError:
            pass
    rows = (await db.execute(q.limit(limit))).scalars().all()

    user_ids = {r.user_id for r in rows if r.user_id}
    emails: dict[str, str] = {}
    if user_ids:
        for uid, em in (
            await db.execute(
                select(models.User.id, models.User.email)
                .where(models.User.id.in_(user_ids))
            )
        ).all():
            emails[uid] = em

    return [
        {
            "id": r.id,
            "user_id": r.user_id,
            "user_email": emails.get(r.user_id, "(deleted)" if r.user_id else "—"),
            "event": r.event,
            "ip": r.ip,
            "user_agent": r.user_agent,
            "detail": r.detail,
            "created_at": r.created_at.isoformat() if r.created_at else None,
        }
        for r in rows
    ]


@router.get("/audit.csv")
async def export_audit_csv(
    event: str | None = None,
    user_q: str | None = None,
    date_from: str | None = None,
    date_to: str | None = None,
    _staff: models.User = Depends(require_staff),
    db: AsyncSession = Depends(get_db),
):
    """감사 로그를 CSV 로 내보내기 (최대 10,000 행).  컬럼은 list_audit
    응답과 동일.  엑셀이 한글을 깨지 않도록 UTF-8 BOM 을 붙인다."""
    import csv
    import io

    from fastapi.responses import StreamingResponse

    q = select(models.AuditLog).order_by(models.AuditLog.created_at.desc())
    if event:
        q = q.where(models.AuditLog.event == event.strip())
    if user_q and user_q.strip():
        sub = (
            select(models.User.id)
            .where(models.User.email.ilike(f"%{user_q.strip()}%"))
        )
        q = q.where(models.AuditLog.user_id.in_(sub))
    if date_from:
        try:
            q = q.where(
                models.AuditLog.created_at >= datetime.fromisoformat(date_from)
            )
        except ValueError:
            pass
    if date_to:
        try:
            q = q.where(
                models.AuditLog.created_at <= datetime.fromisoformat(date_to)
            )
        except ValueError:
            pass
    rows = (await db.execute(q.limit(10_000))).scalars().all()

    user_ids = {r.user_id for r in rows if r.user_id}
    emails: dict[str, str] = {}
    if user_ids:
        for uid, em in (
            await db.execute(
                select(models.User.id, models.User.email)
                .where(models.User.id.in_(user_ids))
            )
        ).all():
            emails[uid] = em

    buf = io.StringIO()
    buf.write("﻿")  # UTF-8 BOM — Excel 한글 호환.
    w = csv.writer(buf)
    w.writerow(
        ["시각", "이벤트", "사용자", "IP", "User-Agent", "상세"],
    )
    for r in rows:
        w.writerow([
            r.created_at.isoformat() if r.created_at else "",
            r.event,
            emails.get(r.user_id or "", "—"),
            r.ip,
            r.user_agent,
            r.detail,
        ])
    buf.seek(0)
    today = datetime.utcnow().strftime("%Y%m%d")
    return StreamingResponse(
        iter([buf.getvalue()]),
        media_type="text/csv; charset=utf-8",
        headers={
            "Content-Disposition": f'attachment; filename="audit-{today}.csv"',
        },
    )


# ── 강제 로그아웃 + 토큰 무효화 ─────────────────────────────────────────
# users.tokens_invalidated_at 컬럼을 now() 로 업데이트 → JWT 의 iat 가
# 그보다 이전인 토큰은 다음 요청에서 401. 사용자별 / 전체 둘 다 가능.


@router.post("/users/{user_id}/logout-all")
async def force_logout_user(
    user_id: str,
    db: AsyncSession = Depends(get_db),
    actor: models.User = Depends(require_admin),
):
    """특정 사용자가 발급받은 모든 활성 JWT 를 즉시 무효화."""
    user = await _load_target(db, user_id)
    user.tokens_invalidated_at = datetime.now(timezone.utc)
    await db.commit()
    return {
        "user_id": user_id,
        "email": user.email,
        "tokens_invalidated_at": user.tokens_invalidated_at.isoformat(),
        "by": actor.email,
    }


@router.get("/active-sessions")
async def list_active_sessions(
    _admin: models.User = Depends(require_admin),
    db: AsyncSession = Depends(get_db),
):
    """현재 토큰이 유효해 보이는 사용자 목록 (= status approved AND
    (tokens_invalidated_at IS NULL OR 마지막 로그인 이후). 토큰은 stateless 라
    실제 "활성 세션 목록" 은 만들 수 없지만, 잠재적 활성 사용자 + 마지막
    로그인 시각으로 근사."""
    # last_login_at 같은 칼럼이 없어서 audit_log 의 login_ok 가장 최근 행으로 대체.
    last_login_rows = await db.execute(
        select(
            models.AuditLog.user_id,
            func.max(models.AuditLog.created_at).label("last_login"),
        )
        .where(models.AuditLog.event == "login_ok")
        .group_by(models.AuditLog.user_id)
    )
    last_by_uid: dict[str, datetime] = {
        uid: dt for uid, dt in last_login_rows.all() if uid
    }
    users = (
        await db.execute(
            select(models.User)
            .where(models.User.status == "approved")
            .order_by(models.User.email)
        )
    ).scalars().all()
    out = []
    for u in users:
        last = last_by_uid.get(u.id)
        if last is None:
            continue
        invalidated = u.tokens_invalidated_at
        if invalidated is not None:
            cutoff = invalidated.replace(tzinfo=timezone.utc) if invalidated.tzinfo is None else invalidated
            last_aware = last.replace(tzinfo=timezone.utc) if last.tzinfo is None else last
            if last_aware < cutoff:
                continue
        out.append({
            "user_id": u.id,
            "email": u.email,
            "role": u.role,
            "last_login_at": last.isoformat(),
            "tokens_invalidated_at": (
                invalidated.isoformat() if invalidated else None
            ),
        })
    return out


# ── 시스템 자원 / 사용 통계 / 비용 / 백업 ─────────────────────────────


def _resolve_backup_dir() -> "Path":
    """settings.backup_dir 를 systemd WorkingDirectory(=backend) 기준
    으로 풀어준다. 절대경로면 그대로."""
    from pathlib import Path as _P
    p = _P(settings.backup_dir).expanduser()
    if p.is_absolute():
        return p.resolve()
    from .. import __file__ as _app_init
    backend_root = _P(_app_init).resolve().parent.parent
    return (backend_root / p).resolve()


@router.get("/system-resources")
async def get_system_resources(
    _staff: models.User = Depends(require_staff),
):
    """CPU / 메모리 / 디스크 / GPU 현재 스냅샷. 폴링 5~10초 간격 권장."""
    from .. import system_resources
    return system_resources.snapshot(["/", "/data"])


@router.get("/model-usage")
async def get_model_usage(
    days: int = 30,
    _staff: models.User = Depends(require_staff),
    db: AsyncSession = Depends(get_db),
):
    """모델별 호출 횟수 + 출력 토큰 + 평균 지연 + 추정 비용."""
    from .. import dashboard
    return await dashboard.model_usage_stats(db, days=max(1, min(int(days), 365)))


@router.get("/user-activity")
async def get_user_activity(
    days: int = 30,
    limit: int = 100,
    _staff: models.User = Depends(require_staff),
    db: AsyncSession = Depends(get_db),
):
    """사용자별 메시지·세션·로그인 활동 요약. 최근 활동 우선."""
    from .. import dashboard
    return await dashboard.user_activity_summary(
        db,
        days=max(1, min(int(days), 365)),
        limit=max(1, min(int(limit), 500)),
    )


@router.get("/backups")
async def list_backups(
    _admin: models.User = Depends(require_admin),
):
    """백업 디렉터리 안의 .db 파일 목록 + 크기 + 시각."""
    base = _resolve_backup_dir()
    if not base.is_dir():
        return {"backup_dir": str(base), "files": []}
    files = []
    for p in sorted(base.glob("*.db"), reverse=True):
        try:
            st = p.stat()
            files.append({
                "name": p.name,
                "size_bytes": st.st_size,
                "mtime": datetime.fromtimestamp(
                    st.st_mtime, tz=timezone.utc
                ).isoformat(),
            })
        except OSError:
            continue
    return {"backup_dir": str(base), "files": files}


@router.post("/backups")
async def create_backup(
    _admin: models.User = Depends(require_admin),
):
    """현재 aichat.db 의 WAL 체크포인트를 친 뒤 backup 디렉터리로 복사."""
    import shutil
    from pathlib import Path

    url = settings.database_url
    if "sqlite" not in url:
        raise HTTPException(400, "SQLite 가 아니라 직접 백업할 수 없습니다.")
    if ":///" not in url:
        raise HTTPException(400, f"DB URL 형식 인식 불가: {url}")

    # 경로 해석은 systemd WorkingDirectory(=backend) 기준이라 상대경로
    # 일 때는 backend/ 안에서 풀린다. 절대경로면 그대로 사용.
    raw_db = url.split(":///", 1)[1]
    db_path = Path(raw_db).expanduser()
    if not db_path.is_absolute():
        from .. import __file__ as _app_init
        backend_root = Path(_app_init).resolve().parent.parent
        db_path = (backend_root / db_path).resolve()
    else:
        db_path = db_path.resolve()
    if not db_path.is_file():
        raise HTTPException(409, f"DB 파일을 찾지 못했습니다: {db_path}")

    base = _resolve_backup_dir()
    try:
        base.mkdir(parents=True, exist_ok=True)
    except OSError as exc:
        raise HTTPException(
            500,
            f"백업 디렉터리 생성 실패: {base} — {exc.strerror or exc}",
        )
    if not os.access(str(base), os.W_OK):
        raise HTTPException(
            500,
            f"백업 디렉터리에 쓰기 권한이 없습니다: {base}",
        )
    ts = datetime.now(timezone.utc).strftime("%Y%m%d-%H%M%S")
    target = base / f"aichat-{ts}-manual.db"

    # WAL 체크포인트 — 백업 시 누락 방지.
    import sqlite3
    try:
        c = sqlite3.connect(str(db_path), timeout=10)
        try:
            c.execute("PRAGMA wal_checkpoint(TRUNCATE)")
        finally:
            c.close()
    except sqlite3.Error as exc:
        # 체크포인트 실패해도 백업 자체는 시도 (best-effort).
        log.warning("WAL checkpoint 실패: %s — 백업은 계속", exc)
    try:
        shutil.copy2(str(db_path), str(target))
    except OSError as exc:
        raise HTTPException(
            500,
            f"백업 복사 실패: {exc.strerror or exc}",
        )
    return {
        "name": target.name,
        "size_bytes": target.stat().st_size,
        "mtime": datetime.fromtimestamp(
            target.stat().st_mtime, tz=timezone.utc
        ).isoformat(),
        "backup_dir": str(base),
        "source": str(db_path),
    }


@router.get("/backups/_full.zip")
async def download_full_backup(
    _admin: models.User = Depends(require_admin),
):
    """SQLite DB + 업로드 디렉터리(/data/docs) 를 zip 한 스트림으로 다운로드 (#106).
    중간에 파일을 임시 저장하지 않고 곧장 응답 스트림으로 흘려보냄.

    IMPORTANT: 이 라우트는 반드시 `/backups/{name}` 보다 먼저 선언돼야 한다 —
    FastAPI 가 등록 순서대로 매칭하기 때문에 그렇지 않으면 `_full.zip` 이
    name path-param 으로 빨려 들어간다."""
    import io
    import zipfile
    from pathlib import Path

    from fastapi.responses import StreamingResponse

    # 1) DB 파일 경로 해석 — POST /backups 와 동일한 로직.
    url = settings.database_url
    db_path: Path | None = None
    if "sqlite" in url and ":///" in url:
        raw_db = url.split(":///", 1)[1]
        p = Path(raw_db).expanduser()
        if not p.is_absolute():
            from .. import __file__ as _app_init
            backend_root = Path(_app_init).resolve().parent.parent
            p = (backend_root / p).resolve()
        else:
            p = p.resolve()
        if p.is_file():
            db_path = p
    # 2) 업로드 디렉터리.
    uploads_dir = Path(settings.rag_upload_dir).expanduser().resolve()

    # SQLite WAL checkpoint 후 zip — 누락 방지.
    if db_path is not None:
        import sqlite3
        try:
            c = sqlite3.connect(str(db_path), timeout=10)
            try:
                c.execute("PRAGMA wal_checkpoint(TRUNCATE)")
            finally:
                c.close()
        except sqlite3.Error as exc:
            log.warning("WAL checkpoint 실패: %s — 백업 진행", exc)

    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as zf:
        if db_path is not None:
            zf.write(db_path, arcname=f"db/{db_path.name}")
        if uploads_dir.is_dir():
            for fp in uploads_dir.rglob("*"):
                if not fp.is_file():
                    continue
                try:
                    arc = "uploads/" + str(fp.relative_to(uploads_dir))
                    zf.write(fp, arcname=arc)
                except (OSError, ValueError):
                    # 권한 / 심볼릭 링크 깨짐 — 한 파일만 건너뛰고 계속.
                    continue
        # 메타 파일 — 복구 시점에 어떤 디렉터리에서 가져왔는지 기억.
        meta = (
            f"aichat full backup\n"
            f"created_at: {datetime.now(timezone.utc).isoformat()}\n"
            f"db_url: {url}\n"
            f"uploads_dir: {uploads_dir}\n"
        )
        zf.writestr("MANIFEST.txt", meta)
    buf.seek(0)
    ts = datetime.utcnow().strftime("%Y%m%d-%H%M%S")
    return StreamingResponse(
        iter([buf.getvalue()]),
        media_type="application/zip",
        headers={
            "Content-Disposition": f'attachment; filename="aichat-full-{ts}.zip"',
        },
    )


@router.get("/backups/{name}")
async def download_backup(
    name: str,
    _admin: models.User = Depends(require_admin),
):
    """백업 파일 다운로드. 경로 트래버설 가드 — name 에 / 나 .. 거부."""
    from pathlib import Path
    from fastapi.responses import FileResponse
    if "/" in name or "\\" in name or ".." in name.split("."):
        raise HTTPException(400, "잘못된 파일명")
    base = _resolve_backup_dir()
    target = (base / name).resolve()
    try:
        target.relative_to(base)
    except ValueError:
        raise HTTPException(400, "백업 디렉터리 밖 경로")
    if not target.is_file():
        raise HTTPException(404, "백업 파일이 없습니다")
    return FileResponse(
        path=str(target),
        media_type="application/x-sqlite3",
        filename=name,
    )


@router.delete("/backups/{name}", status_code=204)
async def delete_backup(
    name: str,
    _admin: models.User = Depends(require_admin),
):
    """오래된 백업 파일 정리."""
    from pathlib import Path
    if "/" in name or "\\" in name or ".." in name.split("."):
        raise HTTPException(400, "잘못된 파일명")
    base = _resolve_backup_dir()
    target = (base / name).resolve()
    try:
        target.relative_to(base)
    except ValueError:
        raise HTTPException(400, "백업 디렉터리 밖 경로")
    if target.is_file():
        target.unlink()


# Suppress an unused-import lint when the file is imported for its
# router only — `get_current_user` is referenced via require_staff /
# require_admin transitively.
_ = get_current_user


# ── 데이터 정합성 (#112~#115) ────────────────────────────────────────
# 폐쇄망 장기 운영에서 가장 자주 터지는 두 문제 — '백업이 실제로 살아
# 있는가' + '쓸데없이 디스크 차지하는 고아 데이터' 를 admin 이 한 화면
# 에서 검사·정리할 수 있게 묶음.


@router.get("/integrity/backups")
async def check_backup_integrity(
    _admin: models.User = Depends(require_admin),
):
    """백업 디렉터리의 각 .db 파일에 대해 sha256 + SQLite integrity_check
    (#112).  매뉴얼/스케줄러 백업이 실제로 풀리는지 다운로드 전에
    검증하는 용도."""
    import hashlib
    import sqlite3
    from pathlib import Path

    base = _resolve_backup_dir()
    if not base.is_dir():
        return {"backup_dir": str(base), "files": []}
    out = []
    for p in sorted(base.glob("*.db"), reverse=True):
        try:
            h = hashlib.sha256()
            size = 0
            with p.open("rb") as f:
                while True:
                    block = f.read(1024 * 1024)
                    if not block:
                        break
                    h.update(block)
                    size += len(block)
            # SQLite 무결성 — 빠른 모드 (퀵 체크).  PASS → 'ok'.
            integrity = "skipped"
            try:
                c = sqlite3.connect(f"file:{p}?mode=ro", uri=True, timeout=10)
                try:
                    row = c.execute("PRAGMA quick_check").fetchone()
                    integrity = (row[0] if row else "unknown")[:200]
                finally:
                    c.close()
            except sqlite3.Error as exc:
                integrity = f"sqlite-error: {exc}"
            st = p.stat()
            out.append({
                "name": p.name,
                "size_bytes": size,
                "sha256": h.hexdigest(),
                "integrity": integrity,
                "mtime": datetime.fromtimestamp(
                    st.st_mtime, tz=timezone.utc,
                ).isoformat(),
                "ok": integrity == "ok",
            })
        except OSError as exc:
            out.append({"name": p.name, "error": str(exc), "ok": False})
    return {"backup_dir": str(base), "files": out}


# Comment.target_type 별 → 대응 모델 + PK 컬럼.  target_id 가 그 모델
# 에 존재하지 않으면 고아.  새 target 종류가 늘어나면 여기에 추가.
_COMMENT_TARGET_MODELS: dict[str, type] = {
    "message": models.Message,
    "workflow": models.Workflow,
    "transcript": models.Transcript,
    "action": models.ActionItem,
    "session": models.Session,
    # chunk 은 Qdrant 안에 있는 청크 id 라 DB 검사 불가 — 별도 처리 X.
}


async def _orphan_comment_ids(db: AsyncSession) -> dict[str, list[str]]:
    """target_type 별로 '대응 모델에 그 id 가 없는' Comment.id 들 모음."""
    from sqlalchemy import and_, not_, select as _sel
    out: dict[str, list[str]] = {}
    for ttype, Model in _COMMENT_TARGET_MODELS.items():
        pk_col = Model.id  # type: ignore[attr-defined]
        sub = _sel(pk_col)
        orphan = (
            await db.execute(
                _sel(models.Comment.id)
                .where(
                    and_(
                        models.Comment.target_type == ttype,
                        not_(models.Comment.target_id.in_(sub)),
                    )
                )
                .limit(2000)
            )
        ).scalars().all()
        out[ttype] = list(orphan)
    return out


@router.get("/integrity/orphans")
async def list_orphans(
    db: AsyncSession = Depends(get_db),
    _admin: models.User = Depends(require_admin),
):
    """카테고리별 고아 행 개수 (#113).  '검사' 단계 — 실제 삭제는 별도
    POST /integrity/orphans/cleanup 으로."""
    comment_orphans = await _orphan_comment_ids(db)
    return {
        "comments": {
            ttype: {"count": len(ids), "sample": ids[:5]}
            for ttype, ids in comment_orphans.items()
        },
    }


@router.post("/integrity/orphans/cleanup")
async def cleanup_orphans(
    payload: dict,
    request: Request,
    db: AsyncSession = Depends(get_db),
    actor: models.User = Depends(require_admin),
):
    """payload = {kind: 'comments', target_type: 'message' | ...}.  지정
    된 카테고리의 고아 Comment 행만 삭제.  감사 로그에 actor 기록."""
    kind = (payload or {}).get("kind")
    target_type = (payload or {}).get("target_type")
    if kind != "comments" or target_type not in _COMMENT_TARGET_MODELS:
        raise HTTPException(400, "지원하지 않는 정리 대상")
    orphan = await _orphan_comment_ids(db)
    ids = orphan.get(target_type, [])
    if not ids:
        return {"deleted": 0}
    await db.execute(
        models.Comment.__table__.delete().where(models.Comment.id.in_(ids))
    )
    await audit.record(
        db, request, "integrity_cleanup", user_id=actor.id,
        detail=f"comments/{target_type} × {len(ids)}",
    )
    await db.commit()
    return {"deleted": len(ids)}


@router.get("/integrity/files")
async def check_file_integrity(
    db: AsyncSession = Depends(get_db),
    _admin: models.User = Depends(require_admin),
):
    """업로드 디렉터리 vs DB Project 행 정합성 (#114).
    - orphan_dirs: <upload_root>/<id>/... 에 디렉터리는 있지만 Project 행 없음
    - missing_dirs: Project 행은 있는데 디렉터리 없음 (status='ready' 한정)
    """
    from pathlib import Path
    root = Path(settings.rag_upload_dir).expanduser().resolve()
    project_ids = set(
        (
            await db.execute(select(models.Project.id))
        ).scalars().all()
    ) if root.is_dir() else set()

    orphan_dirs: list[dict] = []
    if root.is_dir():
        for child in root.iterdir():
            if not child.is_dir():
                continue
            if child.name not in project_ids:
                # 디스크 사용량 — 최대 10 개 파일만 빠르게 계산.
                size = 0
                files = 0
                for fp in child.rglob("*"):
                    if fp.is_file():
                        try:
                            size += fp.stat().st_size
                        except OSError:
                            continue
                        files += 1
                        if files >= 10_000:
                            break  # 거대한 디렉터리에서 무한 루프 방지
                orphan_dirs.append({
                    "path": str(child),
                    "project_id": child.name,
                    "size_bytes": size,
                    "file_count": files,
                })

    # DB 의 upload 소스 프로젝트 중 디렉터리가 사라진 경우.
    missing_dirs: list[dict] = []
    upload_projects = (
        await db.execute(
            select(models.Project.id, models.Project.name).where(
                models.Project.source_type == "upload",
            )
        )
    ).all() if root.is_dir() else []
    for pid, pname in upload_projects:
        if not (root / pid).is_dir():
            missing_dirs.append({"project_id": pid, "name": pname})
    return {
        "upload_root": str(root),
        "orphan_dirs": orphan_dirs,
        "missing_dirs": missing_dirs,
    }


@router.post("/integrity/files/cleanup")
async def cleanup_orphan_dirs(
    payload: dict,
    request: Request,
    db: AsyncSession = Depends(get_db),
    actor: models.User = Depends(require_admin),
):
    """payload = {project_ids: ['…']}.  '/integrity/files' 가 알려준
    orphan_dirs 중에서 지정된 것만 실제로 rm -rf.  경로 트래버설 가드:
    upload_root 밖이거나 실재 Project 가 있는 디렉터리는 건너뜀."""
    from pathlib import Path
    import shutil

    project_ids = (payload or {}).get("project_ids") or []
    if not isinstance(project_ids, list) or not project_ids:
        raise HTTPException(400, "삭제할 project_id 목록이 비어 있음")
    root = Path(settings.rag_upload_dir).expanduser().resolve()
    if not root.is_dir():
        return {"deleted_dirs": 0, "freed_bytes": 0}

    live_ids = set(
        (
            await db.execute(select(models.Project.id))
        ).scalars().all()
    )
    deleted = 0
    freed = 0
    for pid in project_ids:
        if not isinstance(pid, str) or "/" in pid or ".." in pid:
            continue
        if pid in live_ids:
            continue  # 실재 프로젝트 — 절대 안 지움.
        target = (root / pid).resolve()
        try:
            target.relative_to(root)
        except ValueError:
            continue
        if not target.is_dir():
            continue
        # 크기 측정 후 삭제.
        for fp in target.rglob("*"):
            if fp.is_file():
                try:
                    freed += fp.stat().st_size
                except OSError:
                    pass
        try:
            shutil.rmtree(target)
            deleted += 1
        except OSError:
            continue
    await audit.record(
        db, request, "integrity_cleanup", user_id=actor.id,
        detail=f"orphan-dirs × {deleted} ({freed} bytes)",
    )
    await db.commit()
    return {"deleted_dirs": deleted, "freed_bytes": freed}


# ── 관측/모니터링 (#116~#120) ────────────────────────────────
# 요청 트레이싱 raw 데이터로 slow request 패널, 엔드포인트별 통계, SLO
# 대시보드를 구축.  raw 행은 RequestLogMiddleware 가 만들고, 여기서는
# 읽기 전용 집계만.


@router.get("/requests/slow")
async def list_slow_requests(
    limit: int = 200,
    threshold_ms: int | None = None,
    _staff: models.User = Depends(require_staff),
    db: AsyncSession = Depends(get_db),
):
    """Slow request 로그 (#117).  threshold_ms 를 안 주면
    settings.slow_request_ms (기본 500ms) 사용."""
    th = threshold_ms if threshold_ms is not None else settings.slow_request_ms
    limit = max(1, min(int(limit or 200), 1000))
    rows = (
        await db.execute(
            select(models.RequestLog)
            .where(models.RequestLog.latency_ms >= th)
            .order_by(models.RequestLog.created_at.desc())
            .limit(limit)
        )
    ).scalars().all()
    user_ids = {r.user_id for r in rows if r.user_id}
    emails: dict[str, str] = {}
    if user_ids:
        for uid, em in (
            await db.execute(
                select(models.User.id, models.User.email)
                .where(models.User.id.in_(user_ids))
            )
        ).all():
            emails[uid] = em
    return {
        "threshold_ms": th,
        "items": [
            {
                "id": r.id,
                "method": r.method,
                "path": r.path,
                "status_code": r.status_code,
                "latency_ms": r.latency_ms,
                "user_email": emails.get(r.user_id or "", "—"),
                "ip": r.ip,
                "created_at": r.created_at.isoformat() if r.created_at else None,
            }
            for r in rows
        ],
    }


@router.get("/requests/stats")
async def endpoint_stats(
    hours: int = 24,
    _staff: models.User = Depends(require_staff),
    db: AsyncSession = Depends(get_db),
):
    """엔드포인트별 p50/p95/p99 + 호출 수 + 5xx 비율 (#118).  최근 N
    시간 (기본 24h)."""
    from datetime import datetime as _dt, timedelta as _td
    cutoff = _dt.utcnow() - _td(hours=max(1, min(int(hours), 24 * 30)))
    rows = (
        await db.execute(
            select(
                models.RequestLog.path,
                models.RequestLog.method,
                models.RequestLog.status_code,
                models.RequestLog.latency_ms,
            )
            .where(models.RequestLog.created_at >= cutoff)
        )
    ).all()
    # path+method 묶음으로 집계.
    buckets: dict[tuple[str, str], list[tuple[int, int]]] = {}
    for path, method, status, latency in rows:
        buckets.setdefault((method, path), []).append((status, latency))
    out: list[dict] = []
    for (method, path), entries in buckets.items():
        latencies = sorted(e[1] for e in entries)
        n = len(latencies)
        if n == 0:
            continue
        def _pct(p: float) -> int:
            idx = max(0, min(n - 1, int(p * n / 100)))
            return latencies[idx]
        err = sum(1 for s, _ in entries if s >= 500)
        out.append({
            "method": method,
            "path": path,
            "count": n,
            "p50": _pct(50),
            "p95": _pct(95),
            "p99": _pct(99),
            "errors_5xx": err,
            "error_rate_pct": round(err * 100.0 / n, 2),
        })
    # 호출 수 많은 순.
    out.sort(key=lambda x: x["count"], reverse=True)
    return {"hours": hours, "items": out[:200]}


@router.get("/requests/slo")
async def slo_dashboard(
    _staff: models.User = Depends(require_staff),
    db: AsyncSession = Depends(get_db),
):
    """SLO 대시보드 (#119).  최근 24h / 7d 의 성공율·5xx 비율·평균
    latency 합산 + 시간대별 trend (24h 는 1시간 bucket, 7d 는 1일 bucket).
    """
    from datetime import datetime as _dt, timedelta as _td
    now = _dt.utcnow()

    async def _summary(since: _dt) -> dict:
        rows = (
            await db.execute(
                select(
                    models.RequestLog.status_code,
                    models.RequestLog.latency_ms,
                )
                .where(models.RequestLog.created_at >= since)
            )
        ).all()
        total = len(rows)
        if total == 0:
            return {
                "total": 0, "success_pct": 100.0,
                "error_5xx_pct": 0.0, "avg_latency_ms": 0,
            }
        err = sum(1 for s, _ in rows if s >= 500)
        success = sum(1 for s, _ in rows if s < 400)
        avg_lat = sum(l for _, l in rows) / total
        return {
            "total": total,
            "success_pct": round(success * 100.0 / total, 2),
            "error_5xx_pct": round(err * 100.0 / total, 2),
            "avg_latency_ms": round(avg_lat, 1),
        }

    async def _trend(
        since: _dt, bucket_seconds: int, label_fmt: str,
    ) -> list[dict]:
        rows = (
            await db.execute(
                select(
                    models.RequestLog.created_at,
                    models.RequestLog.status_code,
                    models.RequestLog.latency_ms,
                )
                .where(models.RequestLog.created_at >= since)
                .order_by(models.RequestLog.created_at)
            )
        ).all()
        buckets: dict[str, list[tuple[int, int]]] = {}
        for ts, status, latency in rows:
            # bucket key = ts 를 bucket_seconds 단위로 floor.
            epoch = int(ts.replace(tzinfo=timezone.utc).timestamp())
            floored = epoch - (epoch % bucket_seconds)
            key = _dt.fromtimestamp(floored, tz=timezone.utc).strftime(label_fmt)
            buckets.setdefault(key, []).append((status, latency))
        out = []
        for key in sorted(buckets):
            entries = buckets[key]
            total = len(entries)
            err = sum(1 for s, _ in entries if s >= 500)
            avg_lat = sum(l for _, l in entries) / total if total else 0
            out.append({
                "label": key,
                "total": total,
                "errors_5xx": err,
                "avg_latency_ms": round(avg_lat, 1),
            })
        return out

    return {
        "now": now.isoformat(),
        "h24": await _summary(now - _td(hours=24)),
        "d7": await _summary(now - _td(days=7)),
        "trend_24h": await _trend(now - _td(hours=24), 3600, "%H:00"),
        "trend_7d": await _trend(now - _td(days=7), 86400, "%m-%d"),
    }


# ── 웹훅 알림 (#120) ─────────────────────────────────────────


@router.get("/webhooks/recent")
async def list_recent_webhooks(
    limit: int = 50,
    _admin: models.User = Depends(require_admin),
    db: AsyncSession = Depends(get_db),
):
    """최근 발송된 webhook 결과 — admin 이 '동작했나' 점검할 때."""
    limit = max(1, min(int(limit or 50), 500))
    rows = (
        await db.execute(
            select(models.WebhookDelivery)
            .order_by(models.WebhookDelivery.created_at.desc())
            .limit(limit)
        )
    ).scalars().all()
    return [
        {
            "id": r.id,
            "kind": r.kind,
            "title": r.title,
            "body": r.body,
            "target_url": r.target_url,
            "status": r.status,
            "response_code": r.response_code,
            "error": r.error,
            "attempts": r.attempts,
            "created_at": r.created_at.isoformat() if r.created_at else None,
        }
        for r in rows
    ]


@router.post("/webhooks/test", status_code=204)
async def test_webhook(
    _admin: models.User = Depends(require_admin),
    db: AsyncSession = Depends(get_db),
):
    """현재 settings.webhook_alert_url 로 테스트 알림 발송.  설정이
    안 돼 있으면 400."""
    url = (settings.webhook_alert_url or "").strip()
    if not url:
        raise HTTPException(400, "webhook_alert_url 이 설정돼 있지 않습니다 (.env).")
    from .. import webhook as _wh
    await _wh.dispatch(
        kind="test", title="aichat 웹훅 테스트",
        body="이 메시지는 관리자가 수동으로 보낸 테스트입니다.",
    )
    return


# ── 답변 품질 분석 (#37) ─────────────────────────────────────
# 사용자가 👎 를 누른 어시스턴트 메시지를 한 화면에 모아 운영자가
# 어디서 답변이 부족했는지 점검.  feedback_note 가 있으면 함께,
# 없으면 메시지 본문 앞부분만.

@router.get("/disliked")
async def list_disliked(
    limit: int = 100,
    _staff: models.User = Depends(require_staff),
    db: AsyncSession = Depends(get_db),
):
    limit = max(1, min(int(limit or 100), 500))
    rows = (
        await db.execute(
            select(models.Message, models.Session.title, models.Session.user_id)
            .join(models.Session, models.Session.id == models.Message.session_id)
            .where(models.Message.feedback == -1)
            .order_by(models.Message.created_at.desc())
            .limit(limit)
        )
    ).all()
    user_ids = {uid for _m, _t, uid in rows if uid}
    email_of: dict[str, str] = {}
    if user_ids:
        urows = (
            await db.execute(
                select(models.User.id, models.User.email).where(
                    models.User.id.in_(user_ids)
                )
            )
        ).all()
        email_of = {uid: em for (uid, em) in urows}
    return [
        {
            "message_id": m.id,
            "session_id": m.session_id,
            "session_title": title or "(제목 없음)",
            "user_email": email_of.get(uid or "", "(unknown)"),
            "provider": m.provider,
            "content": (m.content or "")[:600],
            "feedback_note": m.feedback_note,
            "created_at": m.created_at.isoformat() if m.created_at else None,
        }
        for (m, title, uid) in rows
    ]


# ── 시스템 헬스 (#39) ─────────────────────────────────────────
# 관리자 헤더 인디케이터용.  Ollama / Qdrant / DB / 최근 에러 카운트
# 를 한 번의 호출로 받아 가벼운 점등 표시.

@router.get("/health")
async def health_check(
    _staff: models.User = Depends(require_staff),
    db: AsyncSession = Depends(get_db),
):
    import asyncio as _asyncio
    import httpx as _httpx
    from datetime import datetime as _dt, timedelta as _td

    from ..config import settings as _settings

    async def _ollama() -> dict:
        try:
            timeout = _httpx.Timeout(3.5, connect=1.5)
            async with _httpx.AsyncClient(timeout=timeout) as client:
                t0 = _dt.utcnow()
                r = await client.get(f"{_settings.ollama_base_url}/api/tags")
                ms = int((_dt.utcnow() - t0).total_seconds() * 1000)
                if r.status_code >= 400:
                    return {"ok": False, "error": f"HTTP {r.status_code}", "latency_ms": ms}
                models_n = len((r.json() or {}).get("models") or [])
                return {"ok": True, "latency_ms": ms, "models": models_n}
        except Exception as exc:  # noqa: BLE001
            return {"ok": False, "error": f"{type(exc).__name__}: {exc}"}

    async def _qdrant() -> dict:
        try:
            url = getattr(_settings, "qdrant_url", None) or "http://localhost:6333"
            timeout = _httpx.Timeout(3.5, connect=1.5)
            async with _httpx.AsyncClient(timeout=timeout) as client:
                t0 = _dt.utcnow()
                r = await client.get(f"{url}/collections")
                ms = int((_dt.utcnow() - t0).total_seconds() * 1000)
                if r.status_code >= 400:
                    return {"ok": False, "error": f"HTTP {r.status_code}", "latency_ms": ms}
                cols = ((r.json() or {}).get("result") or {}).get("collections") or []
                return {"ok": True, "latency_ms": ms, "collections": len(cols)}
        except Exception as exc:  # noqa: BLE001
            return {"ok": False, "error": f"{type(exc).__name__}: {exc}"}

    async def _db_ping() -> dict:
        try:
            from sqlalchemy import text as _text
            t0 = _dt.utcnow()
            await db.execute(_text("SELECT 1"))
            ms = int((_dt.utcnow() - t0).total_seconds() * 1000)
            return {"ok": True, "latency_ms": ms}
        except Exception as exc:  # noqa: BLE001
            return {"ok": False, "error": f"{type(exc).__name__}: {exc}"}

    cutoff = _dt.utcnow() - _td(hours=24)
    err_24h = await db.scalar(
        select(func.count(models.ErrorLog.id)).where(
            models.ErrorLog.created_at >= cutoff
        )
    )

    ollama, qdrant, dbping = await _asyncio.gather(
        _ollama(), _qdrant(), _db_ping()
    )
    return {
        "ollama": ollama,
        "qdrant": qdrant,
        "db": dbping,
        "errors_24h": int(err_24h or 0),
        "checked_at": _dt.utcnow().isoformat(),
    }


# ── 사용자별 사용량 통계 (#41) ───────────────────────────────
# 각 사용자가 얼마나 많은 메시지를 보내고 토큰을 소비했는지 한눈에.
# 운영자가 부하 / 비정상 사용을 점검할 때 사용.

@router.get("/usage")
async def usage_per_user(
    limit: int = 200,
    days: int = 30,
    _staff: models.User = Depends(require_staff),
    db: AsyncSession = Depends(get_db),
):
    from datetime import datetime as _dt, timedelta as _td

    limit = max(1, min(int(limit or 200), 1000))
    days = max(1, min(int(days or 30), 365))
    cutoff = _dt.utcnow() - _td(days=days)

    # 사용자별 집계: 메시지 수, 어시스턴트 토큰 합, 평균 latency,
    # 마지막 활동.  Session.user_id 가 NULL 인 옛 행은 (anon) 으로.
    rows = (
        await db.execute(
            select(
                models.User.id,
                models.User.email,
                models.User.name,
                func.count(models.Message.id).label("msg_count"),
                func.coalesce(func.sum(models.Message.tokens_out), 0).label("tokens"),
                func.avg(models.Message.latency_ms).label("avg_latency"),
                func.max(models.Message.created_at).label("last_at"),
            )
            .join(models.Session, models.Session.user_id == models.User.id)
            .join(models.Message, models.Message.session_id == models.Session.id)
            .where(models.Message.created_at >= cutoff)
            .group_by(models.User.id, models.User.email, models.User.name)
            .order_by(func.count(models.Message.id).desc())
            .limit(limit)
        )
    ).all()
    return {
        "days": days,
        "items": [
            {
                "user_id": uid,
                "email": email,
                "name": name,
                "message_count": int(mc or 0),
                "tokens_out_sum": int(tk or 0),
                "avg_latency_ms": int(avg or 0) if avg else None,
                "last_activity": last.isoformat() if last else None,
            }
            for (uid, email, name, mc, tk, avg, last) in rows
        ],
    }


# ── 자동 백업 스케줄 (#44) ──────────────────────────────────
# 매 시간 정각마다 wakeup. settings.backup_auto_enabled + backup_auto_
# hour (KST 기준 0~23) 가 활성이면 그 시각에 백업 + 오래된 파일 청소.
# lifespan 이 한 번만 띄움.

_backup_scheduler_started = False


async def backup_scheduler_loop() -> None:
    """매 분마다 깨어나 '오늘 그 시간이 됐고 아직 자동 백업이 안 됐으면'
    백업 실행.  파일명 패턴 'aichat-YYYYMMDD-...-auto.db' 로 표시."""
    import asyncio as _aio
    import shutil
    import sqlite3
    from datetime import datetime as _dt, time as _time
    from pathlib import Path as _Path

    log_local = __import__("logging").getLogger("uvicorn.error")
    while True:
        try:
            if not getattr(settings, "backup_auto_enabled", False):
                await _aio.sleep(60 * 30)
                continue
            hour = int(getattr(settings, "backup_auto_hour", 3))
            now = _dt.now()
            base = _resolve_backup_dir()
            today_stamp = now.strftime("%Y%m%d")
            already = base.exists() and any(
                f.name.startswith(f"aichat-{today_stamp}") and f.name.endswith("-auto.db")
                for f in base.iterdir()
            )
            if now.time() >= _time(hour, 0) and not already:
                url = settings.database_url
                if "sqlite" in url and ":///" in url:
                    raw_db = url.split(":///", 1)[1]
                    db_path = _Path(raw_db).expanduser()
                    if not db_path.is_absolute():
                        from .. import __file__ as _app_init

                        backend_root = _Path(_app_init).resolve().parent.parent
                        db_path = (backend_root / db_path).resolve()
                    if db_path.is_file():
                        try:
                            base.mkdir(parents=True, exist_ok=True)
                            try:
                                c = sqlite3.connect(str(db_path), timeout=10)
                                try:
                                    c.execute("PRAGMA wal_checkpoint(TRUNCATE)")
                                finally:
                                    c.close()
                            except sqlite3.Error:
                                pass
                            target = base / (
                                f"aichat-{today_stamp}-"
                                f"{now.strftime('%H%M%S')}-auto.db"
                            )
                            shutil.copy2(str(db_path), str(target))
                            log_local.info("auto backup → %s", target)
                            # Retention 청소 — 기본 14 일 유지.
                            keep_days = int(
                                getattr(settings, "backup_auto_keep_days", 14)
                            )
                            cutoff_ts = (
                                _dt.utcnow().timestamp() - keep_days * 86400
                            )
                            for f in base.iterdir():
                                if not f.name.endswith("-auto.db"):
                                    continue
                                if f.stat().st_mtime < cutoff_ts:
                                    try:
                                        f.unlink()
                                    except OSError:
                                        pass
                        except Exception as exc:  # noqa: BLE001
                            log_local.warning("auto backup failed: %s", exc)
        except Exception as exc:  # noqa: BLE001
            log_local.warning("backup scheduler tick failed: %s", exc)
        await _aio.sleep(60)


def start_backup_scheduler() -> None:
    """lifespan 에서 한 번만 호출.  asyncio.create_task 로 백그라운드 실행."""
    global _backup_scheduler_started
    if _backup_scheduler_started:
        return
    _backup_scheduler_started = True
    import asyncio as _aio

    _aio.create_task(backup_scheduler_loop())
