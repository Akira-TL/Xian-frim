#!/usr/bin/env bash
set -euo pipefail
project_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "${project_root}/services/web"
# 不隔离子进程，保证受限执行环境中确实运行具名断言，而非只报告测试文件退出。
node --experimental-strip-types --test --test-isolation=none --test-reporter=tap \
  tests/cover-transfer.test.ts tests/cover-photo.test.ts tests/demo-badge.test.ts
