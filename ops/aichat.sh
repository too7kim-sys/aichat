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

# 이 서버에서 직접 관리할 서비스만 (ollama·nginx 는 별도 서버에 있음).
# 기동 순서: qdrant → backend
# 중지 순서: 역순 — 사용자 요청 받는 backend 부터 끊는다.
SERVICES_UP=(qdrant aichat-backend)
SERVICES_DN=(aichat-backend qdrant)

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
        # ollama는 별도 서버 — .env의 OLLAMA_BASE_URL을 따라 원격으로 확인.
        OLLAMA_URL="${OLLAMA_BASE_URL:-}"
        if [ -z "$OLLAMA_URL" ] && [ -f /data/projects/aichat/backend/.env ]; then
            OLLAMA_URL=$(grep -E '^OLLAMA_BASE_URL=' /data/projects/aichat/backend/.env \
                         | cut -d= -f2- | tr -d '"' | tr -d "'")
        fi
        if [ -n "$OLLAMA_URL" ]; then
            curl -fsS --max-time 3 "$OLLAMA_URL/api/tags" >/dev/null \
                && echo "  ✅ ollama   $OLLAMA_URL/api/tags" \
                || echo "  ❌ ollama   $OLLAMA_URL/api/tags  (원격 응답 없음)"
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
