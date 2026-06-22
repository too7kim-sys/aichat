"""전사 → 채팅 → export 통합 플로우.

실제 Whisper 파이프라인 (ENABLE_TRANSCRIPTION=false) 은 우회하고,
DB 에 Transcript + 연결된 Session + 메시지를 직접 seed 한 뒤
회의록 DOCX / HWPX export 가 실제로 작동하는지 검증.

기존 test_transcripts.py 는 404/503/auth 같은 경계 케이스만 다룸 —
이 파일은 export 와 PII 마스킹 / message 선택 / orphan 경로의
golden path 를 한 군데서 묶어 회귀 가드 역할.
"""
from __future__ import annotations

import asyncio


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


def _seed_transcript(
    client,
    h,
    *,
    title: str = "팀 회의",
    summary: str = "## 결정 사항\n\n- 다음 주 배포\n- 회의록 자동화 도입",
    raw: str = "어 그러니까 다음 주에 배포하고요, 회의록은 자동으로 만들기로 하죠.",
):
    """세션 + Transcript + raw(user)/summary(assistant) 메시지 한 쌍 seed.

    실제 업로드 경로 (POST /transcripts) 는 ENABLE_TRANSCRIPTION 가
    꺼져 있어 503 — 그래서 DB 에 직접 INSERT.  conftest 가 이미
    SessionLocal 을 테스트 DB 로 갈아끼웠으니 그대로 사용.
    """
    from app import models
    from app.database import SessionLocal
    from sqlalchemy import select

    # 세션 행은 라우터로 만들고 (user_id 매칭 / 권한 체크 한 번 거치는 게
    # 깔끔), Transcript / Message 는 직접 INSERT.
    r = client.post("/api/sessions", headers=h, json={"title": title})
    sid = r.json()["id"]

    async def _insert():
        async with SessionLocal() as db:
            # admin@example.com 의 user_id 찾기.
            user = (
                await db.execute(
                    select(models.User).where(
                        models.User.email == "admin@example.com"
                    )
                )
            ).scalar_one()
            tr = models.Transcript(
                user_id=user.id,
                source_filename=f"{title}.webm",
                size_bytes=1024 * 500,
                duration_sec=600.0,
                status="ok",
                language="ko",
                diarized=False,
                session_id=sid,
            )
            db.add(tr)
            db.add(
                models.Message(
                    session_id=sid, role="user", content=raw, hidden=True,
                )
            )
            db.add(
                models.Message(
                    session_id=sid, role="assistant", provider="test", content=summary,
                )
            )
            await db.commit()
            await db.refresh(tr)
            return tr.id

    tid = asyncio.new_event_loop().run_until_complete(_insert())
    return sid, tid


def test_transcript_listing_includes_seeded_row(client):
    """DB 에 INSERT 한 회의록이 GET /transcripts 에 잡혀야."""
    h = _admin_header(client)
    _seed_transcript(client, h)
    rows = client.get("/api/transcripts", headers=h).json()
    assert len(rows) >= 1
    assert any(r["status"] == "ok" for r in rows)


def test_export_docx_summary_default(client):
    """기본값 include=summary — assistant 메시지만 DOCX 본문에 들어가야.
    Content-Disposition 에 한글 파일명 (RFC 5987 인코딩) 포함."""
    h = _admin_header(client)
    sid, tid = _seed_transcript(client, h)
    res = client.get(f"/api/transcripts/{tid}/export.docx", headers=h)
    assert res.status_code == 200, res.text
    assert "wordprocessingml" in res.headers["content-type"]
    cd = res.headers["content-disposition"]
    assert "filename" in cd
    assert "UTF-8''" in cd  # 한글 파일명 인코딩

    # DOCX 는 zip — 안에 document.xml 이 있어야 유효한 형식.
    import io
    import zipfile

    buf = io.BytesIO(res.content)
    with zipfile.ZipFile(buf) as zf:
        names = zf.namelist()
        assert "word/document.xml" in names
        doc_xml = zf.read("word/document.xml").decode("utf-8")
        # summary 본문이 들어 있어야.
        assert "결정 사항" in doc_xml
        assert "회의록 자동화" in doc_xml
        # raw transcript 는 들어가면 안 됨.
        assert "어 그러니까" not in doc_xml


def test_export_docx_include_all_has_raw(client):
    """include=all 이면 user role (원문 전사) 도 함께 들어가야."""
    h = _admin_header(client)
    sid, tid = _seed_transcript(client, h)
    res = client.get(
        f"/api/transcripts/{tid}/export.docx?include=all", headers=h,
    )
    assert res.status_code == 200
    import io, zipfile

    with zipfile.ZipFile(io.BytesIO(res.content)) as zf:
        doc_xml = zf.read("word/document.xml").decode("utf-8")
    assert "결정 사항" in doc_xml
    assert "어 그러니까" in doc_xml  # raw 도 포함.


def test_export_docx_message_ids_pick_overrides_include(client):
    """message_ids 가 들어오면 include 모드를 무시하고 명시된 메시지만."""
    h = _admin_header(client)
    sid, tid = _seed_transcript(client, h)
    # 세션의 메시지 중 user (raw) 하나만 골라.
    sess = client.get(f"/api/sessions/{sid}", headers=h).json()
    user_msg = next(m for m in sess["messages"] if m["role"] == "user")
    res = client.get(
        f"/api/transcripts/{tid}/export.docx"
        f"?include=summary&message_ids={user_msg['id']}",
        headers=h,
    )
    assert res.status_code == 200
    import io, zipfile

    with zipfile.ZipFile(io.BytesIO(res.content)) as zf:
        doc_xml = zf.read("word/document.xml").decode("utf-8")
    # 명시된 user 메시지는 들어가야.
    assert "어 그러니까" in doc_xml
    # 명시되지 않은 assistant 메시지는 빠져야.
    assert "결정 사항" not in doc_xml


def test_export_docx_mask_pii(client):
    """mask_pii=true 면 본문의 전화·이메일이 가려진 채 export."""
    h = _admin_header(client)
    sid, tid = _seed_transcript(
        client, h,
        summary="회의 후 연락처는 010-1234-5678, foo@bar.com 으로 모음.",
    )
    res = client.get(
        f"/api/transcripts/{tid}/export.docx?mask_pii=true", headers=h,
    )
    assert res.status_code == 200
    import io, zipfile

    with zipfile.ZipFile(io.BytesIO(res.content)) as zf:
        doc_xml = zf.read("word/document.xml").decode("utf-8")
    # 원본 phone 숫자는 가려져야.
    assert "010-1234-5678" not in doc_xml
    # 마스킹된 흔적 (마지막 4자리가 *) — 정확한 포맷은 pii_mask 구현에
    # 의존하지만 별표가 한 번이라도 나와야.
    assert "*" in doc_xml


def test_export_hwpx_returns_valid_zip(client):
    """HWPX 도 ZIP 컨테이너 — 유효한 패키지가 와야."""
    h = _admin_header(client)
    sid, tid = _seed_transcript(client, h)
    res = client.get(f"/api/transcripts/{tid}/export.hwpx", headers=h)
    assert res.status_code == 200
    assert res.headers["content-type"] == "application/hwp+zip"
    import io, zipfile

    with zipfile.ZipFile(io.BytesIO(res.content)) as zf:
        names = zf.namelist()
        # HWPX 표준 mimetype 파일은 필수.
        assert "mimetype" in names
        mt = zf.read("mimetype").decode("ascii")
        assert "hwp+zip" in mt


def test_export_other_user_404(client):
    """다른 user 의 transcript 는 access 권한 없음 → 404."""
    h_admin = _admin_header(client)
    _, tid = _seed_transcript(client, h_admin)

    # 두 번째 사용자 가입.
    other = client.post(
        "/api/auth/signup",
        json={
            "email": "other@example.com",
            "password": "Strong-Pwd-1234!",
            "name": "타인",
        },
    )
    h_other = {"Authorization": f"Bearer {other.json()['access_token']}"}
    res = client.get(f"/api/transcripts/{tid}/export.docx", headers=h_other)
    assert res.status_code == 404


def test_rename_transcript_updates_session_title(client):
    """PATCH /transcripts/{id} {title:"..."} — Transcript 와 연결된
    Session 의 제목이 모두 바뀌어야 (UI 측 양쪽에서 보이게)."""
    h = _admin_header(client)
    sid, tid = _seed_transcript(client, h, title="원래 제목")
    res = client.patch(
        f"/api/transcripts/{tid}",
        headers=h,
        json={"title": "수정된 제목"},
    )
    assert res.status_code == 200, res.text
    # session 도 같이 바뀌었는지 확인.
    sess = client.get(f"/api/sessions/{sid}", headers=h).json()
    assert sess["title"] == "수정된 제목"
