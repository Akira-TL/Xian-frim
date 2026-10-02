"""授权与真实设备响应的事务；旧响应只可重试，不能回退进度。"""

from datetime import datetime, timedelta
import secrets

from .device_protocol import (
    DeviceEnvelope, DeviceKey, DeviceReport, DeviceState, unlock_packet, verify_report,
)
from .storage import BusinessError, Repository


class DeviceService:
    def __init__(self, repository: Repository, keys: tuple[DeviceKey, ...]) -> None:
        self.repository = repository
        self.keys = keys
        for key in keys:
            key.bytes()
        if len({key.device_id for key in keys}) != len(keys):
            raise ValueError("设备密钥配置包含重复身份")

    def key(self, device_id: str) -> bytes:
        for key in self.keys:
            if key.device_id == device_id:
                return key.bytes()
        raise BusinessError(503, "设备认证密钥尚未配置")

    def issue(self, badge_id: str, now: datetime, command_id: str | None = None,
              nonce: str | None = None) -> DeviceEnvelope:
        with self.repository.connection(write=True) as db:
            badge = db.execute("SELECT * FROM badges WHERE badge_id=?", (badge_id,)).fetchone()
            if badge is None:
                raise BusinessError(404, "腰牌未登记")
            key = self.key(badge["device_id"])
            expires = now + timedelta(seconds=30)
            if command_id is not None:
                if nonce is None:
                    raise BusinessError(422, "解锁授权缺少设备随机数")
                command = db.execute("SELECT * FROM commands WHERE command_id=?", (command_id,)).fetchone()
                if command is None or command["badge_id"] != badge_id or command["device_id"] != badge["device_id"]:
                    raise BusinessError(409, "请求与腰牌身份不匹配")
                expires = min(expires, datetime.fromisoformat(command["expires_at"]))
                if expires <= now:
                    raise BusinessError(409, "解锁请求已过期，请先回读设备状态")
            challenge = secrets.token_hex(16)
            payload = (b"CQ\x01" + bytes.fromhex(challenge) if command_id is None
                       else unlock_packet(key, badge["device_id"], nonce, command_id, challenge))
            db.execute("INSERT INTO device_challenges VALUES (?, ?, ?, ?, ?, NULL)",
                       (challenge, badge_id, badge["device_id"], command_id, expires.isoformat()))
            return DeviceEnvelope(challenge=challenge, payload_hex=payload.hex(), expires_at=expires.isoformat())

    @staticmethod
    def state(badge_id: str, device_id: str, flags: int, verified_at: str) -> DeviceState:
        return DeviceState(badge_id=badge_id, device_id=device_id, unlocked=bool(flags & 1),
                           completed=bool(flags & 2), collected=bool(flags & 4),
                           exhibiting=bool(flags & 8), verified_at=verified_at)

    def confirm(self, report: DeviceReport, now: datetime) -> DeviceState:
        with self.repository.connection(write=True) as db:
            challenge = db.execute("SELECT * FROM device_challenges WHERE challenge=?", (report.challenge,)).fetchone()
            if challenge is None:
                raise BusinessError(404, "设备挑战不存在")
            try:
                flags = verify_report(self.key(challenge["device_id"]), challenge["device_id"],
                                      report.challenge, challenge["command_id"], bytes.fromhex(report.payload_hex))
            except ValueError as error:
                raise BusinessError(409, str(error)) from error
            previous = db.execute("SELECT * FROM verified_progress WHERE badge_id=?", (challenge["badge_id"],)).fetchone()
            if challenge["accepted_payload"] is not None:
                if challenge["accepted_payload"] != report.payload_hex:
                    raise BusinessError(409, "已经消费的挑战不能换用另一回执")
                return self.state(challenge["badge_id"], challenge["device_id"], previous["flags"], previous["verified_at"])
            if datetime.fromisoformat(challenge["expires_at"]) <= now:
                raise BusinessError(409, "设备挑战已过期，请重新回读")
            # 当前展示只有一个收藏；四个标志均单向前进，不允许迟到响应回退。
            merged = flags | (previous["flags"] if previous else 0)
            db.execute("INSERT OR REPLACE INTO verified_progress VALUES (?, ?, ?, ?)",
                       (challenge["badge_id"], challenge["device_id"], merged, now.isoformat()))
            db.execute("UPDATE device_challenges SET accepted_payload=? WHERE challenge=?",
                       (report.payload_hex, report.challenge))
            if challenge["command_id"]:
                db.execute("UPDATE commands SET status='confirmed' WHERE command_id=?", (challenge["command_id"],))
            return self.state(challenge["badge_id"], challenge["device_id"], merged, now.isoformat())

    def progress(self, badge_id: str) -> DeviceState:
        with self.repository.connection() as db:
            row = db.execute("SELECT * FROM verified_progress WHERE badge_id=?", (badge_id,)).fetchone()
            if row is None:
                raise BusinessError(404, "尚未取得可信设备进度")
            return self.state(badge_id, row["device_id"], row["flags"], row["verified_at"])
