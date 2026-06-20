"""code 라우터 패키지 — 원래 2266-line 단일 code.py 가 부분 분리됨.

공개 인터페이스 (main.py 가 그대로 부르도록 유지):

  from .routers import code
  app.include_router(code.router)

내부:
  _core.py — 워크스페이스 lifecycle (CRUD/sync/tree/file/apply/diff/
             commit/push) + 공유 헬퍼 + 모든 입력 스키마 + router 정의.
  tools.py — AI 도구 (refactor/tests/document/security/changelog) + git
             extras (tag/cherry-pick/reset/compare) + 통계
             (outline/contributors/activity/symbols) + drag-drop 업로드 +
             zip import + bulk delete.

이 import 들의 부수효과로 tools.py 의 route 가 _core.router 에 등록.
"""
from ._core import router
from . import tools  # noqa: F401 — import 사이드이펙트로 라우트 등록.

__all__ = ["router"]
