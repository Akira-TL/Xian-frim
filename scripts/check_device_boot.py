"""实机启动回归检查：复位后采集日志，检查刷新卡住与内部内存不足。"""

import argparse
from pathlib import Path
import time

import serial
from esptool.reset import HardReset


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--port", default="/dev/ttyACM0")
    parser.add_argument("--seconds", type=float, default=25)
    parser.add_argument("--log", type=Path, default=Path("logs/device-boot-check.log"))
    arguments = parser.parse_args()
    if arguments.seconds < 15:
        parser.error("采集时间至少十五秒，以覆盖屏幕看门狗触发时间")
    arguments.log.parent.mkdir(parents=True, exist_ok=True)
    captured = bytearray()
    with serial.Serial(arguments.port, 115200, timeout=0.25) as device:
        device.reset_input_buffer()
        device.dtr = False
        HardReset(device, uses_usb=True)()
        deadline = time.monotonic() + arguments.seconds
        with arguments.log.open("wb") as stream:
            while time.monotonic() < deadline:
                chunk = device.read(device.in_waiting or 1)
                stream.write(chunk)
                captured.extend(chunk)
    text = captured.decode("utf-8", errors="replace")
    failures = (
        "spi transmit (queue) color failed", "Opus codec task is out of memory",
        "Task watchdog got triggered", "Guru Meditation Error", "abort() was called",
    )
    found = [message for message in failures if message in text]
    if "advertising started!" not in text:
        found.append("未观察到蓝牙广播启动")
    if "切换页面:exploration" not in text:
        found.append("未观察到游戏首页启动")
    if found:
        print("启动检查失败：" + "；".join(found))
        return 1
    print("启动检查通过：游戏首页与蓝牙广播启动，采集窗口内无指定内存／刷新／看门狗错误")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
