"""projects 라우터 패키지 — 원래 1554-line 단일 projects.py 가 부분 분리.

공개 인터페이스 (main.py 가 그대로 부르도록 유지):

  from .routers import projects
  app.include_router(projects.router)

내부:
  _core.py  — 프로젝트 CRUD + 스냅샷 + access + 검색 + chunk-source.
  uploads.py — 사용자 문서 업로드/다운로드/삭제 + 진행도 endpoints.
"""
from ._core import router
from . import uploads  # noqa: F401 — import 사이드이펙트로 라우트 등록.

__all__ = ["router"]
