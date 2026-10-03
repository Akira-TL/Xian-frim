#!/usr/bin/env bash
set -euo pipefail
project_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "${project_root}"
source /home/Akira/github/esp-idf/export.sh >/dev/null
exec uv run --no-project --python "${IDF_PYTHON_ENV_PATH}/bin/python" scripts/device/observe.py "$@"
