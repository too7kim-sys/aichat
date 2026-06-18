"""Security helpers — password policy + outbound URL/host SSRF guard.

`validate_password` keeps the legacy module-level API working (was
previously app/security.py). `ensure_public_host` / `ensure_public_url`
are used by the RAG indexer to block SSRF to internal services when
the user supplies the source URL.
"""
from __future__ import annotations

import ipaddress
import socket
from urllib.parse import urlparse


# ── Password policy ────────────────────────────────────────────────────
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


def _has_long_run(pw: str, max_run: int = 3) -> bool:
    """`max_run` 보다 더 연속된 동일 글자가 있는지 (#103)."""
    if not pw:
        return False
    last = pw[0]
    run = 1
    for ch in pw[1:]:
        if ch == last:
            run += 1
            if run > max_run:
                return True
        else:
            last = ch
            run = 1
    return False


def validate_password(
    pw: str,
    *,
    email: str | None = None,
    name: str | None = None,
) -> None:
    # #103: 폐쇄망 정책 강화 — 최소 10자, 같은 글자 4회 연속 금지.
    if len(pw) < 10:
        raise ValueError("비밀번호는 10자 이상이어야 합니다")
    if len(pw) > 128:
        raise ValueError("비밀번호가 너무 깁니다 (128자 이하)")
    if pw.lower() in _COMMON:
        raise ValueError("너무 흔한 비밀번호입니다")
    if len(_classes(pw)) < 2:
        raise ValueError(
            "영문 대/소문자, 숫자, 기호 중 두 종류 이상을 포함해야 합니다"
        )
    if _has_long_run(pw, 3):
        raise ValueError("같은 글자를 4회 이상 연속해서 쓸 수 없습니다")
    lowered = pw.lower()
    if email:
        local = email.split("@", 1)[0].lower()
        if len(local) >= 4 and local in lowered:
            raise ValueError("비밀번호에 이메일을 포함할 수 없습니다")
    if name and len(name) >= 3 and name.lower() in lowered:
        raise ValueError("비밀번호에 이름을 포함할 수 없습니다")


# ── Outbound URL safety (SSRF guard) ──────────────────────────────────
# Used by the RAG indexer for user-supplied URL / SFTP / API sources so
# an authenticated user can't point us at internal services (cloud
# metadata, the local ollama, internal admin panels) and exfil the
# response via the corpus → retrieval pipeline.


class UnsafeTargetError(RuntimeError):
    """Raised when a user-supplied hostname/URL resolves to a private,
    loopback, or otherwise non-routable target."""


def _is_blocked_ip(ip: ipaddress.IPv4Address | ipaddress.IPv6Address) -> bool:
    # Block every IP address class that an internal-only service would
    # ever bind to. Public ranges (1.1.1.1, 8.8.8.8) stay reachable.
    return (
        ip.is_private        # RFC1918 (10/8, 172.16/12, 192.168/16) + RFC4193 (fc00::/7)
        or ip.is_loopback    # 127.0.0.0/8, ::1
        or ip.is_link_local  # 169.254.0.0/16 (AWS metadata), fe80::/10
        or ip.is_reserved
        or ip.is_multicast
        or ip.is_unspecified  # 0.0.0.0
    )


def ensure_public_host(host: str | None) -> None:
    """Resolve `host` and raise UnsafeTargetError if any A/AAAA record
    points at a non-routable address. Multi-record hostnames are
    rejected if *any* record is internal — a hostile name could pin
    one good IP and one bad one to bypass the check otherwise."""
    if not host:
        raise UnsafeTargetError("호스트가 비어 있습니다")
    # Literal IP — skip DNS.
    try:
        ip = ipaddress.ip_address(host)
        if _is_blocked_ip(ip):
            raise UnsafeTargetError(
                f"내부 IP는 사용할 수 없습니다: {host}"
            )
        return
    except ValueError:
        pass  # not a literal IP, fall through to DNS

    # localhost short-circuit (DNS sometimes returns 127.0.0.1, sometimes
    # NXDOMAIN depending on /etc/hosts; we deny it either way).
    if host.lower() in {"localhost", "localhost.localdomain"}:
        raise UnsafeTargetError("localhost 는 사용할 수 없습니다")

    try:
        infos = socket.getaddrinfo(host, None, type=socket.SOCK_STREAM)
    except OSError as exc:
        raise UnsafeTargetError(f"호스트 해석 실패: {host} ({exc})") from exc
    if not infos:
        raise UnsafeTargetError(f"호스트 해석 결과 없음: {host}")
    for _fam, _stype, _proto, _canon, addr in infos:
        ip_str = addr[0]
        try:
            ip = ipaddress.ip_address(ip_str)
        except ValueError:
            continue
        if _is_blocked_ip(ip):
            raise UnsafeTargetError(
                f"내부 호스트로 해석됨: {host} → {ip_str}"
            )


def ensure_public_url(url: str) -> None:
    """Parse `url` and apply ensure_public_host on its hostname."""
    parsed = urlparse(url)
    ensure_public_host(parsed.hostname)

