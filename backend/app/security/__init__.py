"""Network-target safety helpers — block SSRF to internal hosts.

Used by the RAG indexer (HTTP URL sources, SFTP sources, optional DB
URL sources). A user submits the source URL when creating a project,
so without a guard they could point the backend at internal services
(cloud metadata, the local ollama, internal admin panels) and exfil
the response body via the corpus → retrieval pipeline.
"""
from __future__ import annotations

import ipaddress
import socket
from urllib.parse import urlparse


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
        raise UnsafeTargetError(f"localhost 는 사용할 수 없습니다")

    try:
        infos = socket.getaddrinfo(host, None, type=socket.SOCK_STREAM)
    except OSError as exc:
        raise UnsafeTargetError(f"호스트 해석 실패: {host} ({exc})") from exc
    if not infos:
        raise UnsafeTargetError(f"호스트 해석 결과 없음: {host}")
    for fam, _stype, _proto, _canon, addr in infos:
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
