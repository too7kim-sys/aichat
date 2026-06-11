#!/usr/bin/env bash
# 사용법:
#   ./ops/aichat.sh start      # 전체 기동
#   ./ops/aichat.sh stop       # 전체 중지
#   ./ops/aichat.sh restart    # 전체 재기동
#   ./ops/aichat.sh status     # 한눈에 상태 확인
#
# 운영 환경에 맞춰 환경변수로 토글:
#   QDRANT_DOCKER=1            # qdrant를 docker로 띄우는 경우
#   /etc/default/aichat 에 위 줄을 넣어두면 systemd에서도 일관되게 적용
set -euo pipefail

# 환경 파일이 있으면 로드 (QDRANT_DOCKER 등)
[ -f /etc/default/aichat ] && . /etc/default/aichat

ACT="${1:-status}"

# 기동 순서: ollama → qdrant → backend → nginx
# 중지 순서: 역순 — 사용자 접근부터 끊고, LLM은 가장 마지막
SERVICES_UP=(ollama qdrant aichat-backend nginx)
SERVICES_DN=(nginx aichat-backend qdrant ollama)

QDRANT_DOCKER="${QDRANT_DOCKER:-0}"

start_one() {
    local s="$1"
    if [[ "$s" == "qdrant" && "$QDRANT_DOCKER" == "1" ]]; then
        sudo docker start qdrant >/dev/null && echo "  ✅ qdrant (docker)" \
            || echo "  ⚠ qdrant (docker) 실패"
        return
    fi
    if systemctl list-unit-files | grep -q "^${s}\.service"; then
        sudo systemctl start "$s" && echo "  ✅ $s" || echo "  ⚠ $s 실패"
    else
        echo "  ⏭ $s (unit 없음, 건너뜀)"
    fi
}

stop_one() {
    local s="$1"
    if [[ "$s" == "qdrant" && "$QDRANT_DOCKER" == "1" ]]; then
        sudo docker stop qdrant >/dev/null 2>&1 && echo "  ⛔ qdrant (docker)" \
            || echo "  ⏭ qdrant"
        return
    fi
    if systemctl list-unit-files | grep -q "^${s}\.service"; then
        sudo systemctl stop "$s" && echo "  ⛔ $s" || echo "  ⚠ $s 중지 실패"
    else
        echo "  ⏭ $s (unit 없음)"
    fi
}

case "$ACT" in
    start)
        echo "▶ 기동 (ollama → qdrant → backend → nginx)"
        for s in "${SERVICES_UP[@]}"; do start_one "$s"; sleep 1; done
        echo
        sleep 2
        "$0" status
        ;;
    stop)
        echo "▶ 중지 (nginx → backend → qdrant → ollama)"
        for s in "${SERVICES_DN[@]}"; do stop_one "$s"; done
        ;;
    restart)
        "$0" stop
        sleep 2
        "$0" start
        ;;
    status)
        echo "── 서비스 ──"
        for s in ollama qdrant aichat-backend nginx; do
            if [[ "$s" == "qdrant" && "$QDRANT_DOCKER" == "1" ]]; then
                state=$(sudo docker inspect -f '{{.State.Status}}' qdrant 2>/dev/null \
                        || echo "absent")
                printf "  %-18s %s\n" "$s (docker)" "$state"
            else
                if systemctl list-unit-files | grep -q "^${s}\.service"; then
                    printf "  %-18s %s\n" "$s" "$(systemctl is-active "$s")"
                fi
            fi
        done

        echo "── 헬스 ──"
        curl -fsS --max-time 3 http://127.0.0.1:9000/api/health >/dev/null \
            && echo "  ✅ backend  /api/health" \
            || echo "  ❌ backend  /api/health"
        curl -fsS --max-time 3 http://127.0.0.1:11434/api/tags >/dev/null \
            && echo "  ✅ ollama   /api/tags" \
            || echo "  ❌ ollama   /api/tags"
        curl -fsS --max-time 3 http://127.0.0.1/ >/dev/null \
            && echo "  ✅ nginx    /" \
            || echo "  ❌ nginx    /"

        echo "── 디스크 ──"
        df -h /data 2>/dev/null | tail -1 || df -h / | tail -1
        ;;
    *)
        echo "사용법: $0 {start|stop|restart|status}"
        exit 1
        ;;
esac
