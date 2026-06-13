"""시스템 자원 스냅샷 — 관리자 대시보드 + 헬스체크에서 같이 사용.

psutil 한 번 / GPU 한 번 / 디스크 한 번 호출로 합치고 그대로 dict
반환. 폴링 (관리자 화면이 5초마다 한 번) 정도면 충분히 가볍다.
GPU 가 없거나 nvidia-smi 가 PATH 에 없으면 gpu=null.
"""
from __future__ import annotations

import logging
import shutil
import subprocess
from pathlib import Path

log = logging.getLogger("uvicorn.error")


def _disk_for(path: str) -> dict:
    try:
        u = shutil.disk_usage(path)
        return {
            "path": str(path),
            "total": u.total,
            "used": u.used,
            "free": u.free,
            "pct": round(u.used * 100 / u.total, 1) if u.total else 0.0,
        }
    except OSError as exc:
        return {"path": str(path), "error": str(exc)}


def _gpu_query() -> list[dict] | None:
    """nvidia-smi 가 있으면 GPU 목록 + 메모리·사용률 반환. 없으면 None."""
    if not shutil.which("nvidia-smi"):
        return None
    try:
        proc = subprocess.run(
            [
                "nvidia-smi",
                "--query-gpu=index,name,memory.used,memory.total,"
                "utilization.gpu,temperature.gpu",
                "--format=csv,noheader,nounits",
            ],
            capture_output=True, text=True, timeout=5, check=False,
        )
    except (OSError, subprocess.TimeoutExpired) as exc:
        log.warning("nvidia-smi 실패: %s", exc)
        return None
    if proc.returncode != 0:
        return None
    out: list[dict] = []
    for line in proc.stdout.splitlines():
        cols = [c.strip() for c in line.split(",")]
        if len(cols) < 6:
            continue
        try:
            out.append({
                "index": int(cols[0]),
                "name": cols[1],
                "memory_used_mb": int(cols[2]),
                "memory_total_mb": int(cols[3]),
                "utilization_pct": int(cols[4]),
                "temperature_c": int(cols[5]),
            })
        except ValueError:
            continue
    return out


def snapshot(disk_paths: list[str] | None = None) -> dict:
    """CPU / mem / 디스크 / GPU 통합 스냅샷."""
    import psutil
    cpu = psutil.cpu_percent(interval=None)
    cores = psutil.cpu_count(logical=True) or 0
    load = list(psutil.getloadavg()) if hasattr(psutil, "getloadavg") else []
    mem = psutil.virtual_memory()
    swap = psutil.swap_memory()
    disks = [_disk_for(p) for p in (disk_paths or ["/"]) if Path(p).exists()]
    return {
        "cpu": {
            "percent": cpu,
            "cores": cores,
            "load_avg": load,
        },
        "memory": {
            "total": mem.total,
            "used": mem.used,
            "available": mem.available,
            "pct": mem.percent,
            "swap_total": swap.total,
            "swap_used": swap.used,
            "swap_pct": swap.percent,
        },
        "disks": disks,
        "gpu": _gpu_query(),
    }
