from fastapi import APIRouter, Depends, HTTPException, Request
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from .. import audit, models, schemas, tokens
from ..auth import (
    create_access_token,
    dummy_verify,
    get_current_user,
    hash_password,
    verify_password,
)
from ..config import settings
from ..database import get_db
from ..email import send_reset_email, send_verify_email
from ..security import validate_password
from ._rate_limit import enforce_rate_limit

router = APIRouter(prefix="/api/auth", tags=["auth"])


@router.post("/signup", response_model=schemas.AuthResponse, status_code=201)
async def signup(
    payload: schemas.SignupRequest,
    request: Request,
    db: AsyncSession = Depends(get_db),
):
    enforce_rate_limit("signup", request, limit=5, window_seconds=600)
    email = payload.email.lower()

    try:
        validate_password(payload.password, email=email, name=payload.name)
    except ValueError as exc:
        await audit.record(
            db, request, audit.SIGNUP_FAIL, detail=f"weak password / {email}"
        )
        await db.commit()
        raise HTTPException(400, str(exc))

    existing = (
        await db.execute(select(models.User).where(models.User.email == email))
    ).scalar_one_or_none()
    if existing is not None:
        await audit.record(
            db, request, audit.SIGNUP_FAIL, detail=f"duplicate email / {email}"
        )
        await db.commit()
        raise HTTPException(409, "이미 가입된 이메일입니다")

    user = models.User(
        email=email,
        password_hash=hash_password(payload.password),
        name=payload.name.strip(),
    )
    db.add(user)
    await db.flush()  # populate user.id for the audit row
    await audit.record(db, request, audit.SIGNUP, user_id=user.id)
    verify_raw = await tokens.issue(
        db, user, tokens.KIND_VERIFY, hours=settings.verify_token_hours
    )
    await db.commit()
    await db.refresh(user)
    try:
        await send_verify_email(user.email, user.name, verify_raw)
    except Exception:
        # Send failure shouldn't block signup; the user can request a
        # resend from the verification banner.
        pass
    access, expires = create_access_token(user.id)
    return schemas.AuthResponse(user=user, access_token=access, expires_at=expires)


@router.post("/login", response_model=schemas.AuthResponse)
async def login(
    payload: schemas.LoginRequest,
    request: Request,
    db: AsyncSession = Depends(get_db),
):
    enforce_rate_limit("login", request, limit=10, window_seconds=60)
    email = payload.email.lower()
    user = (
        await db.execute(select(models.User).where(models.User.email == email))
    ).scalar_one_or_none()
    # Equalise timing whether or not the email exists.
    if user is None:
        dummy_verify()
        await audit.record(
            db, request, audit.LOGIN_FAIL, detail=f"unknown email / {email}"
        )
        await db.commit()
        raise HTTPException(401, "이메일 또는 비밀번호가 올바르지 않습니다")
    if not verify_password(payload.password, user.password_hash):
        await audit.record(
            db, request, audit.LOGIN_FAIL, user_id=user.id, detail="bad password"
        )
        await db.commit()
        raise HTTPException(401, "이메일 또는 비밀번호가 올바르지 않습니다")

    await audit.record(db, request, audit.LOGIN_OK, user_id=user.id)
    await db.commit()
    access, expires = create_access_token(user.id)
    return schemas.AuthResponse(user=user, access_token=access, expires_at=expires)


# ── Email verification ────────────────────────────────────────────


@router.post("/verify-email/send", status_code=204)
async def resend_verify_email(
    request: Request,
    user: models.User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    enforce_rate_limit(
        "verify-resend", request, limit=5, window_seconds=600
    )
    if user.email_verified:
        raise HTTPException(400, "이미 인증된 이메일입니다")
    raw = await tokens.issue(
        db, user, tokens.KIND_VERIFY, hours=settings.verify_token_hours
    )
    await db.commit()
    try:
        await send_verify_email(user.email, user.name, raw)
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(502, f"메일 전송 실패: {type(exc).__name__}")


@router.post("/verify-email", response_model=schemas.UserOut)
async def verify_email(
    payload: schemas.VerifyRequest,
    request: Request,
    db: AsyncSession = Depends(get_db),
):
    enforce_rate_limit("verify-consume", request, limit=20, window_seconds=600)
    user = await tokens.consume(db, payload.token, tokens.KIND_VERIFY)
    if user is None:
        raise HTTPException(400, "유효하지 않거나 만료된 인증 링크입니다")
    user.email_verified = True
    await audit.record(db, request, "email_verified", user_id=user.id)
    await db.commit()
    await db.refresh(user)
    return user


# ── Password reset ────────────────────────────────────────────────


@router.post("/password-reset/request", status_code=204)
async def request_password_reset(
    payload: schemas.PasswordResetRequest,
    request: Request,
    db: AsyncSession = Depends(get_db),
):
    enforce_rate_limit(
        "password-reset", request, limit=5, window_seconds=600
    )
    email = payload.email.lower()
    user = (
        await db.execute(select(models.User).where(models.User.email == email))
    ).scalar_one_or_none()
    # Always succeed silently so the response doesn't reveal whether the
    # email is registered.
    if user is None:
        return
    raw = await tokens.issue(
        db, user, tokens.KIND_RESET, hours=settings.reset_token_hours
    )
    await audit.record(
        db, request, "password_reset_request", user_id=user.id
    )
    await db.commit()
    try:
        await send_reset_email(user.email, user.name, raw)
    except Exception:
        # Don't surface delivery failures to the requester — that would
        # also leak enumeration. Operators see it in the server log.
        pass


@router.post("/password-reset/confirm", response_model=schemas.AuthResponse)
async def confirm_password_reset(
    payload: schemas.PasswordResetConfirm,
    request: Request,
    db: AsyncSession = Depends(get_db),
):
    enforce_rate_limit(
        "password-reset-confirm", request, limit=20, window_seconds=600
    )
    user = await tokens.consume(db, payload.token, tokens.KIND_RESET)
    if user is None:
        raise HTTPException(400, "유효하지 않거나 만료된 재설정 링크입니다")
    try:
        validate_password(payload.new_password, email=user.email, name=user.name)
    except ValueError as exc:
        # Token is already consumed; failing here is fine because the
        # user just needs to request another link.
        raise HTTPException(400, str(exc))
    user.password_hash = hash_password(payload.new_password)
    # A password reset proves email control, so mark the account verified
    # if it wasn't already.
    user.email_verified = True
    await audit.record(db, request, "password_reset_complete", user_id=user.id)
    await db.commit()
    await db.refresh(user)
    access, expires = create_access_token(user.id)
    return schemas.AuthResponse(user=user, access_token=access, expires_at=expires)


# ── /me ────────────────────────────────────────────────────────────

me_router = APIRouter(prefix="/api/me", tags=["me"])


@me_router.get("", response_model=schemas.UserOut)
async def get_me(user: models.User = Depends(get_current_user)):
    return user


@me_router.patch("", response_model=schemas.UserOut)
async def update_me(
    payload: schemas.UserUpdate,
    request: Request,
    user: models.User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    if payload.name is not None and payload.name.strip() != user.name:
        user.name = payload.name.strip()
        await audit.record(db, request, audit.NAME_CHANGE, user_id=user.id)

    if payload.new_password:
        if not payload.current_password or not verify_password(
            payload.current_password, user.password_hash
        ):
            raise HTTPException(400, "현재 비밀번호가 올바르지 않습니다")
        try:
            validate_password(
                payload.new_password, email=user.email, name=user.name
            )
        except ValueError as exc:
            raise HTTPException(400, str(exc))
        user.password_hash = hash_password(payload.new_password)
        await audit.record(db, request, audit.PASSWORD_CHANGE, user_id=user.id)

    await db.commit()
    await db.refresh(user)
    return user


@me_router.delete("", status_code=204)
async def delete_me(
    request: Request,
    user: models.User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    user_id = user.id
    # Audit row references the user; commit it first so it survives the
    # cascade delete (we explicitly null user_id on the surviving row).
    await audit.record(db, request, audit.ACCOUNT_DELETE, user_id=None,
                       detail=f"id={user_id}")
    await db.delete(user)
    await db.commit()


@me_router.get("/audit", response_model=list[schemas.AuditEvent])
async def my_audit(
    user: models.User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
    limit: int = 50,
):
    if limit < 1:
        limit = 50
    if limit > 200:
        limit = 200
    rows = (
        await db.execute(
            select(models.AuditLog)
            .where(models.AuditLog.user_id == user.id)
            .order_by(models.AuditLog.created_at.desc())
            .limit(limit)
        )
    ).scalars().all()
    return rows
