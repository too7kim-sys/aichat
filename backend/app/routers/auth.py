from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from .. import models, schemas
from ..auth import (
    create_access_token,
    get_current_user,
    hash_password,
    verify_password,
)
from ..database import get_db

router = APIRouter(prefix="/api/auth", tags=["auth"])


@router.post("/signup", response_model=schemas.AuthResponse, status_code=201)
async def signup(
    payload: schemas.SignupRequest, db: AsyncSession = Depends(get_db)
):
    email = payload.email.lower()
    existing = (
        await db.execute(select(models.User).where(models.User.email == email))
    ).scalar_one_or_none()
    if existing is not None:
        raise HTTPException(409, "이미 가입된 이메일입니다")

    user = models.User(
        email=email,
        password_hash=hash_password(payload.password),
        name=payload.name.strip(),
    )
    db.add(user)
    await db.commit()
    await db.refresh(user)
    token, expires = create_access_token(user.id)
    return schemas.AuthResponse(user=user, access_token=token, expires_at=expires)


@router.post("/login", response_model=schemas.AuthResponse)
async def login(payload: schemas.LoginRequest, db: AsyncSession = Depends(get_db)):
    email = payload.email.lower()
    user = (
        await db.execute(select(models.User).where(models.User.email == email))
    ).scalar_one_or_none()
    if user is None or not verify_password(payload.password, user.password_hash):
        raise HTTPException(401, "이메일 또는 비밀번호가 올바르지 않습니다")
    token, expires = create_access_token(user.id)
    return schemas.AuthResponse(user=user, access_token=token, expires_at=expires)


# ── /me ────────────────────────────────────────────────────────────

me_router = APIRouter(prefix="/api/me", tags=["me"])


@me_router.get("", response_model=schemas.UserOut)
async def get_me(user: models.User = Depends(get_current_user)):
    return user


@me_router.patch("", response_model=schemas.UserOut)
async def update_me(
    payload: schemas.UserUpdate,
    user: models.User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    if payload.name is not None:
        user.name = payload.name.strip()
    if payload.new_password:
        if not payload.current_password or not verify_password(
            payload.current_password, user.password_hash
        ):
            raise HTTPException(400, "현재 비밀번호가 올바르지 않습니다")
        user.password_hash = hash_password(payload.new_password)
    await db.commit()
    await db.refresh(user)
    return user


@me_router.delete("", status_code=204)
async def delete_me(
    user: models.User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    await db.delete(user)
    await db.commit()
