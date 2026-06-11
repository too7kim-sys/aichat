#!/usr/bin/env bash
# 사용법:
#   ./ops/aichat.sh start      # qdrant → backend 순서로 일괄 기동
#   ./ops/aichat.sh stop       # 역순으로 일괄 중지
#   ./ops/aichat.sh restart    # 전체 재기동
#   ./ops/aichat.sh status     # 한눈에 상태 확인
#
# 사전 등록 (1회):
#   sudo cp ops/qdrant.service          /etc/systemd/system/
#   sudo cp ops/aichat-backend.service  /etc/systemd/system/
#   sudo systemctl daemon-reload
#   sudo systemctl enable qdrant aichat-backend
set -euo pipefail

# ollama·nginx 는 별도 서버. 이 서버에서 직접 잡는 건 둘뿐.
# qdrant 도 systemd 가 docker 컨테이너를 wrapping (ops/qdrant.service)
# 하므로 일관되게 systemctl 로 다룬다.
SERVICES_UP=(qdrant aichat-backend)
SERVICES_DN=(aichat-backend qdrant)

unit_exists() {
    systemctl list-unit-files | grep -q "^${1}\.service"
}

start_one() {
    local s="$1"
    if unit_exists "$s"; then
        sudo systemctl start "$s" && echo "  ✅ $s" || echo "  ⚠ $s 기동 실패"
    else
        echo "  ⏭ $s (systemd unit 없음, 등록 필요)"
    fi
}

stop_one() {
    local s="$1"
    if unit_exists "$s"; then
        sudo systemctl stop "$s" && echo "  ⛔ $s" || echo "  ⚠ $s 중지 실패"
    else
        echo "  ⏭ $s (systemd unit 없음)"
    fi
}

ACT="${1:-status}"

case "$ACT" in
    start)
        echo "▶ 기동 (qdrant → backend)"
        for s in "${SERVICES_UP[@]}"; do start_one "$s"; sleep 1; done
        echo
        sleep 2
        "$0" status
        ;;
    stop)
        echo "▶ 중지 (backend → qdrant)"
        for s in "${SERVICES_DN[@]}"; do stop_one "$s"; done
        ;;
    restart)
        "$0" stop
        sleep 2
        "$0" start
        ;;
    status)
        echo "── 서비스 (이 서버) ──"
        for s in qdrant aichat-backend; do
            if unit_exists "$s"; then
                printf "  %-18s %s\n" "$s" "$(systemctl is-active "$s")"
            else
                printf "  %-18s %s\n" "$s" "unit 없음"
            fi
        done

        echo "── 헬스 ──"
        # backend
        curl -fsS --max-time 3 http://127.0.0.1:9000/api/health >/dev/null \
            && echo "  ✅ backend  /api/health" \
            || echo "  ❌ backend  /api/health"
        # qdrant — 자기 자신 localhost 로 한 번 찔러봄
        curl -fsS --max-time 3 http://127.0.0.1:6333/ >/dev/null \
            && echo "  ✅ qdrant   :6333/" \
            || echo "  ❌ qdrant   :6333/"
        # ollama — .env 의 OLLAMA_BASE_URL 을 따라 원격 확인.
        # CRLF / 따옴표 / 앞뒤 공백 제거 (Windows 에서 작성된 .env 대응)
        OLLAMA_URL="${OLLAMA_BASE_URL:-}"
        if [ -z "$OLLAMA_URL" ] && [ -f /data/projects/aichat/backend/.env ]; then
            OLLAMA_URL=$(grep -E '^OLLAMA_BASE_URL=' /data/projects/aichat/backend/.env \
                         | cut -d= -f2- | tr -d '"' | tr -d "'" | tr -d '\r' | xargs)
        fi
        if [ -n "$OLLAMA_URL" ]; then
            curl -fsS --max-time 3 "$OLLAMA_URL/api/tags" >/dev/null \
                && echo "  ✅ ollama   $OLLAMA_URL" \
                || echo "  ❌ ollama   $OLLAMA_URL  (원격 응답 없음)"
        else
            echo "  ⏭ ollama   (OLLAMA_BASE_URL 미설정)"
        fi

        echo "── 디스크 ──"
        df -h /data 2>/dev/null | tail -1 || df -h / | tail -1
        ;;
    *)
        echo "사용법: $0 {start|stop|restart|status}"
        exit 1
        ;;
esac
