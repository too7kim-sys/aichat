"""워크플로 CRUD 스모크 — 프롬프트 의존성이 있어 함께 만들고 묶음."""
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


def _make_prompt(client, h, code="wf-prompt"):
    r = client.post(
        "/api/prompts",
        headers=h,
        json={
            "code": code,
            "name": "wf 프롬프트",
            "body": "안녕 {x}",
            "is_shared": False,
            "role_codes": [],
        },
    )
    return r.json()["id"]


def test_list_workflows_empty(client):
    h = _admin_header(client)
    res = client.get("/api/workflows", headers=h)
    assert res.status_code == 200
    assert res.json() == []


def test_create_workflow_requires_valid_prompt(client):
    """존재하지 않는 prompt_id 는 400."""
    h = _admin_header(client)
    res = client.post(
        "/api/workflows",
        headers=h,
        json={
            "name": "테스트 워크플로",
            "description": "",
            "prompt_id": "nonexistent-id",
            "prompt_vars": None,
            "project_id": None,
            "model": None,
            "schedule_interval_minutes": 0,
            "enabled": True,
            "skip_holidays": False,
            "team_id": None,
            "requires_approval": False,
        },
    )
    assert res.status_code == 400


def test_create_and_list_workflow(client):
    """프롬프트 만들고 → 워크플로 등록 → 목록에 보임."""
    h = _admin_header(client)
    pid = _make_prompt(client, h)
    r = client.post(
        "/api/workflows",
        headers=h,
        json={
            "name": "테스트 wf",
            "description": "설명",
            "prompt_id": pid,
            "prompt_vars": {"x": "값"},
            "project_id": None,
            "model": None,
            "schedule_interval_minutes": 60,
            "enabled": True,
            "skip_holidays": False,
            "team_id": None,
            "requires_approval": False,
        },
    )
    assert r.status_code in (200, 201), r.text
    wf = r.json()
    assert wf["name"] == "테스트 wf"
    assert wf["prompt_id"] == pid
    # 목록에 들어가 있어야.
    listing = client.get("/api/workflows", headers=h).json()
    assert any(w["id"] == wf["id"] for w in listing)


def test_update_workflow_partial(client):
    """이름만 PATCH — 나머지 필드는 그대로."""
    h = _admin_header(client)
    pid = _make_prompt(client, h)
    create = client.post(
        "/api/workflows",
        headers=h,
        json={
            "name": "원래 이름",
            "description": "",
            "prompt_id": pid,
            "prompt_vars": None,
            "project_id": None,
            "model": None,
            "schedule_interval_minutes": 0,
            "enabled": True,
            "skip_holidays": False,
            "team_id": None,
            "requires_approval": False,
        },
    )
    wid = create.json()["id"]
    res = client.patch(
        f"/api/workflows/{wid}",
        headers=h,
        json={"name": "새 이름"},
    )
    assert res.status_code == 200, res.text
    assert res.json()["name"] == "새 이름"
    assert res.json()["prompt_id"] == pid  # 안 건드린 필드 유지


def test_delete_workflow(client):
    h = _admin_header(client)
    pid = _make_prompt(client, h)
    create = client.post(
        "/api/workflows",
        headers=h,
        json={
            "name": "지울 wf",
            "description": "",
            "prompt_id": pid,
            "prompt_vars": None,
            "project_id": None,
            "model": None,
            "schedule_interval_minutes": 0,
            "enabled": True,
            "skip_holidays": False,
            "team_id": None,
            "requires_approval": False,
        },
    )
    wid = create.json()["id"]
    res = client.delete(f"/api/workflows/{wid}", headers=h)
    assert res.status_code in (200, 204)
    assert all(w["id"] != wid for w in client.get("/api/workflows", headers=h).json())
