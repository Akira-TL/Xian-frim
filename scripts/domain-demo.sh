#!/usr/bin/env bash
set -euo pipefail
case "${1:-status}" in
  start|stop|restart|status) sudo -n systemctl "${1:-status}" changan-demo.service ;;
  *) echo "用法：bash scripts/domain-demo.sh start|stop|restart|status" >&2; exit 2 ;;
esac
