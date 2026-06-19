"""admin 라우터 패키지 — 원래 2236-line 단일 admin.py 가 부분 분리됨.

공개 인터페이스 (main.py 가 그대로 부르도록 유지):

  from .routers import admin
  app.include_router(admin.router)
  admin.start_backup_scheduler()  # lifespan 에서

내부 구조:
  _core.py    — router 인스턴스 + users / roles / settings / errors /
                audit / active-sessions / system-resources / model-
                usage / user-activity / backups / health / usage +
                start_backup_scheduler 등 핵심 + 큰 덩어리.
  integrity.py — #112~#115 백업 무결성 + 고아 행/파일.
  monitor.py   — #116~#120 요청 트레이싱 + 웹훅 알림.
  quality.py   — #37/#121~#124 disliked + escalations + feedback-stats.

이 import 들의 부수효과로 route 가 _core.router 에 등록된다.
"""
from ._core import router, start_backup_scheduler
# 아래 import 들은 정의된 route 데코레이터를 실행시키는 사이드이펙트가
# 목적 — 변수 자체는 안 쓰므로 'noqa: F401'.
from . import integrity  # noqa: F401
from . import monitor    # noqa: F401
from . import quality    # noqa: F401

__all__ = ["router", "start_backup_scheduler"]
