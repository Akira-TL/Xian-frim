#!/usr/bin/env bash
set -euo pipefail
project_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "${project_root}"
mkdir -p logs
test_dir="$(mktemp -d /tmp/changan-gateway.XXXXXX)"
export CHANGAN_DB_PATH="${test_dir}/test.sqlite3"
export CHANGAN_OPERATOR_TOKEN="gateway-test-operator"
export CHANGAN_TERMINAL_TOKEN="gateway-test-terminal"
export CHANGAN_BACKEND_ORIGIN="http://127.0.0.1:8123"
export CHANGAN_TEST_WEB_ORIGIN="http://127.0.0.1:3101"
export CHANGAN_PORT=8123
export PORT=3101
export CHANGAN_DEVICE_KEYS_PATH="${project_root}/services/web/tests/fixtures/device-keys.test.json"
unset CHANGAN_PUBLIC_ORIGIN
backend_pid=""
web_pid=""
cleanup() {
  if [[ -n "${web_pid}" ]]; then kill "${web_pid}" 2>/dev/null || true; wait "${web_pid}" 2>/dev/null || true; fi
  if [[ -n "${backend_pid}" ]]; then kill "${backend_pid}" 2>/dev/null || true; wait "${backend_pid}" 2>/dev/null || true; fi
}
trap cleanup EXIT INT TERM
bash scripts/backend.sh > logs/gateway-backend-run.log 2>&1 &
backend_pid=$!
bash scripts/web.sh start > logs/gateway-web-run.log 2>&1 &
web_pid=$!
ready=false
for ((attempt=0; attempt<60; attempt++)); do
  kill -0 "${backend_pid}" 2>/dev/null && kill -0 "${web_pid}" 2>/dev/null || exit 1
  if curl --silent --fail "${CHANGAN_BACKEND_ORIGIN}/health" >/dev/null && \
     curl --silent --fail "${CHANGAN_TEST_WEB_ORIGIN}/" >/dev/null; then ready=true; break; fi
  sleep .5
done
[[ "${ready}" == true ]] || { echo "隔离服务未就绪，查看 logs/" >&2; exit 1; }
node --test services/web/tests/public-gateway.test.ts > logs/web-gateway-test.log 2>&1
node --test services/web/tests/badge-control.test.ts > logs/web-control-test.log 2>&1
echo "查询测试结果：logs/web-gateway-test.log；隔离数据库保留在 ${test_dir}"
