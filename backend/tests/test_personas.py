"""챗봇 페르소나 CRUD + 세션 적용 (#125)."""
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


def test_list_personas_empty(client):
    h = _admin_header(client)
    res = client.get("/api/personas", headers=h)
    assert res.status_code == 200
    assert res.json() == []


def test_create_persona(client):
    h = _admin_header(client)
    res = client.post(
        "/api/personas",
        headers=h,
        json={
            "name": "코드 리뷰어",
            "description": "꼼꼼한 코드 리뷰",
            "emoji": "🔍",
            "system_prompt": "당신은 시니어 코드 리뷰어입니다. 모든 답변에서 보안·성능·가독성을 평가하세요.",
            "is_shared": False,
        },
    )
    assert res.status_code == 201, res.text
    body = res.json()
    assert body["name"] == "코드 리뷰어"
    assert body["emoji"] == "🔍"
    assert body["owned"] is True


def test_persona_visible_after_create(client):
    h = _admin_header(client)
    client.post(
        "/api/personas",
        headers=h,
        json={
            "name": "마케터",
            "system_prompt": "마케팅 카피라이터",
            "description": "",
            "emoji": "",
            "is_shared": False,
        },
    )
    listing = client.get("/api/personas", headers=h).json()
    assert any(p["name"] == "마케터" for p in listing)


def test_persona_shared_admin_only(client):
    """is_shared=True 는 admin/moderator 만 만들 수 있어야."""
    # 첫 가입자는 admin — 통과해야.
    h = _admin_header(client)
    res = client.post(
        "/api/personas",
        headers=h,
        json={
            "name": "공용 페르소나",
            "system_prompt": "x",
            "description": "",
            "emoji": "",
            "is_shared": True,
        },
    )
    assert res.status_code == 201, res.text


def test_update_persona(client):
    h = _admin_header(client)
    create = client.post(
        "/api/personas",
        headers=h,
        json={
            "name": "원래",
            "system_prompt": "원래 본문",
            "description": "",
            "emoji": "",
            "is_shared": False,
        },
    ).json()
    pid = create["id"]
    res = client.patch(
        f"/api/personas/{pid}",
        headers=h,
        json={
            "name": "변경",
            "system_prompt": "새 본문",
            "description": "",
            "emoji": "✨",
            "is_shared": False,
        },
    )
    assert res.status_code == 200, res.text
    assert res.json()["name"] == "변경"
    assert res.json()["emoji"] == "✨"


def test_delete_persona(client):
    h = _admin_header(client)
    create = client.post(
        "/api/personas",
        headers=h,
        json={
            "name": "지울 페르소나",
            "system_prompt": "x",
            "description": "",
            "emoji": "",
            "is_shared": False,
        },
    ).json()
    pid = create["id"]
    res = client.delete(f"/api/personas/{pid}", headers=h)
    assert res.status_code == 204
    # 사라졌어야.
    assert all(p["id"] != pid for p in client.get("/api/personas", headers=h).json())


def test_apply_persona_to_session(client):
    """세션 PATCH 로 페르소나 변경 + GET 으로 확인."""
    h = _admin_header(client)
    # 페르소나 생성
    persona = client.post(
        "/api/personas",
        headers=h,
        json={
            "name": "리뷰어",
            "system_prompt": "x",
            "description": "",
            "emoji": "",
            "is_shared": False,
        },
    ).json()
    pid = persona["id"]
    # 세션 생성
    sess = client.post("/api/sessions", headers=h, json={"title": "T"}).json()
    sid = sess["id"]
    assert sess["persona_id"] is None
    # PATCH 적용
    res = client.patch(
        f"/api/sessions/{sid}",
        headers=h,
        json={"persona_id": pid},
    )
    assert res.status_code == 200, res.text
    assert res.json()["persona_id"] == pid


def test_apply_unknown_persona_400(client):
    """없는 페르소나 ID 적용은 400."""
    h = _admin_header(client)
    sess = client.post("/api/sessions", headers=h, json={"title": "T"}).json()
    sid = sess["id"]
    res = client.patch(
        f"/api/sessions/{sid}",
        headers=h,
        json={"persona_id": "00000000-0000-0000-0000-000000000000"},
    )
    assert res.status_code == 400


def test_create_session_with_persona(client):
    """POST /sessions 가 처음부터 persona_id 받음."""
    h = _admin_header(client)
    persona = client.post(
        "/api/personas",
        headers=h,
        json={
            "name": "처음부터",
            "system_prompt": "x",
            "description": "",
            "emoji": "",
            "is_shared": False,
        },
    ).json()
    res = client.post(
        "/api/sessions",
        headers=h,
        json={"title": "P", "persona_id": persona["id"]},
    )
    assert res.status_code == 200, res.text
    assert res.json()["persona_id"] == persona["id"]


def test_persona_validation(client):
    """system_prompt 길이 + name 필수."""
    h = _admin_header(client)
    # name 누락
    res = client.post(
        "/api/personas",
        headers=h,
        json={"system_prompt": "x", "description": "", "emoji": "", "is_shared": False},
    )
    assert res.status_code == 422
    # system_prompt 누락
    res = client.post(
        "/api/personas",
        headers=h,
        json={"name": "x", "description": "", "emoji": "", "is_shared": False},
    )
    assert res.status_code == 422
