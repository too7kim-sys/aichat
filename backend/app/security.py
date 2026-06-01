"""Lightweight password policy.

Rules (any failure → ValueError):
  - Minimum 8 characters.
  - Must contain at least two distinct character classes among:
    lowercase, uppercase, digit, symbol.
  - Must not be in a small blocklist of trivially weak strings.
  - Must not contain the user's email local-part or name (case-insensitive)
    when those are known at validation time.

The frontend has its own strength meter; this is the authoritative check.
"""
from __future__ import annotations

# Tiny blocklist — covers the most embarrassing leaks. Anything longer
# belongs in a Have-I-Been-Pwned style external check.
_COMMON = {
    "password", "password1", "12345678", "123456789", "12345678910",
    "qwerty", "qwerty123", "letmein", "welcome", "admin", "iloveyou",
    "abc12345", "1q2w3e4r", "p@ssw0rd", "passw0rd", "monkey1",
}


def _classes(s: str) -> set[str]:
    out: set[str] = set()
    for ch in s:
        if ch.islower():
            out.add("lower")
        elif ch.isupper():
            out.add("upper")
        elif ch.isdigit():
            out.add("digit")
        elif not ch.isspace():
            out.add("symbol")
    return out


def validate_password(
    pw: str,
    *,
    email: str | None = None,
    name: str | None = None,
) -> None:
    if len(pw) < 8:
        raise ValueError("비밀번호는 8자 이상이어야 합니다")
    if len(pw) > 128:
        raise ValueError("비밀번호가 너무 깁니다 (128자 이하)")
    if pw.lower() in _COMMON:
        raise ValueError("너무 흔한 비밀번호입니다")
    if len(_classes(pw)) < 2:
        raise ValueError(
            "영문 대/소문자, 숫자, 기호 중 두 종류 이상을 포함해야 합니다"
        )
    lowered = pw.lower()
    if email:
        local = email.split("@", 1)[0].lower()
        if len(local) >= 4 and local in lowered:
            raise ValueError("비밀번호에 이메일을 포함할 수 없습니다")
    if name and len(name) >= 3 and name.lower() in lowered:
        raise ValueError("비밀번호에 이름을 포함할 수 없습니다")
