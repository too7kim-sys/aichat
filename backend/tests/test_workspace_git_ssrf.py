"""코드 워크스페이스 git clone SSRF 가드 (#보안점검, RAG 외 지점).

_validate_git_url 은 WORKSPACE_ALLOWED_HOSTS 가 비어 있으면(폐쇄망
기본값) 임의 호스트를 통과시켰다 — 인증된 사용자가 git_url 로
내부망/메타데이터/loopback 을 찌르는 SSRF 가 가능했다.  허용목록이
없을 때는 공인 호스트만 통과해야 한다.
"""
from __future__ import annotations

import pytest

from app.code.workspace import _validate_git_url


def test_public_git_host_allowed(monkeypatch):
    import app.security as sec
    # 공인 IP 로만 해석되게 고정 (네트워크 의존 제거).
    monkeypatch.setattr(
        sec.socket, "getaddrinfo",
        lambda *a, **k: [(2, 1, 6, "", ("140.82.112.3", 0))],
    )
    scheme, host = _validate_git_url("https://github.com/org/repo.git")
    assert scheme == "https"
    assert host == "github.com"


@pytest.mark.parametrize(
    "url",
    [
        "http://169.254.169.254/latest/meta-data/",  # 클라우드 메타데이터
        "http://127.0.0.1/internal.git",             # loopback
        "https://10.0.0.5/repo.git",                 # RFC1918
        "http://192.168.1.10/x.git",                 # RFC1918
        "http://localhost/x.git",                    # localhost 이름
    ],
)
def test_internal_git_host_blocked_without_allowlist(url):
    with pytest.raises(ValueError):
        _validate_git_url(url)


def test_allowlisted_internal_host_permitted(monkeypatch):
    """허용목록에 등록된 사내 git 은 내부 IP 여도 허용 (관리자 신뢰)."""
    from app.config import settings
    monkeypatch.setattr(
        settings, "workspace_allowed_hosts", "git.intra.example.com",
    )
    scheme, host = _validate_git_url("https://git.intra.example.com/a/b.git")
    assert host == "git.intra.example.com"


def test_non_http_scheme_rejected():
    with pytest.raises(ValueError):
        _validate_git_url("ssh://git@github.com/org/repo.git")
    with pytest.raises(ValueError):
        _validate_git_url("file:///etc/passwd")
