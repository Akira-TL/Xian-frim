"""有版本和方向前缀的固定长度设备消息；密钥不返回给工作人员网页。"""

import hashlib
import hmac
from typing import Annotated, Literal

from pydantic import AwareDatetime, Field, SecretStr

from .models import Contract, Identifier

HexNonce = Annotated[str, Field(pattern=r"^[0-9a-f]{32}$")]


class DeviceKey(Contract):
    device_id: Annotated[str, Field(pattern=r"^esp32s3-[0-9a-f]{12}$")]
    key: SecretStr

    def bytes(self) -> bytes:
        value = bytes.fromhex(self.key.get_secret_value())
        if len(value) != 32:
            raise ValueError("设备认证密钥必须为 32 字节")
        return value


class DeviceKeys(Contract):
    devices: list[DeviceKey]


class NonceRequest(Contract):
    nonce: HexNonce


class DeviceEnvelope(Contract):
    challenge: HexNonce
    payload_hex: str
    expires_at: AwareDatetime


class DeviceReport(Contract):
    challenge: HexNonce
    payload_hex: Annotated[str, Field(pattern=r"^[0-9a-f]{244}$")]


class DeviceState(Contract):
    badge_id: Identifier
    device_id: Identifier
    session_id: Literal["demo-001"] = "demo-001"
    game_id: Literal["qin_formation"] = "qin_formation"
    unlocked: bool
    completed: bool
    collected: bool
    exhibiting: bool
    verified_at: AwareDatetime


def device_mac(device_id: str) -> bytes:
    if not device_id.startswith("esp32s3-") or len(device_id) != 20:
        raise ValueError("设备标识不是 ESP32-S3 出厂身份")
    return bytes.fromhex(device_id[8:])


def signature(key: bytes, message: bytes) -> bytes:
    return hmac.new(key, message, hashlib.sha256).digest()


def unlock_packet(key: bytes, device_id: str, nonce: str, command_id: str, challenge: str) -> bytes:
    body = b"CU\x01" + device_mac(device_id) + bytes.fromhex(nonce)
    body += command_id.encode("ascii").ljust(64, b"\0") + bytes.fromhex(challenge)
    return body + signature(key, body)


def verify_report(key: bytes, device_id: str, challenge: str, command_id: str | None, packet: bytes) -> int:
    if len(packet) != 122 or packet[:3] != b"CS\x01":
        raise ValueError("回执版本或长度错误")
    if not hmac.compare_digest(signature(key, packet[:-32]), packet[-32:]):
        raise ValueError("设备认证失败")
    expected_command = (command_id or "").encode("ascii").ljust(64, b"\0")
    if (packet[3:9] != device_mac(device_id) or packet[9:25] != bytes.fromhex(challenge)
            or packet[26:90] != expected_command):
        raise ValueError("设备、挑战或请求身份不匹配")
    flags = packet[25]
    if flags not in (0, 1, 7, 15):
        raise ValueError("设备进度不满足收藏不变量")
    if command_id and not flags & 1:
        raise ValueError("设备没有确认解锁")
    return flags
