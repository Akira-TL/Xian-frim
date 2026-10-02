#!/usr/bin/env bash
set -euo pipefail
project_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "${project_root}"
source /home/Akira/github/esp-idf/export.sh >/dev/null
# 复用 SDK 中的 pyserial 与 esptool，不向后台环境安装设备依赖。
exec uv run --no-project --python "${IDF_PYTHON_ENV_PATH}/bin/python" scripts/check_device_boot.py "$@"
