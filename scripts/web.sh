#!/usr/bin/env bash
set -euo pipefail
project_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
mode="${1:-dev}"
case "${mode}" in
  dev|start) ;;
  *) echo "用法：bash scripts/web.sh dev|start" >&2; exit 2 ;;
esac
mkdir -p "${project_root}/logs"
cd "${project_root}/services/web"
export NEXT_TELEMETRY_DISABLED=1
echo "网页日志：${project_root}/logs/web-${mode}.log"
# 仅监听本机；手机 HTTPS 接入由受控反向代理单独配置。
exec node node_modules/next/dist/bin/next "${mode}" --hostname 127.0.0.1 \
    >> "${project_root}/logs/web-${mode}.log" 2>&1
