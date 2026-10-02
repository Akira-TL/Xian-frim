"""为单枚演示腰牌生成本地私有配置；重复运行复用密钥，不自动轮换。"""

import argparse
import os
from pathlib import Path
import re
import secrets
import tempfile
from typing import Annotated

from pydantic import Field

from .device_protocol import DeviceKeys, device_mac
from .models import Contract


class StoredDeviceKey(Contract):
    device_id: Annotated[str, Field(pattern=r"^esp32s3-[0-9a-f]{12}$")]
    key: Annotated[str, Field(pattern=r"^[0-9a-f]{64}$", repr=False)]


class StoredDeviceKeys(Contract):
    devices: list[StoredDeviceKey]


def private_directory(path: Path) -> None:
    if path.is_symlink():
        raise ValueError("私有配置目录不能是符号链接")
    path.mkdir(parents=True, exist_ok=True, mode=0o700)
    if not path.is_dir():
        raise ValueError("私有配置目录无效")


def header_bytes(device_id: str, key: bytes) -> bytes:
    def values(value: bytes) -> str:
        return ", ".join(f"0x{byte:02x}" for byte in value)

    return (
        "// 本地生成的设备密钥，禁止提交或复制到网页。\n#pragma once\n"
        "#include <stdint.h>\n#define CHANGAN_DEVICE_KEY_CONFIGURED 1\n"
        f"static const uint8_t changan_device_mac[6] = {{{values(device_mac(device_id))}}};\n"
        f"static const uint8_t changan_device_key[32] = {{{values(key)}}};\n"
    ).encode("utf-8")


def provision(device_id: str, data_directory: Path) -> Path:
    if re.fullmatch(r"esp32s3-[0-9a-f]{12}", device_id) is None:
        raise ValueError("必须提供实物出厂设备身份")
    private_directory(data_directory)
    config_path = data_directory / "device-keys.json"
    try:
        descriptor = os.open(config_path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    except FileExistsError:
        # 不跟随文件链接，也不把现有密钥静默替换为新密钥。
        descriptor = os.open(config_path, os.O_RDONLY | os.O_NOFOLLOW)
        with os.fdopen(descriptor, "r", encoding="utf-8") as stream:
            if os.fstat(stream.fileno()).st_mode & 0o077:
                raise ValueError("现有密钥文件必须仅允许所有者访问")
            configuration = DeviceKeys.model_validate_json(stream.read(65537))
        identifiers = [item.device_id for item in configuration.devices]
        if len(set(identifiers)) != len(identifiers):
            raise ValueError("设备身份不得重复")
        for item in configuration.devices:
            item.bytes()
        matches = [item for item in configuration.devices if item.device_id == device_id]
        if len(matches) != 1:
            raise ValueError("现有配置没有对应设备，拒绝覆盖")
        key = matches[0].bytes()
    else:
        key = secrets.token_bytes(32)
        configuration = StoredDeviceKeys(devices=[StoredDeviceKey(device_id=device_id, key=key.hex())])
        with os.fdopen(descriptor, "w", encoding="utf-8") as stream:
            stream.write(configuration.model_dump_json(indent=2) + "\n")
            stream.flush()
            os.fsync(stream.fileno())
    generated = data_directory / "generated"
    private_directory(generated)
    header = generated / "changan_device_key.h"
    # 原子替换只修改生成的头文件；临时文件权限默认 0600。
    with tempfile.NamedTemporaryFile(dir=generated, prefix=".device-key-", delete=False) as stream:
        temporary = Path(stream.name)
        try:
            stream.write(header_bytes(device_id, key))
            stream.flush()
            os.fsync(stream.fileno())
            os.replace(temporary, header)
        finally:
            temporary.unlink(missing_ok=True)
    return config_path


def main() -> None:
    parser = argparse.ArgumentParser(description="生成腰牌私有密钥配置，不烧录、不轮换密钥")
    parser.add_argument("device_id")
    parser.add_argument("--data-directory", type=Path, default=Path("data"))
    arguments = parser.parse_args()
    try:
        configuration = provision(arguments.device_id, arguments.data_directory)
    except (ValueError, OSError):
        # 校验异常可能包含原始输入，禁止在终端或日志回显密钥内容。
        parser.exit(1, "配置失败：检查设备身份、文件权限及现有配置；未输出任何密钥。\n")
    print(f"设备：{arguments.device_id}；后台配置：{configuration}；请重新配置并构建固件。")


if __name__ == "__main__":
    main()
