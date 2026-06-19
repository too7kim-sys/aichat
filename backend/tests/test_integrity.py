"""데이터 정합성 + 관측 admin 엔드포인트 스모크 (#112~#120)."""
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


def test_integrity_backups_runs(client):
    """백업 dir 가 없어도 200 + empty files 반환."""
    h = _admin_header(client)
    res = client.get("/api/admin/integrity/backups", headers=h)
    assert res.status_code == 200
    body = res.json()
    assert "backup_dir" in body
    assert "files" in body


def test_integrity_orphans_empty(client):
    """깨끗한 DB 에는 고아 행이 없어야."""
    h = _admin_header(client)
    res = client.get("/api/admin/integrity/orphans", headers=h)
    assert res.status_code == 200
    body = res.json()
    assert "comments" in body
    # 깨끗한 DB 이므로 모든 카테고리가 count=0
    for _, info in body["comments"].items():
        assert info["count"] == 0


def test_integrity_files_runs(client):
    """upload dir 가 없어도 200 + empty arrays."""
    h = _admin_header(client)
    res = client.get("/api/admin/integrity/files", headers=h)
    assert res.status_code == 200
    body = res.json()
    assert "upload_root" in body
    assert isinstance(body["orphan_dirs"], list)
    assert isinstance(body["missing_dirs"], list)


def test_orphans_cleanup_validates_kind(client):
    """kind 가 'comments' 외 다른 값은 422."""
    h = _admin_header(client)
    res = client.post(
        "/api/admin/integrity/orphans/cleanup",
        headers=h,
        json={"kind": "wrong-kind", "target_type": "message"},
    )
    assert res.status_code == 422


def test_files_cleanup_empty_list_rejected(client):
    """빈 list 는 422 (min_length 검증)."""
    h = _admin_header(client)
    # min_length 가 아니라 max_length 만 있으니 400 ('비어 있음')
    res = client.post(
        "/api/admin/integrity/files/cleanup",
        headers=h,
        json={"project_ids": []},
    )
    assert res.status_code in (400, 422)


def test_files_cleanup_traversal_rejected(client):
    """경로 트래버설 시도 — '/' 나 '..' 포함은 건너뛰고 0 회수.
    실제 정리는 안 일어남."""
    h = _admin_header(client)
    res = client.post(
        "/api/admin/integrity/files/cleanup",
        headers=h,
        json={"project_ids": ["../etc", "/etc/passwd", "ok-but-no-dir"]},
    )
    # 200 으로 떨어지지만 deleted_dirs=0 (실재 디렉터리 없음).
    assert res.status_code == 200
    assert res.json()["deleted_dirs"] == 0


def test_requests_stats_runs(client):
    """요청 통계 — 빈 RequestLog 도 200."""
    h = _admin_header(client)
    res = client.get("/api/admin/requests/stats?hours=24", headers=h)
    assert res.status_code == 200
    assert "items" in res.json()


def test_slo_dashboard_runs(client):
    """SLO 요약 — 24h/7d 둘 다 반환."""
    h = _admin_header(client)
    res = client.get("/api/admin/requests/slo", headers=h)
    assert res.status_code == 200
    body = res.json()
    assert "h24" in body and "d7" in body
    assert "trend_24h" in body and "trend_7d" in body


def test_pending_approvals_empty(client):
    """승인 대기 워크플로 실행이 없으면 빈 items."""
    h = _admin_header(client)
    res = client.get("/api/workflow-runs/pending-approvals", headers=h)
    assert res.status_code == 200
    assert res.json()["items"] == []
