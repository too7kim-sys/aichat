"""SSRF DNS 리바인딩 방지 — resolve_and_pin 회귀 가드.

ensure_public_host 는 검증만 하고 IP 를 버려, 호출부가 hostname 으로
재연결하면 DNS 재해석 창(리바인딩)이 열린다.  resolve_and_pin 은 한
번의 해석으로 검증 + IP 반환을 동시에 해 그 창을 없앤다.
"""
from __future__ import annotations

import pytest

from app.security import UnsafeTargetError, resolve_and_pin


def test_literal_public_ip_returned_as_is():
    assert resolve_and_pin("93.184.216.34") == "93.184.216.34"


@pytest.mark.parametrize(
    "host",
    [
        "127.0.0.1",       # loopback
        "10.0.0.5",        # RFC1918
        "192.168.1.1",     # RFC1918
        "172.16.0.9",      # RFC1918
        "169.254.169.254", # link-local (클라우드 메타데이터)
        "0.0.0.0",         # unspecified
        "::1",             # IPv6 loopback
        "localhost",       # 이름
    ],
)
def test_internal_targets_blocked(host):
    with pytest.raises(UnsafeTargetError):
        resolve_and_pin(host)


def test_empty_host_blocked():
    with pytest.raises(UnsafeTargetError):
        resolve_and_pin("")
    with pytest.raises(UnsafeTargetError):
        resolve_and_pin(None)


def test_pin_matches_a_resolved_address(monkeypatch):
    """정상 hostname 은 해석된 공인 IP 를 그대로 반환 (그 IP 로 직접
    연결 → 재해석 없음 → 리바인딩 불가)."""
    import app.security as sec

    def fake_getaddrinfo(host, *a, **k):
        # 모두 공인 IP 만 반환.
        return [(2, 1, 6, "", ("93.184.216.34", 0))]

    monkeypatch.setattr(sec.socket, "getaddrinfo", fake_getaddrinfo)
    assert resolve_and_pin("example.com") == "93.184.216.34"


def test_mixed_public_and_internal_records_rejected(monkeypatch):
    """악의적 DNS 가 공인+내부 IP 를 섞어 반환하면 전체 거부 —
    한쪽만 통과시켜 우회하는 것을 막는다."""
    import app.security as sec

    def fake_getaddrinfo(host, *a, **k):
        return [
            (2, 1, 6, "", ("93.184.216.34", 0)),   # 공인
            (2, 1, 6, "", ("169.254.169.254", 0)), # 메타데이터
        ]

    monkeypatch.setattr(sec.socket, "getaddrinfo", fake_getaddrinfo)
    with pytest.raises(UnsafeTargetError):
        resolve_and_pin("evil.example.com")
