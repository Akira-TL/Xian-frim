#!/usr/bin/env bash
set -euo pipefail
project_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "${project_root}"
mode="${1:-dev}"
case "${mode}" in dev|start) ;; *) echo "用法：bash scripts/demo.sh dev|start" >&2; exit 2 ;; esac
# 两个服务共享本次运行的内部令牌；用户无需输入，不写入浏览器或日志。
export CHANGAN_OPERATOR_TOKEN="${CHANGAN_OPERATOR_TOKEN:-$(openssl rand -hex 32)}"
export CHANGAN_TERMINAL_TOKEN="${CHANGAN_TERMINAL_TOKEN:-$(openssl rand -hex 32)}"
export CHANGAN_PORT="${CHANGAN_PORT:-8000}"
export CHANGAN_BACKEND_ORIGIN="${CHANGAN_BACKEND_ORIGIN:-http://127.0.0.1:${CHANGAN_PORT}}"
export PORT="${PORT:-3000}"
export UV_CACHE_DIR="${UV_CACHE_DIR:-/tmp/xian-frim-uv-cache}"
if [[ -z "${CHANGAN_DEVICE_KEYS_PATH:-}" && -f data/device-keys.json ]]; then
  export CHANGAN_DEVICE_KEYS_PATH="${project_root}/data/device-keys.json"
fi
backend_pid=""
web_pid=""
cleanup() {
  if [[ -n "${web_pid}" ]]; then kill "${web_pid}" 2>/dev/null || true; wait "${web_pid}" 2>/dev/null || true; fi
  if [[ -n "${backend_pid}" ]]; then kill "${backend_pid}" 2>/dev/null || true; wait "${backend_pid}" 2>/dev/null || true; fi
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
bash scripts/backend.sh &
backend_pid=$!
bash scripts/web.sh "${mode}" &
web_pid=$!
echo "免登录演示：电脑打开 http://127.0.0.1:${PORT}；手机需另配可信 HTTPS 地址。"
echo "按 Ctrl+C 停止本次启动的两个服务；任一服务退出时同时停止另一个。"
if wait -n "${backend_pid}" "${web_pid}"; then exit 0; else exit "$?"; fi
