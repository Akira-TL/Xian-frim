#!/usr/bin/env bash
set -euo pipefail
project_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "${project_root}"
action="${1:-inspect}"
port="${2:-/dev/ttyACM0}"
case "${action}" in
    inspect|flash|monitor) ;;
    *) echo "用法：bash scripts/device.sh inspect|flash|monitor [串口]" >&2; exit 2 ;;
esac
if [[ ! -c "${port}" ]]; then
    echo "串口不存在或当前执行环境不能访问：${port}" >&2
    exit 1
fi
mkdir -p logs
source /home/Akira/github/esp-idf/export.sh >/dev/null
case "${action}" in
    inspect)
        esptool.py --chip esp32s3 --port "${port}" read_mac 2>&1 | tee logs/device-inspect.log
        esptool.py --chip esp32s3 --port "${port}" flash_id 2>&1 | tee -a logs/device-inspect.log
        ;;
    flash)
        # 使用已构建的分区映像；不执行 erase-flash，不擦除游戏 NVS 分区。
        idf.py -B build --no-auto-reconfigure -p "${port}" flash 2>&1 | tee logs/device-flash.log
        ;;
    monitor)
        idf.py -B build -p "${port}" monitor 2>&1 | tee logs/device-monitor.log
        ;;
esac
