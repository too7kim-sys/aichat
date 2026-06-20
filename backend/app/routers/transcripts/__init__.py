"""transcripts 라우터 패키지 — 원래 792-line 단일 파일에서 분리.

공개 인터페이스 (main.py 그대로):
  from .routers import transcripts
  app.include_router(transcripts.router)

내부:
  _core.py        — CRUD + 업로드 + rename + extract-actions
  export.py       — HWPX / DOCX 회의록 내보내기
  whisper_admin.py — _whisper-status / _whisper-download
"""
from ._core import router
from . import export  # noqa: F401 — import 사이드이펙트로 route 등록.
from . import whisper_admin  # noqa: F401

__all__ = ["router"]
