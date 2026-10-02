#!/usr/bin/env bash
set -euo pipefail
project_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
test_dir="$(mktemp -d /tmp/xian-firmware-tests.XXXXXX)"
cc -std=c11 -Wall -Wextra -Werror -fsanitize=address,undefined \
    -I"${project_root}/main" \
    "${project_root}/tests/firmware/qin_game_test.c" \
    "${project_root}/main/services/exploration/qin_game.c" \
    -o "${test_dir}/qin_game_test"
"${test_dir}/qin_game_test"
