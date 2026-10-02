#!/usr/bin/env bash
set -euo pipefail
project_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
test_dir="$(mktemp -d /tmp/xian-firmware-tests.XXXXXX)"
cc -std=c11 -Wall -Wextra -Werror -fsanitize=address,undefined \
    -I"${project_root}/main" \
    "${project_root}/tests/firmware/qin_game_test.c" \
    "${project_root}/main/services/exploration/qin_game.c" \
    -o "${test_dir}/qin_game_test"
# 沙箱以 ptrace 执行进程，LeakSanitizer 无法工作；仍启用地址和未定义行为检查。
ASAN_OPTIONS=detect_leaks=0 "${test_dir}/qin_game_test"
cc -std=c11 -Wall -Wextra -Werror -fsanitize=address,undefined \
    -I"${project_root}/main" \
    "${project_root}/tests/firmware/badge_auth_test.c" \
    "${project_root}/main/services/exploration/badge_auth.c" \
    -lcrypto -o "${test_dir}/badge_auth_test"
ASAN_OPTIONS=detect_leaks=0 "${test_dir}/badge_auth_test"
