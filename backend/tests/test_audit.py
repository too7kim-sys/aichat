"""감사 로그 (#audit) — 라우터 + 실 이벤트 발생 후 조회 / 필터.

기존 test_validation.py 는 Query bounds 만 검증 — 여기선
실제로 signup/login_ok 가 audit_log 에 쌓이고 admin 이 그것을
event/user_q/date 필터로 좁힐 수 있는지를 확인.
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


def test_signup_records_audit_event(client):
    """첫 signup → admin → /api/admin/audit 에 'signup' 행이 있어야."""
    h = _admin_header(client)
    rows = client.get("/api/admin/audit", headers=h).json()
    assert isinstance(rows, list)
    assert any(r["event"] == "signup" for r in rows)


def test_login_ok_records_audit(client):
    """로그인 성공 → login_ok 이벤트 기록."""
    h = _admin_header(client)
    # 로그인 한 번.
    lr = client.post(
        "/api/auth/login",
        json={"email": "admin@example.com", "password": "Strong-Pwd-1234!"},
    )
    assert lr.status_code == 200
    rows = client.get("/api/admin/audit?event=login_ok", headers=h).json()
    assert any(r["event"] == "login_ok" for r in rows)
    # 필터된 결과에는 login_ok 만 있어야.
    assert all(r["event"] == "login_ok" for r in rows)


def test_login_fail_records_audit(client):
    """로그인 실패 → login_fail 기록 (forensic)."""
    h = _admin_header(client)
    client.post(
        "/api/auth/login",
        json={"email": "admin@example.com", "password": "wrong-password"},
    )
    rows = client.get("/api/admin/audit?event=login_fail", headers=h).json()
    assert any(r["event"] == "login_fail" for r in rows)


def test_audit_filter_by_user_email_partial(client):
    """user_q 는 이메일 ilike 부분 일치."""
    h = _admin_header(client)
    rows = client.get(
        "/api/admin/audit?user_q=admin", headers=h,
    ).json()
    assert isinstance(rows, list)
    # admin@example.com 가 잡혀야 (admin substring 매칭)
    assert all(
        r["user_email"] in ("admin@example.com", "—", "(deleted)")
        for r in rows
    )


def test_audit_filter_unknown_user_returns_empty(client):
    """존재하지 않는 이메일 substring 은 빈 결과."""
    h = _admin_header(client)
    rows = client.get(
        "/api/admin/audit?user_q=nonexistent-zzz-12345", headers=h,
    ).json()
    assert rows == []


def test_audit_csv_export_has_bom(client):
    """CSV export — 헤더 + UTF-8 BOM."""
    h = _admin_header(client)
    res = client.get("/api/admin/audit.csv", headers=h)
    assert res.status_code == 200
    assert res.headers["content-type"].startswith("text/csv")
    # 한글 깨짐 방지용 BOM.
    assert res.content.startswith(b"\xef\xbb\xbf")
    body = res.content.decode("utf-8-sig")
    # 첫 줄 = 컬럼 헤더, 둘째 줄부터 데이터.
    lines = body.splitlines()
    assert len(lines) >= 2
    header = lines[0]
    # 헤더는 한글 라벨 + IP/User-Agent (대소문자 그대로).
    for col in ("시각", "이벤트", "사용자", "IP"):
        assert col in header


def test_audit_requires_staff(client):
    """일반 사용자는 audit 조회 차단."""
    # 첫 가입자 = admin 이라 우회.  두 번째 가입자를 강제로 사용.
    _admin_header(client)
    other = client.post(
        "/api/auth/signup",
        json={
            "email": "user@example.com",
            "password": "Strong-Pwd-1234!",
            "name": "일반",
        },
    )
    h_other = {"Authorization": f"Bearer {other.json()['access_token']}"}
    res = client.get("/api/admin/audit", headers=h_other)
    assert res.status_code in (401, 403)


def test_audit_event_filter_only_returns_matching(client):
    """event 필터가 정확히 일치하는 행만."""
    h = _admin_header(client)
    # signup, login_ok, login_fail 다양화.
    client.post(
        "/api/auth/login",
        json={"email": "admin@example.com", "password": "Strong-Pwd-1234!"},
    )
    client.post(
        "/api/auth/login",
        json={"email": "admin@example.com", "password": "wrong"},
    )
    rows = client.get("/api/admin/audit?event=signup", headers=h).json()
    assert len(rows) >= 1
    assert all(r["event"] == "signup" for r in rows)


def test_activity_timeline_returns_dau_wau_mau(client):
    """activity-timeline 엔드포인트 — 신규 가입자 1명 + 로그인 1번 →
    DAU/WAU/MAU 모두 1, daily 배열 길이 == days+1 (오늘 포함)."""
    h = _admin_header(client)
    client.post(
        "/api/auth/login",
        json={"email": "admin@example.com", "password": "Strong-Pwd-1234!"},
    )
    res = client.get("/api/admin/activity-timeline?days=7", headers=h)
    assert res.status_code == 200, res.text
    body = res.json()
    assert body["days"] == 7
    assert body["dau"] >= 1
    assert body["wau"] >= 1
    assert body["mau"] >= 1
    assert isinstance(body["daily"], list)
    # 7일 윈도우 + 오늘 → 8개 행 (양 끝 포함).
    assert len(body["daily"]) == 8
    # 각 행이 day / logins / messages / active_users 키 보유.
    for d in body["daily"]:
        for k in ("day", "logins", "messages", "active_users"):
            assert k in d


def test_activity_timeline_requires_staff(client):
    """일반 사용자 차단."""
    _admin_header(client)
    other = client.post(
        "/api/auth/signup",
        json={
            "email": "x@example.com",
            "password": "Strong-Pwd-1234!",
            "name": "X",
        },
    )
    h = {"Authorization": f"Bearer {other.json()['access_token']}"}
    res = client.get("/api/admin/activity-timeline?days=7", headers=h)
    assert res.status_code in (401, 403)
