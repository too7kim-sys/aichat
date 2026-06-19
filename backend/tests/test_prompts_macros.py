"""프롬프트 + 매크로 CRUD 스모크."""
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


def test_list_prompts_empty(client):
    h = _admin_header(client)
    res = client.get("/api/prompts", headers=h)
    assert res.status_code == 200
    assert res.json() == []


def test_create_prompt(client):
    h = _admin_header(client)
    res = client.post(
        "/api/prompts",
        headers=h,
        json={
            "code": "test-prompt",
            "name": "테스트 프롬프트",
            "description": "설명",
            "body": "안녕하세요 {name}님",
            "category": "test",
            "tags": "tag1,tag2",
            "is_shared": False,
            "role_codes": [],
        },
    )
    assert res.status_code in (200, 201), res.text
    body = res.json()
    assert body["code"] == "test-prompt"
    assert body["body"] == "안녕하세요 {name}님"


def test_prompt_code_uniqueness(client):
    """같은 code 두 번 만들면 409."""
    h = _admin_header(client)
    payload = {
        "code": "dup",
        "name": "dup",
        "body": "x",
        "is_shared": False,
        "role_codes": [],
    }
    r1 = client.post("/api/prompts", headers=h, json=payload)
    assert r1.status_code in (200, 201)
    r2 = client.post("/api/prompts", headers=h, json=payload)
    assert r2.status_code == 409


def test_prompt_code_format_validated(client):
    """code 패턴 ^[a-z0-9][a-z0-9_-]*$ — 대문자 / 한글 거절."""
    h = _admin_header(client)
    for bad_code in ["BadCode", "한글코드", "-leading-dash"]:
        res = client.post(
            "/api/prompts",
            headers=h,
            json={
                "code": bad_code,
                "name": "x",
                "body": "y",
                "is_shared": False,
                "role_codes": [],
            },
        )
        assert res.status_code == 422, f"{bad_code!r}: {res.status_code}"


def test_delete_prompt(client):
    """삭제 → 목록에서 사라짐."""
    h = _admin_header(client)
    r = client.post(
        "/api/prompts",
        headers=h,
        json={
            "code": "del-me",
            "name": "지울 것",
            "body": "x",
            "is_shared": False,
            "role_codes": [],
        },
    )
    pid = r.json()["id"]
    res = client.delete(f"/api/prompts/{pid}", headers=h)
    assert res.status_code in (200, 204)
    rest = client.get("/api/prompts", headers=h).json()
    assert all(p["id"] != pid for p in rest)


def test_list_macros_empty(client):
    h = _admin_header(client)
    res = client.get("/api/macros", headers=h)
    assert res.status_code == 200
    assert res.json() == []


def test_create_macro(client):
    h = _admin_header(client)
    res = client.post(
        "/api/macros",
        headers=h,
        json={"name": "인사", "body": "안녕하세요!"},
    )
    assert res.status_code in (200, 201), res.text
    body = res.json()
    assert body["name"] == "인사"
