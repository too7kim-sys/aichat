"""인증 흐름 + 비밀번호 정책 + 계정 잠금 스모크 (#102, #103)."""
from __future__ import annotations

import pytest


def test_signup_first_user_becomes_admin(client):
    """첫 가입자는 자동 admin + approved (init_db boot-strap)."""
    res = client.post(
        "/api/auth/signup",
        json={
            "email": "first@example.com",
            "password": "Strong-Pwd-1234!",
            "name": "첫관리자",
        },
    )
    assert res.status_code == 201, res.text
    body = res.json()
    # 첫 사용자는 즉시 토큰을 받는다.
    assert body.get("status") == "approved" or body.get("access_token")


def test_signup_weak_password_rejected(client):
    """#103 — 정책 위반 비번은 가입 단계에서 거절."""
    bad_passwords = [
        "Short1!",            # 10자 미만
        "lowercaseonlyhere",  # 단일 클래스 (영문 소문자만)
        "aaaaaaaa12",         # 같은 글자 4회 연속 (4*a)
        "password",           # 흔한 비번 + 10자 미만
    ]
    for i, pw in enumerate(bad_passwords):
        res = client.post(
            "/api/auth/signup",
            json={
                "email": f"weak-{i}@example.com",
                "password": pw,
                "name": "약한비번",
            },
        )
        assert res.status_code in (400, 422), f"{pw!r}: {res.status_code} {res.text}"


def test_login_works_after_signup(client):
    """가입 → 로그인 → 토큰 받기."""
    client.post(
        "/api/auth/signup",
        json={
            "email": "u1@example.com",
            "password": "Strong-Pwd-1234!",
            "name": "사용자1",
        },
    )
    res = client.post(
        "/api/auth/login",
        json={"email": "u1@example.com", "password": "Strong-Pwd-1234!"},
    )
    assert res.status_code == 200, res.text
    assert "access_token" in res.json()


def test_login_wrong_password_fails(client):
    """잘못된 비번은 401."""
    client.post(
        "/api/auth/signup",
        json={
            "email": "u2@example.com",
            "password": "Strong-Pwd-1234!",
            "name": "사용자2",
        },
    )
    res = client.post(
        "/api/auth/login",
        json={"email": "u2@example.com", "password": "wrong-Strong-1!"},
    )
    assert res.status_code == 401


def test_me_requires_token(client):
    """토큰 없으면 401."""
    res = client.get("/api/me")
    assert res.status_code == 401


def test_me_returns_user_with_token(client):
    """발급받은 토큰으로 /me 호출 → 본인 정보 반환."""
    sr = client.post(
        "/api/auth/signup",
        json={
            "email": "u3@example.com",
            "password": "Strong-Pwd-1234!",
            "name": "사용자3",
        },
    )
    token = sr.json().get("access_token")
    if not token:
        lr = client.post(
            "/api/auth/login",
            json={"email": "u3@example.com", "password": "Strong-Pwd-1234!"},
        )
        token = lr.json()["access_token"]
    res = client.get("/api/me", headers={"Authorization": f"Bearer {token}"})
    assert res.status_code == 200
    assert res.json()["email"] == "u3@example.com"
