#!/usr/bin/env bash
# 운영기에서 한 줄 배포: git pull → 의존성 갱신 → 프런트 빌드 → restart.
#
# 사용:
#   ./ops/deploy.sh                 # 기본 브랜치 pull + 재기동
#   DEPLOY_BRANCH=main ./ops/deploy.sh   # 다른 브랜치
#
# 사전 1회 셋업:
#   sudo apt install -y nodejs npm           # Node가 없으면
#   sudo ln -sf /data/projects/aichat/ops/deploy.sh /usr/local/bin/aichat-deploy
#   # 그러면 어디서든 `aichat-deploy` 한 줄로 됨
set -euo pipefail

cd "$(dirname "$0")/.."           # /data/projects/aichat
BRANCH="${DEPLOY_BRANCH:-claude/chat-feature-llm-design-BTyox}"

echo "▶ git pull ($BRANCH)"
git fetch --prune origin
git checkout "$BRANCH"
git reset --hard "origin/$BRANCH"

echo "▶ DB 백업 스냅샷"
TS=$(date +%Y%m%d-%H%M%S)
mkdir -p backups
cp backend/aichat.db "backups/aichat-$TS-pre.db" 2>/dev/null || true
# 30일 지난 백업 자동 정리
find backups -name 'aichat-*-pre.db' -mtime +30 -delete 2>/dev/null || true

echo "▶ backend 의존성"
if [ -f backend/requirements.txt ]; then
    # PyPI 도달되면 그냥 install, 안 되면 wheels 폴더 fallback
    if curl -fsS --max-time 5 https://pypi.org/ >/dev/null; then
        backend/.venv/bin/pip install --quiet -r backend/requirements.txt
    elif [ -d backend/wheels ]; then
        backend/.venv/bin/pip install --quiet --no-index \
            --find-links backend/wheels -r backend/requirements.txt
    else
        echo "  ⚠ PyPI 도달 안 되고 backend/wheels 도 없음 — 의존성 갱신 건너뜀"
    fi
fi

echo "▶ frontend build"
if command -v npm >/dev/null 2>&1; then
    cd frontend
    if [ ! -d node_modules ] || [ package-lock.json -nt node_modules ]; then
        npm ci
    fi
    npm run build
    cd ..
else
    echo "  ⚠ npm 없음 — frontend/dist 갱신 안 됨. 'sudo apt install -y nodejs npm' 한 번 필요"
fi

echo "▶ __pycache__ 정리 (stale .pyc 제거)"
find backend/app -name "__pycache__" -type d -exec rm -rf {} + 2>/dev/null || true

echo "▶ 백엔드 재기동"
sudo systemctl restart aichat-backend
sleep 3

echo "▶ 헬스체크"
for i in 1 2 3 4 5; do
    if curl -fsS --max-time 5 http://127.0.0.1:9000/api/health >/dev/null; then
        echo "  ✅ backend /api/health OK"
        echo
        echo "배포 완료 — 브라우저는 Ctrl+Shift+R 로 강력 새로고침"
        exit 0
    fi
    sleep 2
done

echo "  ❌ 헬스체크 실패 — journalctl -u aichat-backend -n 30 으로 원인 확인"
exit 1
