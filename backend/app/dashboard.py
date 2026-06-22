"""관리자 대시보드 보조 — 사용 통계 / 활동 요약 / 비용 계산.

쿼리는 모두 인덱스 친화적인 GROUP BY 한 번으로 끝나도록 작성. 큰
운영 (수십만 메시지) 에서도 한 화면 polling 비용이 가볍게 들어간다.

성능 메모:
  · Message.created_at / Session.created_at 가 모두 인덱스이므로 WHERE
    created_at >= since 는 인덱스 스캔. 풀 스캔 X.
  · _parse_rates() 결과는 module 로컬에 lru_cache 로 보관 — env 가
    프로세스 수명 내내 안 바뀌므로 매 호출 파싱 의미 없음.

비용 계산:
  · 자체 호스팅 (Ollama) 은 호출 비용 0 이지만 운영 보고서를 위해
    .env 의 MODEL_COST_RATES (모델명: 입력단가/출력단가, KRW per
    1k tokens) 를 적용해 계산. 비어 있으면 모두 0.
"""
from __future__ import annotations

import logging
from datetime import datetime, timedelta, timezone
from functools import lru_cache

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from . import models
from .config import settings

log = logging.getLogger("uvicorn.error")


@lru_cache(maxsize=1)
def _parse_rates() -> dict[str, tuple[float, float]]:
    """.env 의 MODEL_COST_RATES 를 파싱.

    형식: "model:input_rate:output_rate,model2:input2:output2"
    단위: KRW per 1k tokens. 출력 단가만 보고 싶으면 input=0.
    예: "exaone3.5:32b:0:50,qwen3:32b:0:80"
    """
    raw = (settings.model_cost_rates or "").strip()
    out: dict[str, tuple[float, float]] = {}
    if not raw:
        return out
    for tok in raw.split(","):
        tok = tok.strip()
        if not tok:
            continue
        parts = tok.split(":")
        if len(parts) < 3:
            continue
        # 모델명이 ":" 포함 가능 (예: exaone3.5:32b). 마지막 두 부분이
        # 단가, 그 앞 전부 모델명.
        try:
            o = float(parts[-1])
            i = float(parts[-2])
        except ValueError:
            continue
        name = ":".join(parts[:-2]).strip()
        if not name:
            continue
        out[name] = (i, o)
    return out


async def model_usage_stats(
    db: AsyncSession,
    *,
    days: int = 30,
) -> list[dict]:
    """모델(provider) 별 호출 횟수 + 출력 토큰 합 + 추정 비용."""
    since = datetime.now(timezone.utc) - timedelta(days=max(1, days))
    rows = (
        await db.execute(
            select(
                models.Message.provider,
                func.count(models.Message.id).label("calls"),
                func.sum(func.coalesce(models.Message.tokens_out, 0))
                    .label("tokens_out"),
                func.avg(func.coalesce(models.Message.latency_ms, 0))
                    .label("avg_latency_ms"),
            )
            .where(
                models.Message.role == "assistant",
                models.Message.created_at >= since,
                models.Message.provider.isnot(None),
            )
            .group_by(models.Message.provider)
        )
    ).all()
    rates = _parse_rates()
    out: list[dict] = []
    for provider, calls, tokens_out, avg_ms in rows:
        i_rate, o_rate = rates.get(provider or "", (0.0, 0.0))
        cost_krw = (int(tokens_out or 0) / 1000.0) * o_rate
        out.append({
            "provider": provider or "(미상)",
            "calls": int(calls or 0),
            "tokens_out": int(tokens_out or 0),
            "avg_latency_ms": int(avg_ms or 0),
            "input_rate_krw_per_1k": i_rate,
            "output_rate_krw_per_1k": o_rate,
            "estimated_cost_krw": round(cost_krw, 2),
        })
    out.sort(key=lambda r: r["calls"], reverse=True)
    return out


async def user_activity_summary(
    db: AsyncSession,
    *,
    days: int = 30,
    limit: int = 100,
) -> list[dict]:
    """사용자별 메시지·세션·로그인 활동 요약. 최근 메시지 기준 정렬."""
    since = datetime.now(timezone.utc) - timedelta(days=max(1, days))

    # 1) 메시지 통계 — 세션을 통해 user 조인.
    msg_rows = await db.execute(
        select(
            models.Session.user_id,
            func.count(models.Message.id).label("msg_count"),
            func.sum(func.coalesce(models.Message.tokens_out, 0))
                .label("tokens_out"),
            func.max(models.Message.created_at).label("last_message_at"),
        )
        .join(models.Message, models.Message.session_id == models.Session.id)
        .where(models.Message.created_at >= since)
        .group_by(models.Session.user_id)
    )
    by_uid: dict[str, dict] = {}
    for uid, cnt, tok, last_at in msg_rows.all():
        if not uid:
            continue
        by_uid[uid] = {
            "msg_count": int(cnt or 0),
            "tokens_out": int(tok or 0),
            "last_message_at": last_at,
        }

    # 2) 세션 수
    sess_rows = await db.execute(
        select(
            models.Session.user_id,
            func.count(models.Session.id).label("session_count"),
        )
        .where(models.Session.created_at >= since)
        .group_by(models.Session.user_id)
    )
    for uid, cnt in sess_rows.all():
        if not uid:
            continue
        by_uid.setdefault(uid, {})["session_count"] = int(cnt or 0)

    # 3) 로그인 횟수 + 마지막 로그인 (audit_log)
    log_rows = await db.execute(
        select(
            models.AuditLog.user_id,
            func.count(models.AuditLog.id).label("logins"),
            func.max(models.AuditLog.created_at).label("last_login_at"),
        )
        .where(
            models.AuditLog.event == "login_ok",
            models.AuditLog.created_at >= since,
        )
        .group_by(models.AuditLog.user_id)
    )
    for uid, cnt, last_at in log_rows.all():
        if not uid:
            continue
        by_uid.setdefault(uid, {})["logins"] = int(cnt or 0)
        by_uid[uid]["last_login_at"] = last_at

    # 4) 이메일·역할 합치기
    users = (
        await db.execute(
            select(models.User.id, models.User.email, models.User.role)
            .where(models.User.id.in_(by_uid.keys()))
        )
    ).all() if by_uid else []
    email_role = {u[0]: (u[1], u[2]) for u in users}

    out: list[dict] = []
    for uid, stats in by_uid.items():
        em, role = email_role.get(uid, ("(deleted)", ""))
        out.append({
            "user_id": uid,
            "email": em,
            "role": role,
            "session_count": stats.get("session_count", 0),
            "msg_count": stats.get("msg_count", 0),
            "tokens_out": stats.get("tokens_out", 0),
            "logins": stats.get("logins", 0),
            "last_message_at": (
                stats["last_message_at"].isoformat()
                if stats.get("last_message_at") else None
            ),
            "last_login_at": (
                stats["last_login_at"].isoformat()
                if stats.get("last_login_at") else None
            ),
        })
    # 최근 활동 우선.
    out.sort(
        key=lambda r: r.get("last_message_at") or r.get("last_login_at") or "",
        reverse=True,
    )
    return out[:limit]


async def activity_timeline(
    db: AsyncSession,
    *,
    days: int = 30,
) -> dict:
    """일자별 로그인 / 고유 활성 사용자 + DAU/WAU/MAU 스냅샷.

    audit_log 의 login_ok 와 Message.created_at 두 신호를 모두 사용 —
    토큰 갱신만 하고 메시지 안 보낸 사용자, 그 반대 둘 다 잡힘.
    빈 날짜는 0 으로 채워 sparkline 이 끊기지 않게.
    """
    now = datetime.now(timezone.utc)
    since = (now - timedelta(days=max(1, days))).replace(
        hour=0, minute=0, second=0, microsecond=0,
    )

    # 일별 로그인 수 + 그날 로그인한 고유 user_id 수.
    day_col = func.date(models.AuditLog.created_at)
    login_rows = (
        await db.execute(
            select(
                day_col.label("d"),
                func.count(models.AuditLog.id).label("logins"),
                func.count(func.distinct(models.AuditLog.user_id)).label("users"),
            )
            .where(
                models.AuditLog.event == "login_ok",
                models.AuditLog.created_at >= since,
            )
            .group_by(day_col)
        )
    ).all()
    login_by_day: dict[str, dict[str, int]] = {
        str(r.d): {"logins": int(r.logins or 0), "login_users": int(r.users or 0)}
        for r in login_rows
    }

    # 일별 메시지 작성자 (= 활동한 사용자) 수.  Message.role='user' 만
    # 잡아 어시스턴트 자동 응답이 활성도로 카운트되지 않게.
    msg_day = func.date(models.Message.created_at)
    msg_rows = (
        await db.execute(
            select(
                msg_day.label("d"),
                func.count(func.distinct(models.Session.user_id)).label("users"),
                func.count(models.Message.id).label("messages"),
            )
            .join(models.Session, models.Session.id == models.Message.session_id)
            .where(
                models.Message.role == "user",
                models.Message.created_at >= since,
            )
            .group_by(msg_day)
        )
    ).all()
    msg_by_day: dict[str, dict[str, int]] = {
        str(r.d): {
            "msg_users": int(r.users or 0),
            "messages": int(r.messages or 0),
        }
        for r in msg_rows
    }

    # 날짜축 — 빈 날은 0 으로 채워 sparkline 이 일자별로 정렬되게.
    daily: list[dict] = []
    cursor = since
    while cursor <= now:
        key = cursor.date().isoformat()
        lg = login_by_day.get(key, {})
        mg = msg_by_day.get(key, {})
        # active_users = 로그인 OR 메시지 작성한 고유 사용자 — 두 집합의
        # union 을 정확히 잡으려면 user_id 자체를 모아야 하지만, 그러면
        # 행이 비대해진다.  근사로 max(login_users, msg_users) 사용 —
        # 같은 user 가 양쪽 모두 잡혀도 중복 1로 처리되는 데 충분히
        # 가깝다.
        active = max(
            int(lg.get("login_users", 0)),
            int(mg.get("msg_users", 0)),
        )
        daily.append({
            "day": key,
            "logins": int(lg.get("logins", 0)),
            "messages": int(mg.get("messages", 0)),
            "active_users": active,
        })
        cursor += timedelta(days=1)

    async def _unique_users_within(td: timedelta) -> int:
        cutoff = now - td
        # 로그인 신호.
        login_uids = set(
            (await db.execute(
                select(func.distinct(models.AuditLog.user_id))
                .where(
                    models.AuditLog.event == "login_ok",
                    models.AuditLog.created_at >= cutoff,
                    models.AuditLog.user_id.isnot(None),
                )
            )).scalars().all()
        )
        # 메시지 작성 신호.
        msg_uids = set(
            (await db.execute(
                select(func.distinct(models.Session.user_id))
                .join(
                    models.Message,
                    models.Message.session_id == models.Session.id,
                )
                .where(
                    models.Message.role == "user",
                    models.Message.created_at >= cutoff,
                    models.Session.user_id.isnot(None),
                )
            )).scalars().all()
        )
        return len(login_uids | msg_uids)

    return {
        "days": days,
        "daily": daily,
        "dau": await _unique_users_within(timedelta(days=1)),
        "wau": await _unique_users_within(timedelta(days=7)),
        "mau": await _unique_users_within(timedelta(days=30)),
    }
