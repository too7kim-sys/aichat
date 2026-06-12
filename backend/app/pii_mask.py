"""한국어 PII (개인식별정보) 마스킹.

채팅 답변·문서 export 에서 주민번호·전화·이메일·카드번호 같은
규칙성 있는 식별자를 자동으로 가린다. 폐쇄망 환경을 고려해 정규식
만으로 처리 — NER 모델을 굳이 가져오지 않는다.

설계:
  · 마스킹 룰은 종류별로 따로 — 운영 정책에 따라 일부만 켤 수 있게.
  · 마스킹은 비대칭(앞·뒤 일부만 노출). 원문 복원은 불가능.
  · 사용자가 본인 정보를 명시적으로 적은 경우(예: "내 이메일은 …")
    도 마스킹된다 — 채팅 로그가 다른 사용자 / 운영자에게 노출될
    가능성이 있어 보수적 정책.

규칙:
  주민번호    YYYYMM-XXXXXXX → YYYYMM-1******
  전화        010-1234-5678 → 010-1234-****
  이메일      foo@bar.com  → f**@bar.com
  카드        1234-5678-9012-3456 → 1234-****-****-3456
  이름        2자 NER 은 안 함 (false positive 가 많음).
              사용자가 명시한 이름은 토픽상 본인을 가리키는 게 대부분.
"""
from __future__ import annotations

import re

# 컴파일은 모듈 임포트 시 1회.
_RE_SSN = re.compile(r"\b(\d{6})[-\s](\d)\d{6}\b")
_RE_PHONE = re.compile(r"\b(01[016789])[-\s]?(\d{3,4})[-\s]?(\d{4})\b")
_RE_PHONE_LL = re.compile(r"\b(0[2-6]\d?)[-\s]?(\d{3,4})[-\s]?(\d{4})\b")
_RE_EMAIL = re.compile(
    r"\b([A-Za-z0-9._%+-])[A-Za-z0-9._%+-]*(@[A-Za-z0-9.-]+\.[A-Za-z]{2,})\b"
)
_RE_CARD = re.compile(r"\b(\d{4})[-\s]?\d{4}[-\s]?\d{4}[-\s]?(\d{4})\b")
_RE_PASSPORT = re.compile(r"\b([A-Z]{1,2})\d{7,8}\b")


def mask(
    text: str,
    *,
    ssn: bool = True,
    phone: bool = True,
    email: bool = True,
    card: bool = True,
    passport: bool = True,
) -> str:
    """규칙별 토글이 모두 켜진 상태가 기본. 부분 비활성도 지원."""
    if not text:
        return text
    if ssn:
        text = _RE_SSN.sub(r"\1-\2******", text)
    if phone:
        text = _RE_PHONE.sub(r"\1-\2-****", text)
        text = _RE_PHONE_LL.sub(r"\1-\2-****", text)
    if email:
        text = _RE_EMAIL.sub(r"\1**\2", text)
    if card:
        text = _RE_CARD.sub(r"\1-****-****-\2", text)
    if passport:
        text = _RE_PASSPORT.sub(r"\1*******", text)
    return text


def detect(text: str) -> dict[str, int]:
    """텍스트 안에 발견된 식별자 카운트. UI 가 "회의록에 PII N건 발견"
    같은 안내를 띄울 때 사용."""
    if not text:
        return {}
    return {
        "ssn": len(_RE_SSN.findall(text)),
        "phone": len(_RE_PHONE.findall(text)) + len(_RE_PHONE_LL.findall(text)),
        "email": len(_RE_EMAIL.findall(text)),
        "card": len(_RE_CARD.findall(text)),
        "passport": len(_RE_PASSPORT.findall(text)),
    }
