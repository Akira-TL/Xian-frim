#!/usr/bin/env bash
set -euo pipefail
project_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
firmware_build_dir="${BUILD_DIR:-${project_root}/build}"
test_build_dir="${firmware_build_dir}/qin-render-test"
mkdir -p "${project_root}/logs"
cmake -S "${project_root}/tests/firmware/render" -B "${test_build_dir}" -G Ninja \
    -DFIRMWARE_BUILD_DIR="${firmware_build_dir}" \
    > "${project_root}/logs/qin-render-test-build.log" 2>&1
cmake --build "${test_build_dir}" -j 6 >> "${project_root}/logs/qin-render-test-build.log" 2>&1
"${test_build_dir}/qin_render_test"
