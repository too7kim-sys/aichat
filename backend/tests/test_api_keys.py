"""API 키 (#45) 발급 / 만료 / 회수 / 인증 헤더 가드.

핵심:
  · 발급 시 평문 토큰은 응답에 한 번만.  GET 목록은 token_prefix 만.
  · X-API-Key 헤더로 Bearer 없이 인증 가능.
  · expires_at 지나면 lookup 단계에서 거절 (만료된 키는 화석화).
"""
from __future__ import annotations


def _admin_header(client):
    sr = client.post(
        "/api/auth/signup",
        json={
            "email": "admin@example.com",
            "password": "Strong-Pwd-1234!",
            "name": "관리자",
        },
    )
    return {"Authorization": f"Bearer {sr.json()['access_token']}"}


def test_create_key_returns_plaintext_token_once(client):
    """발급 직후만 평문 token 노출, 이후 list 호출엔 token 자체 없음."""
    h = _admin_header(client)
    res = client.post("/api/keys", headers=h, json={"label": "n8n"})
    assert res.status_code == 200, res.text
    body = res.json()
    assert body["token"].startswith("aichat_")
    assert body["label"] == "n8n"
    assert body["token_prefix"] == body["token"][:12]

    rows = client.get("/api/keys", headers=h).json()
    assert any(r["id"] == body["id"] for r in rows)
    # 목록에는 평문 token 이 절대 안 나와야.
    for r in rows:
        assert "token" not in r


def test_create_key_with_expiry_sets_expires_at(client):
    """expires_days 30 → expires_at 채워서 응답."""
    h = _admin_header(client)
    res = client.post(
        "/api/keys", headers=h,
        json={"label": "ci-bot", "expires_days": 30},
    )
    assert res.status_code == 200
    assert res.json()["expires_at"] is not None


def test_x_api_key_authenticates(client):
    """평문 토큰을 X-API-Key 로 보내면 Bearer 없이 본인 컨텍스트로 인증."""
    h = _admin_header(client)
    tk = client.post("/api/keys", headers=h, json={"label": "bot"}).json()["token"]
    res = client.get("/api/me", headers={"X-API-Key": tk})
    assert res.status_code == 200, res.text
    assert res.json()["email"] == "admin@example.com"


def test_x_api_key_invalid_rejected(client):
    """엉뚱한 토큰은 401."""
    _admin_header(client)
    res = client.get(
        "/api/me", headers={"X-API-Key": "aichat_nope-not-a-real-token"},
    )
    assert res.status_code == 401


def test_revoked_key_rejected(client):
    """회수된 키는 다음 호출부터 401."""
    h = _admin_header(client)
    created = client.post(
        "/api/keys", headers=h, json={"label": "temp"},
    ).json()
    tk = created["token"]
    kid = created["id"]
    # 회수 전엔 OK.
    assert client.get("/api/me", headers={"X-API-Key": tk}).status_code == 200
    # 회수.
    assert client.delete(f"/api/keys/{kid}", headers=h).status_code == 204
    # 회수 후엔 401.
    assert client.get("/api/me", headers={"X-API-Key": tk}).status_code == 401


def test_expired_key_rejected_at_lookup(client):
    """expires_at 가 과거인 키는 lookup 단계에서 거절.  DB 에 직접 만료
    시각을 박아 시간 흐름을 시뮬레이션."""
    import asyncio
    from datetime import datetime, timedelta
    from sqlalchemy import select, update
    from app import models
    from app.database import SessionLocal

    h = _admin_header(client)
    tk_resp = client.post(
        "/api/keys", headers=h, json={"label": "expiring", "expires_days": 1},
    ).json()
    tk = tk_resp["token"]
    kid = tk_resp["id"]

    async def _expire():
        async with SessionLocal() as db:
            await db.execute(
                update(models.ApiKey)
                .where(models.ApiKey.id == kid)
                .values(expires_at=datetime.utcnow() - timedelta(hours=1))
            )
            await db.commit()

    asyncio.new_event_loop().run_until_complete(_expire())

    res = client.get("/api/me", headers={"X-API-Key": tk})
    assert res.status_code == 401


def test_other_user_cannot_revoke_my_key(client):
    """A 가 발급한 키를 B 가 회수하려고 하면 404 (행 자체가 안 보임)."""
    h_admin = _admin_header(client)
    kid = client.post(
        "/api/keys", headers=h_admin, json={"label": "mine"},
    ).json()["id"]

    other = client.post(
        "/api/auth/signup",
        json={
            "email": "other@example.com",
            "password": "Strong-Pwd-1234!",
            "name": "타인",
        },
    )
    h_other = {"Authorization": f"Bearer {other.json()['access_token']}"}
    res = client.delete(f"/api/keys/{kid}", headers=h_other)
    assert res.status_code == 404
