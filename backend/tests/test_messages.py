"""채팅 세션의 메시지 메타 (별표/평가/별점/escalation) + 검색 스모크."""
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


def _make_session_with_messages(client, h):
    """세션 + 사용자/어시스턴트 메시지 1쌍.  chat 엔드포인트는 LLM 호출이
    필요해 우회 — SessionLocal 로 직접 INSERT.  conftest 가 이미
    SessionLocal 을 테스트 DB 로 갈아끼웠으니 그대로 사용."""
    import asyncio
    from app import models
    from app.database import SessionLocal

    r = client.post("/api/sessions", headers=h, json={"title": "T"})
    sid = r.json()["id"]

    async def _insert():
        async with SessionLocal() as db:
            user_msg = models.Message(session_id=sid, role="user", content="안녕")
            ai_msg = models.Message(
                session_id=sid,
                role="assistant",
                provider="test",
                content="안녕하세요!",
            )
            db.add(user_msg)
            db.add(ai_msg)
            await db.commit()
            await db.refresh(user_msg)
            await db.refresh(ai_msg)
            return user_msg.id, ai_msg.id

    user_id, ai_id = asyncio.new_event_loop().run_until_complete(_insert())
    return sid, [{"id": user_id, "role": "user"}, {"id": ai_id, "role": "assistant"}]


def test_message_meta_star_toggle(client):
    """별표 토글 PATCH."""
    h = _admin_header(client)
    sid, msgs = _make_session_with_messages(client, h)
    mid = msgs[1]["id"]
    res = client.patch(
        f"/api/sessions/{sid}/messages/{mid}/meta",
        headers=h,
        json={"starred": True},
    )
    assert res.status_code == 200, res.text
    assert res.json()["starred"] is True
    # 다시 false 로
    res = client.patch(
        f"/api/sessions/{sid}/messages/{mid}/meta",
        headers=h,
        json={"starred": False},
    )
    assert res.json()["starred"] is False


def test_message_meta_feedback(client):
    """평가 (-1/0/1) + 메모 + 카테고리."""
    h = _admin_header(client)
    sid, msgs = _make_session_with_messages(client, h)
    mid = msgs[1]["id"]
    res = client.patch(
        f"/api/sessions/{sid}/messages/{mid}/meta",
        headers=h,
        json={
            "feedback": -1,
            "feedback_note": "부정확",
            "feedback_category": "inaccurate",
        },
    )
    assert res.status_code == 200, res.text
    body = res.json()
    assert body["feedback"] == -1
    assert body["feedback_category"] == "inaccurate"


def test_message_meta_rating(client):
    """1~5 별점."""
    h = _admin_header(client)
    sid, msgs = _make_session_with_messages(client, h)
    mid = msgs[1]["id"]
    res = client.patch(
        f"/api/sessions/{sid}/messages/{mid}/meta",
        headers=h,
        json={"rating": 4},
    )
    assert res.status_code == 200
    assert res.json()["rating"] == 4


def test_message_meta_rating_out_of_range(client):
    """6 별은 422."""
    h = _admin_header(client)
    sid, msgs = _make_session_with_messages(client, h)
    mid = msgs[1]["id"]
    res = client.patch(
        f"/api/sessions/{sid}/messages/{mid}/meta",
        headers=h,
        json={"rating": 6},
    )
    assert res.status_code == 422


def test_message_escalate(client):
    """사용자가 'AI 가 못 풀었어요' 표시 → 관리자 알림 생성."""
    h = _admin_header(client)
    sid, msgs = _make_session_with_messages(client, h)
    mid = msgs[1]["id"]
    res = client.post(
        f"/api/sessions/{sid}/messages/{mid}/escalate",
        headers=h,
        json={"reason": "테스트 escalation"},
    )
    assert res.status_code == 200, res.text
    body = res.json()
    assert body["escalated_at"] is not None
    assert body["reason"] == "테스트 escalation"
    # admin escalations 목록에 보여야.
    listing = client.get("/api/admin/escalations", headers=h).json()
    assert len(listing) >= 1
    assert any(e["message_id"] == mid for e in listing)


def test_message_escalate_user_only(client):
    """user 메시지는 escalation 불가."""
    h = _admin_header(client)
    sid, msgs = _make_session_with_messages(client, h)
    user_mid = msgs[0]["id"]
    res = client.post(
        f"/api/sessions/{sid}/messages/{user_mid}/escalate",
        headers=h,
        json={"reason": "x"},
    )
    assert res.status_code == 400


def test_starred_messages_listing(client):
    """별표한 메시지가 모이는 _starred 라우트.  '/{session_id}' 보다
    *앞* 에 등록돼 있어야 path-param 으로 빨려들지 않음 (회귀 가드)."""
    h = _admin_header(client)
    sid, msgs = _make_session_with_messages(client, h)
    mid = msgs[1]["id"]
    client.patch(
        f"/api/sessions/{sid}/messages/{mid}/meta",
        headers=h,
        json={"starred": True},
    )
    res = client.get("/api/sessions/_starred", headers=h)
    assert res.status_code == 200, res.text
    starred = res.json()
    assert isinstance(starred, list)
    assert any(s["id"] == mid for s in starred)


def test_log_merge_endpoint_validates_payload(client):
    """log_merge 는 user_prompt + result_filename 필수 — 누락 시 422."""
    h = _admin_header(client)
    r = client.post("/api/sessions", headers=h, json={"title": "T"})
    sid = r.json()["id"]
    res = client.post(
        f"/api/sessions/{sid}/log-merge",
        headers=h,
        json={"messages": [{"role": "user", "content": "x"}]},
    )
    assert res.status_code == 422
