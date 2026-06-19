"""앱이 import + 부팅 가능한지, OpenAPI 가 그려지는지 등 기본 스모크."""
from __future__ import annotations


def test_app_imports():
    """app.main 이 import 만 되도 회귀가 잡힘 — 새 라우터의 import 실수
    같은 거."""
    from app.main import app

    assert app.title == "Chat"


def test_openapi_renders(client):
    """OpenAPI 가 그려지면 모든 route 의 signature 가 유효함을 의미."""
    res = client.get("/openapi.json")
    assert res.status_code == 200
    spec = res.json()
    assert "paths" in spec
    # 핵심 엔드포인트가 모두 등록돼 있는지.
    assert "/api/auth/login" in spec["paths"]
    assert "/api/sessions" in spec["paths"]
    assert "/api/admin/audit" in spec["paths"]


def test_unauth_blocked(client):
    """무인증 호출은 401 로 떨어져야 한다 — 우회 경로가 만들어졌는지
    회귀 잡기 위함."""
    res = client.get("/api/sessions")
    assert res.status_code == 401


def test_health_endpoint_unauthenticated_safe(client):
    """admin/health 는 staff 필요.  무인증이면 401."""
    res = client.get("/api/admin/health")
    assert res.status_code == 401
