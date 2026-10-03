"""只读采集运行中的腰牌串口；不发送命令，不主动复位，不判定验收通过。"""

import argparse
from datetime import datetime, timezone
from pathlib import Path
import time

import serial


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--port", default="/dev/ttyACM0")
    parser.add_argument("--seconds", type=float, default=1800)
    parser.add_argument("--log", type=Path, required=True)
    arguments = parser.parse_args()
    if not 1 <= arguments.seconds <= 7200:
        parser.error("采集时间必须在1至7200秒之间")
    arguments.log.parent.mkdir(parents=True, exist_ok=True)
    # 先设置控制线，再打开；不调用 HardReset，也不清空已有输入缓冲。
    device = serial.Serial(port=None, baudrate=115200, timeout=0.25)
    device.dtr = False
    device.rts = False
    device.port = arguments.port
    started = time.monotonic()
    total_bytes = 0
    # 不覆盖旧证据；文件已存在时拒绝开始。
    with arguments.log.open("xb") as stream, device:
        print(f"开始只读采集：{datetime.now(timezone.utc).isoformat()}，{arguments.seconds:g}秒", flush=True)
        while time.monotonic() - started < arguments.seconds:
            chunk = device.read(device.in_waiting or 1)
            if chunk:
                stream.write(chunk)
                stream.flush()
                total_bytes += len(chunk)
    print(f"采集结束：{datetime.now(timezone.utc).isoformat()}，{total_bytes}字节；不代表稳定性或触摸验收通过", flush=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
