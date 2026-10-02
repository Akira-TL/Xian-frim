#!/usr/bin/env bash
set -euo pipefail
project_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "${project_root}"
mkdir -p logs
export PYTHONPATH="${project_root}/services/backend"
# 前台运行；终端中断直接交给服务进程，避免日志管道遗留后台服务。
echo "后台日志：${project_root}/logs/backend.log"
exec uv run uvicorn changan.api:create_app_from_environment --factory \
    --host "${CHANGAN_BIND_HOST:-127.0.0.1}" --port "${CHANGAN_PORT:-8000}" \
    >> logs/backend.log 2>&1
