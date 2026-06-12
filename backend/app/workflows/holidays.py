"""한국 공휴일 인지 — 워크플로 자동 실행 스킵에 사용.

폐쇄망 환경을 가정해 외부 API(예: data.go.kr 공휴일) 호출 없이 정적
목록만으로 동작. 음력 기반 명절(설·추석·부처님오신날)은 매년 양력
날짜가 달라서 직접 박아 두었다. 새 연도는 .env 의
WORKFLOW_EXTRA_HOLIDAYS 로 추가 (또는 이 파일을 갱신).

운영 토글:
  Workflow.skip_holidays  bool (모델 컬럼) — 사용자가 워크플로별로 끔/켬.
"""
from __future__ import annotations

from datetime import date
from functools import lru_cache

from ..config import settings


# 매년 같은 양력 날짜인 공휴일.
_FIXED = {
    (1, 1):  "신정",
    (3, 1):  "삼일절",
    (5, 5):  "어린이날",
    (6, 6):  "현충일",
    (8, 15): "광복절",
    (10, 3): "개천절",
    (10, 9): "한글날",
    (12, 25): "크리스마스",
}

# 음력 기반 / 대체공휴일 — 직접 박아둠. 새 연도는 추가 필요.
# 출처: 인사혁신처 공휴일 발표.
_VARIABLE: dict[date, str] = {
    # 2024
    date(2024, 2, 9):  "설 연휴",
    date(2024, 2, 10): "설날",
    date(2024, 2, 11): "설 연휴",
    date(2024, 2, 12): "설 대체공휴일",
    date(2024, 4, 10): "국회의원선거일",
    date(2024, 5, 6):  "어린이날 대체",
    date(2024, 5, 15): "부처님오신날",
    date(2024, 9, 16): "추석 연휴",
    date(2024, 9, 17): "추석",
    date(2024, 9, 18): "추석 연휴",
    # 2025
    date(2025, 1, 28): "설 연휴",
    date(2025, 1, 29): "설날",
    date(2025, 1, 30): "설 연휴",
    date(2025, 5, 5):  "부처님오신날(어린이날 겹침)",
    date(2025, 10, 5): "추석 연휴",
    date(2025, 10, 6): "추석",
    date(2025, 10, 7): "추석 연휴",
    date(2025, 10, 8): "추석 대체공휴일",
    # 2026
    date(2026, 2, 16): "설 연휴",
    date(2026, 2, 17): "설날",
    date(2026, 2, 18): "설 연휴",
    date(2026, 5, 24): "부처님오신날",
    date(2026, 5, 25): "부처님오신날 대체",
    date(2026, 9, 24): "추석 연휴",
    date(2026, 9, 25): "추석",
    date(2026, 9, 26): "추석 연휴",
    # 2027
    date(2027, 2, 6):  "설 연휴",
    date(2027, 2, 7):  "설날",
    date(2027, 2, 8):  "설 연휴",
    date(2027, 5, 13): "부처님오신날",
    date(2027, 9, 14): "추석 연휴",
    date(2027, 9, 15): "추석",
    date(2027, 9, 16): "추석 연휴",
}


@lru_cache(maxsize=1)
def _extra_holidays() -> set[date]:
    """.env 의 WORKFLOW_EXTRA_HOLIDAYS 가 비어 있지 않으면 그 안의
    `YYYY-MM-DD` 들을 추가. 사내 휴일(창립기념일 등) 등록용."""
    raw = (settings.workflow_extra_holidays or "").strip()
    out: set[date] = set()
    if not raw:
        return out
    for tok in raw.split(","):
        tok = tok.strip()
        if not tok:
            continue
        try:
            y, m, d = tok.split("-")
            out.add(date(int(y), int(m), int(d)))
        except (ValueError, AttributeError):
            # 잘못된 토큰은 조용히 무시 — 부팅 안 막음.
            continue
    return out


def label_for(d: date) -> str | None:
    """그 날의 공휴일 이름 (없으면 None)."""
    if (d.month, d.day) in _FIXED:
        return _FIXED[(d.month, d.day)]
    if d in _VARIABLE:
        return _VARIABLE[d]
    if d in _extra_holidays():
        return "사내 휴일"
    return None


def is_holiday(d: date) -> bool:
    return label_for(d) is not None
