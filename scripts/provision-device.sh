#!/usr/bin/env bash
set -euo pipefail
project_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "${project_root}"
export PYTHONPATH="${project_root}/services/backend"
exec uv run -m changan.provision "$@"
