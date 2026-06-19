"""세션 CRUD 스모크 — 가장 핵심 사용자 경로."""
from __future__ import annotations


def _auth_header(client):
    sr = client.post(
        "/api/auth/signup",
        json={
            "email": "admin@example.com",
            "password": "Strong-Pwd-1234!",
            "name": "관리자",
        },
    )
    token = sr.json()["access_token"]
    return {"Authorization": f"Bearer {token}"}


def test_list_sessions_empty(client):
    """새 사용자는 세션 목록이 비어 있음."""
    h = _auth_header(client)
    res = client.get("/api/sessions", headers=h)
    assert res.status_code == 200
    assert res.json() == []


def test_create_session(client):
    """POST /sessions 로 빈 세션 생성."""
    h = _auth_header(client)
    res = client.post(
        "/api/sessions",
        headers=h,
        json={"title": "테스트 대화"},
    )
    assert res.status_code in (200, 201), res.text
    body = res.json()
    assert body["title"] == "테스트 대화"
    assert "id" in body


def test_get_session(client):
    """단일 세션 조회 — 메시지 없는 상태."""
    h = _auth_header(client)
    r = client.post("/api/sessions", headers=h, json={"title": "X"})
    sid = r.json()["id"]
    res = client.get(f"/api/sessions/{sid}", headers=h)
    assert res.status_code == 200
    body = res.json()
    assert body["id"] == sid
    assert body["messages"] == []


def test_delete_session_to_trash(client):
    """DELETE 는 휴지통으로 이동 (#31)."""
    h = _auth_header(client)
    r = client.post("/api/sessions", headers=h, json={"title": "Y"})
    sid = r.json()["id"]
    res = client.delete(f"/api/sessions/{sid}", headers=h)
    assert res.status_code in (200, 204)
    # 활성 목록엔 없음
    listing = client.get("/api/sessions", headers=h).json()
    assert all(s["id"] != sid for s in listing)


def test_session_isolation(client):
    """A 사용자가 B 사용자 세션을 볼 수 없음 (cross-tenant 차단)."""
    # admin 가입
    h_admin = _auth_header(client)
    r = client.post("/api/sessions", headers=h_admin, json={"title": "Admin 세션"})
    sid = r.json()["id"]
    # 두 번째 사용자 가입
    sr = client.post(
        "/api/auth/signup",
        json={
            "email": "user@example.com",
            "password": "Strong-Pwd-1234!",
            "name": "사용자",
        },
    )
    h_user = {"Authorization": f"Bearer {sr.json()['access_token']}"}
    # 사용자 B 가 admin 세션 조회 시 403/404 — 어느 쪽이든 거부면 OK.
    res = client.get(f"/api/sessions/{sid}", headers=h_user)
    assert res.status_code in (403, 404), res.text
