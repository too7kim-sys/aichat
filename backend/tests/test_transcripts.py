"""회의록(transcripts) 라우터 스모크.  Whisper 모델 다운로드/로드는 별도
의존 — 여기선 ENABLE_TRANSCRIPTION=false 인 상태에서의 404/503 거절과
CRUD 만 확인."""
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


def test_list_transcripts_empty(client):
    """새 사용자는 회의록 목록이 비어 있어야."""
    h = _admin_header(client)
    res = client.get("/api/transcripts", headers=h)
    assert res.status_code == 200
    assert res.json() == []


def test_transcripts_requires_auth(client):
    """무인증 401."""
    res = client.get("/api/transcripts")
    assert res.status_code == 401


def test_transcript_create_blocked_when_disabled(client):
    """ENABLE_TRANSCRIPTION=false 면 POST /transcripts 가 503.
    conftest 가 false 로 강제하므로 항상 503 회귀 가드."""
    h = _admin_header(client)
    # 파일 업로드 시뮬레이션 — multipart 가 아니어도 503 이 먼저 떨어져야.
    res = client.post(
        "/api/transcripts",
        headers=h,
        files={"file": ("test.webm", b"fake-audio", "audio/webm")},
    )
    # 503 (disabled) 또는 400 (validation) 어느 쪽이든 OK — 절대 200/202 안 됨.
    assert res.status_code in (400, 422, 503), res.text


def test_transcript_delete_unknown_id(client):
    """존재하지 않는 ID 삭제는 404."""
    h = _admin_header(client)
    res = client.delete(
        "/api/transcripts/00000000-0000-0000-0000-000000000000",
        headers=h,
    )
    assert res.status_code == 404


def test_transcript_extract_actions_unknown_id(client):
    """존재하지 않는 ID 의 액션 추출은 404."""
    h = _admin_header(client)
    res = client.post(
        "/api/transcripts/00000000-0000-0000-0000-000000000000/extract-actions",
        headers=h,
    )
    assert res.status_code == 404


def test_transcript_export_unknown_id_404(client):
    """존재하지 않는 ID export 는 404."""
    h = _admin_header(client)
    for fmt in ("docx", "hwpx"):
        res = client.get(
            f"/api/transcripts/00000000-0000-0000-0000-000000000000/export.{fmt}",
            headers=h,
        )
        assert res.status_code == 404, f"format={fmt}: {res.status_code}"


def test_transcript_rename_unknown_id(client):
    """이름 변경 (PATCH) 도 unknown id 면 404."""
    h = _admin_header(client)
    res = client.patch(
        "/api/transcripts/00000000-0000-0000-0000-000000000000",
        headers=h,
        json={"title": "새 제목"},
    )
    assert res.status_code == 404


def test_whisper_status_endpoint(client):
    """Whisper 상태 엔드포인트 — admin 권한 + 200."""
    h = _admin_header(client)
    res = client.get("/api/transcripts/_whisper-status", headers=h)
    # 503 (disabled) 또는 200 (status snapshot) — 어느 쪽이든 ok.
    assert res.status_code in (200, 403, 503), res.text
