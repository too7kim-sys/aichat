#!/usr/bin/env bash
# Quick sanity check for an MSI EdgeXpert acting as the Ollama host
# for this app. Run on the EdgeXpert itself (over SSH).
set -euo pipefail

echo "== Ollama service =="
systemctl is-active ollama || { echo "ollama not running"; exit 1; }
echo "  active"

echo
echo "== Effective Ollama environment =="
systemctl show ollama -p Environment | tr ' ' '\n' | grep -E '^OLLAMA_' || \
    echo "  (no OLLAMA_* env set — drop override.conf into /etc/systemd/system/ollama.service.d/)"

echo
echo "== Listening sockets =="
ss -ltnp 2>/dev/null | grep 11434 || \
    echo "  port 11434 not bound (check OLLAMA_HOST)"

echo
echo "== Loaded models =="
ollama ps || true

echo
echo "== GPU =="
nvidia-smi --query-gpu=name,memory.used,memory.total,utilization.gpu \
    --format=csv 2>/dev/null || echo "  nvidia-smi unavailable"

echo
echo "== Disk for model cache =="
df -h "${OLLAMA_MODELS:-/usr/share/ollama/.ollama/models}" 2>/dev/null \
    || df -h / | tail -1

echo
echo "== Smoke prompt =="
time curl -sS http://127.0.0.1:11434/api/generate \
    -d '{"model":"qwen2.5-coder:32b","prompt":"hello","stream":false,"options":{"num_predict":16}}' \
    | python3 -c 'import json,sys;print(json.load(sys.stdin).get("response","(no response)"))'
