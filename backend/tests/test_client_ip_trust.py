"""IP 출처 신뢰 정책 회귀 가드 (#보안점검).

raw X-Forwarded-For 를 직접 파싱하면 프록시 없이 직접 노출된 배포
에서 공격자가 헤더를 위조해 레이트리밋 우회 / 감사로그 IP 위조를
할 수 있다.  _client_ip 계열은 모두 request.client.host 만 신뢰해야
한다 (프록시 뒤에서는 uvicorn --proxy-headers 가 채워줌).
"""
from __future__ import annotations


class _Client:
    def __init__(self, host: str):
        self.host = host


class _FakeRequest:
    """_client_ip 가 보는 최소 인터페이스만 흉내."""

    def __init__(self, host: str, xff: str | None = None):
        self.client = _Client(host)
        self.headers = {}
        if xff is not None:
            self.headers["x-forwarded-for"] = xff


def test_rate_limit_client_ip_ignores_xff():
    from app.routers._rate_limit import _client_ip

    req = _FakeRequest("10.0.0.9", xff="1.2.3.4, 5.6.7.8")
    # 위조된 XFF 가 아니라 실제 peer IP 가 키여야.
    assert _client_ip(req) == "10.0.0.9"


def test_audit_client_ip_ignores_xff():
    from app.audit import _client_ip

    req = _FakeRequest("10.0.0.9", xff="9.9.9.9")
    assert _client_ip(req) == "10.0.0.9"


def test_request_log_client_ip_ignores_xff():
    from app.request_log import _client_ip

    req = _FakeRequest("10.0.0.9", xff="9.9.9.9")
    assert _client_ip(req) == "10.0.0.9"


def test_error_log_client_ip_ignores_xff():
    from app.error_log import _client_ip

    req = _FakeRequest("10.0.0.9", xff="9.9.9.9")
    assert _client_ip(req) == "10.0.0.9"
