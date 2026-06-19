"""협업(cowork) 라우터 — 팀·코멘트·알림·액션아이템·워크플로 이력 (#89~94).

원래는 단일 906-line `cowork.py` 였으나 정리 차원에서 5개 파일로 분리.
공개 인터페이스는 그대로:

  from .routers.cowork import (
      teams_router, comments_router, notifications_router,
      actions_router, runs_router, extract_actions_from_transcript,
  )
"""
from .actions import actions_router, extract_actions_from_transcript
from .comments import comments_router
from .notifications import notifications_router
from .runs import runs_router
from .teams import teams_router

__all__ = [
    "actions_router",
    "comments_router",
    "extract_actions_from_transcript",
    "notifications_router",
    "runs_router",
    "teams_router",
]
