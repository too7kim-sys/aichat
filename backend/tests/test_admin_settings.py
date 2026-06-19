"""admin 설정 PUT/GET — auto_approve_signups + RAG 토글 (#111).
Pydantic 정책으로 잘못된 payload 가 422 로 떨어지는지 확인."""
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


def test_settings_get_default_shape(client):
    """settings 응답이 모든 필드를 포함."""
    h = _admin_header(client)
    res = client.get("/api/admin/settings", headers=h)
    assert res.status_code == 200, res.text
    body = res.json()
    assert "auto_approve_signups" in body
    assert "rag_query_rewrite" in body
    assert "rag_llm_rerank" in body
    assert "rag_mmr" in body


def test_settings_toggle_persists(client):
    """RAG 토글이 PUT 후 GET 에 반영."""
    h = _admin_header(client)
    # 현재 상태 받기
    cur = client.get("/api/admin/settings", headers=h).json()
    target = not cur["rag_llm_rerank"]
    res = client.put(
        "/api/admin/settings",
        headers=h,
        json={"rag_llm_rerank": target},
    )
    assert res.status_code == 200, res.text
    assert res.json()["rag_llm_rerank"] is target
    # 재조회로도 같은 값
    res2 = client.get("/api/admin/settings", headers=h)
    assert res2.json()["rag_llm_rerank"] is target


def test_settings_reject_unknown_field(client):
    """모르는 필드는 무시되거나 거절 — 200 이라도 부수효과 없음."""
    h = _admin_header(client)
    res = client.put(
        "/api/admin/settings",
        headers=h,
        json={"bogus_field": True},
    )
    # Pydantic 이 extra='ignore' 면 200, 'forbid' 면 422 — 어느 쪽이든 OK.
    assert res.status_code in (200, 422), res.text


def test_integrity_cleanup_rejects_dict(client):
    """6차 다듬기 — payload: dict → Pydantic 변환 회귀.  잘못된 입력은 422."""
    h = _admin_header(client)
    # 필수 필드 누락
    res = client.post("/api/admin/integrity/orphans/cleanup", headers=h, json={})
    assert res.status_code == 422
    # target_type 만 보내면 (kind 누락) 422
    res = client.post(
        "/api/admin/integrity/orphans/cleanup", headers=h, json={"target_type": "message"}
    )
    assert res.status_code == 422


def test_files_cleanup_max_length(client):
    """project_ids list 가 100개 초과면 422 (안전 가드 #6차)."""
    h = _admin_header(client)
    too_many = [f"x-{i}" for i in range(101)]
    res = client.post(
        "/api/admin/integrity/files/cleanup",
        headers=h,
        json={"project_ids": too_many},
    )
    assert res.status_code == 422
