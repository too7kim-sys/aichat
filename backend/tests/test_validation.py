"""6차 다듬기 — Query bounds 가 실제로 422 를 떨어뜨리는지 회귀 테스트.
이전엔 silently 클램프돼서 잘못된 입력이 그냥 짤렸음."""
from __future__ import annotations


def _auth_header(client):
    """가입+로그인 — 첫 사용자는 자동 admin."""
    sr = client.post(
        "/api/auth/signup",
        json={
            "email": "admin@example.com",
            "password": "Strong-Pwd-1234!",
            "name": "관리자",
        },
    )
    token = sr.json().get("access_token")
    if not token:
        lr = client.post(
            "/api/auth/login",
            json={"email": "admin@example.com", "password": "Strong-Pwd-1234!"},
        )
        token = lr.json()["access_token"]
    return {"Authorization": f"Bearer {token}"}


def test_audit_limit_upper_bound_rejected(client):
    """limit=999999 같은 폭주값은 422 — 이전엔 silently 500 으로 clamp."""
    h = _auth_header(client)
    res = client.get("/api/admin/audit?limit=999999", headers=h)
    assert res.status_code == 422


def test_audit_limit_zero_rejected(client):
    """limit=0 도 ge=1 위반."""
    h = _auth_header(client)
    res = client.get("/api/admin/audit?limit=0", headers=h)
    assert res.status_code == 422


def test_audit_limit_valid_passes(client):
    """경계값 1, 500 은 통과."""
    h = _auth_header(client)
    for n in (1, 500):
        res = client.get(f"/api/admin/audit?limit={n}", headers=h)
        assert res.status_code == 200, f"limit={n}: {res.text}"


def test_users_limit_upper_bound(client):
    """admin/users 도 동일하게 le=500."""
    h = _auth_header(client)
    res = client.get("/api/admin/users?limit=99999", headers=h)
    assert res.status_code == 422
    res2 = client.get("/api/admin/users?limit=100", headers=h)
    assert res2.status_code == 200


def test_my_audit_limit_bounds(client):
    """일반 사용자도 자기 audit 호출하는 limit 검증."""
    h = _auth_header(client)
    res = client.get("/api/me/audit?limit=99999", headers=h)
    assert res.status_code == 422
    res2 = client.get("/api/me/audit?limit=50", headers=h)
    assert res2.status_code == 200
