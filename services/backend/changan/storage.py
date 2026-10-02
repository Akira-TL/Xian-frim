"""到访与解锁的事务边界。"""

from collections.abc import Iterator
from contextlib import contextmanager
from datetime import datetime, timedelta, timezone
from hashlib import sha256
from pathlib import Path
import sqlite3

from .models import (
    BadgeRegistration, ScanRequest, ScanResponse, Source, TerminalConfiguration,
    UnlockCommand, UnlockRequest, Visit, HeartbeatReceipt, TerminalHeartbeat, DeviceProgressSummary,
)


class BusinessError(Exception):
    def __init__(self, status: int, detail: str) -> None:
        super().__init__(detail)
        self.status = status
        self.detail = detail


class Repository:
    def __init__(self, path: Path) -> None:
        self.path = path
        path.parent.mkdir(parents=True, exist_ok=True)
        with self.connection() as db:
            db.executescript(Path(__file__).with_name("schema.sql").read_text())

    @contextmanager
    def connection(self, *, write: bool = False) -> Iterator[sqlite3.Connection]:
        db = sqlite3.connect(self.path, timeout=10)
        db.row_factory = sqlite3.Row
        db.execute("PRAGMA foreign_keys = ON")
        try:
            if write:
                db.execute("BEGIN IMMEDIATE")
            yield db
            db.commit()
        except Exception:
            db.rollback()
            raise
        finally:
            db.close()

    def register(self, badge: BadgeRegistration) -> BadgeRegistration:
        with self.connection(write=True) as db:
            row = db.execute("SELECT * FROM badges WHERE badge_id = ?", (badge.badge_id,)).fetchone()
            if row:
                if (row["device_id"], row["display_number"]) != (badge.device_id, badge.display_number):
                    raise BusinessError(409, "腰牌已登记为另一设备或编号")
            else:
                try:
                    db.execute("INSERT INTO badges VALUES (?, ?, ?)",
                               (badge.badge_id, badge.display_number, badge.device_id))
                except sqlite3.IntegrityError as error:
                    raise BusinessError(409, "该实物设备已经绑定其他腰牌") from error
        return badge

    def badges(self) -> list[BadgeRegistration]:
        with self.connection() as db:
            return [BadgeRegistration(badge_id=row["badge_id"], display_number=row["display_number"],
                                      device_id=row["device_id"])
                    for row in db.execute("SELECT * FROM badges ORDER BY badge_id")]

    @staticmethod
    def visit(row: sqlite3.Row) -> Visit:
        return Visit(
            event_id=row["event_id"], session_id=row["session_id"], badge_id=row["badge_id"],
            terminal_id=row["terminal_id"], site_id=row["site_id"], config_version=row["config_version"],
            captured_at=row["captured_at"], received_at=row["received_at"],
            time_quality=row["time_quality"], source=row["source"],
        )

    @staticmethod
    def scan_response(visit: Visit, duplicate: bool) -> ScanResponse:
        return ScanResponse(visit=visit, duplicate=duplicate,
                            can_unlock=visit.source == Source.PHYSICAL and visit.site_id == "A")

    def scan(self, request: ScanRequest, now: datetime, source: Source = Source.PHYSICAL) -> ScanResponse:
        payload_hash = sha256((source + request.model_dump_json()).encode()).hexdigest()
        captured = request.captured_at.astimezone(timezone.utc)
        with self.connection(write=True) as db:
            receipt = db.execute("SELECT * FROM scan_receipts WHERE event_id = ?", (request.event_id,)).fetchone()
            if receipt:
                if receipt["payload_hash"] != payload_hash:
                    raise BusinessError(409, "事件编号已被不同内容使用")
                visit = db.execute("SELECT * FROM visits WHERE event_id = ?", (receipt["visit_id"],)).fetchone()
                return self.scan_response(self.visit(visit), True)
            if not db.execute("SELECT 1 FROM badges WHERE badge_id = ?", (request.badge_id,)).fetchone():
                raise BusinessError(404, "腰牌未登记")
            config = db.execute(
                "SELECT site_id FROM terminal_configs WHERE terminal_id = ? AND config_version = ?",
                (request.terminal_id, request.config_version),
            ).fetchone()
            if not config or config["site_id"] != request.site_id:
                raise BusinessError(409, "终端地点与配置版本不匹配")
            if request.time_quality == "synced" and captured > now + timedelta(seconds=30):
                raise BusinessError(422, "采集时间超出允许的时钟偏差")
            dedup_at = (captured if request.time_quality == "synced" else now).timestamp()
            existing = db.execute(
                "SELECT * FROM visits WHERE session_id=? AND badge_id=? AND site_id=? AND source=? "
                "AND dedup_at BETWEEN ? AND ? ORDER BY dedup_at, event_id LIMIT 1",
                (request.session_id, request.badge_id, request.site_id, source, dedup_at - 60, dedup_at + 60),
            ).fetchone()
            visit_id = existing["event_id"] if existing else request.event_id
            if not existing:
                db.execute(
                    "INSERT INTO visits VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                    (visit_id, request.session_id, request.badge_id, request.terminal_id,
                     request.site_id, request.config_version, captured.isoformat(), now.isoformat(),
                     request.time_quality, source, dedup_at),
                )
            db.execute("INSERT INTO scan_receipts VALUES (?, ?, ?)",
                       (request.event_id, payload_hash, visit_id))
            row = existing or db.execute("SELECT * FROM visits WHERE event_id = ?", (visit_id,)).fetchone()
            return self.scan_response(self.visit(row), existing is not None)

    def visits(self) -> list[Visit]:
        with self.connection() as db:
            return [self.visit(row) for row in db.execute("SELECT * FROM visits ORDER BY received_at DESC, event_id")]

    def configuration(self) -> TerminalConfiguration:
        with self.connection() as db:
            row = db.execute("SELECT * FROM terminal_configs ORDER BY config_version DESC LIMIT 1").fetchone()
            return TerminalConfiguration(site_id=row["site_id"], config_version=row["config_version"])

    def heartbeat(self, request: TerminalHeartbeat, now: datetime) -> HeartbeatReceipt:
        captured = request.captured_at.astimezone(timezone.utc)
        if captured > now + timedelta(seconds=30):
            raise BusinessError(422, "心跳采集时间超出允许的时钟偏差")
        with self.connection(write=True) as db:
            config = db.execute(
                "SELECT site_id FROM terminal_configs WHERE terminal_id=? AND config_version=?",
                (request.terminal_id, request.config_version),
            ).fetchone()
            if not config or config["site_id"] != request.site_id:
                raise BusinessError(409, "终端地点与配置版本不匹配")
            previous = db.execute("SELECT captured_at FROM heartbeats WHERE terminal_id=? AND site_id=?",
                                  (request.terminal_id, request.site_id)).fetchone()
            if previous is None or datetime.fromisoformat(previous["captured_at"]) < captured:
                db.execute("INSERT OR REPLACE INTO heartbeats VALUES (?, ?, ?, ?, ?)",
                           (request.terminal_id, request.site_id, request.config_version,
                            captured.isoformat(), now.isoformat()))
        return HeartbeatReceipt(terminal_id=request.terminal_id, site_id=request.site_id,
                                config_version=request.config_version, captured_at=captured, received_at=now)

    def observations(self) -> tuple[list[Visit], list[HeartbeatReceipt]]:
        # 同一读取事务，避免地图中的到访与终端反馈来自两个不同瞬间。
        with self.connection() as db:
            db.execute("BEGIN")
            visits = [self.visit(row) for row in db.execute("SELECT * FROM visits")]
            heartbeats = [HeartbeatReceipt(terminal_id=row["terminal_id"], site_id=row["site_id"],
                                           config_version=row["config_version"], captured_at=row["captured_at"],
                                           received_at=row["received_at"])
                          for row in db.execute("SELECT * FROM heartbeats")]
            return visits, heartbeats

    def activity_observations(self) -> tuple[list[Visit], list[HeartbeatReceipt], DeviceProgressSummary]:
        # 地图与设备进度必须来自同一读取事务。
        with self.connection() as db:
            db.execute("BEGIN")
            visits = [self.visit(row) for row in db.execute("SELECT * FROM visits")]
            heartbeats = [HeartbeatReceipt(terminal_id=row["terminal_id"], site_id=row["site_id"],
                                           config_version=row["config_version"], captured_at=row["captured_at"],
                                           received_at=row["received_at"])
                          for row in db.execute("SELECT * FROM heartbeats")]
            row = db.execute("""
                WITH eligible AS (
                    SELECT DISTINCT badge_id FROM visits
                    WHERE session_id = 'demo-001' AND source = ? AND site_id = 'A'
                )
                SELECT COUNT(*) AS eligible_badges,
                       COUNT(p.badge_id) AS verified_badges,
                       COALESCE(SUM((p.flags & 1) != 0), 0) AS unlocked_badges,
                       COALESCE(SUM((p.flags & 2) != 0), 0) AS completed_badges,
                       COALESCE(SUM((p.flags & 4) != 0), 0) AS collected_badges,
                       COALESCE(SUM((p.flags & 8) != 0), 0) AS exhibiting_badges,
                       MAX(p.verified_at) AS last_verified_at
                FROM eligible e LEFT JOIN verified_progress p ON p.badge_id = e.badge_id
            """, (Source.PHYSICAL,)).fetchone()
            progress = DeviceProgressSummary(
                eligible_badges=row["eligible_badges"], verified_badges=row["verified_badges"],
                unlocked_badges=row["unlocked_badges"], completed_badges=row["completed_badges"],
                collected_badges=row["collected_badges"], exhibiting_badges=row["exhibiting_badges"],
                last_verified_at=row["last_verified_at"],
            )
            return visits, heartbeats, progress

    def select_site(self, site_id: str) -> TerminalConfiguration:
        with self.connection(write=True) as db:
            row = db.execute("SELECT * FROM terminal_configs ORDER BY config_version DESC LIMIT 1").fetchone()
            version = row["config_version"]
            if row["site_id"] != site_id:
                version += 1
                db.execute("INSERT INTO terminal_configs VALUES ('k230-001', ?, ?)", (version, site_id))
            return TerminalConfiguration(site_id=site_id, config_version=version)

    @staticmethod
    def command(row: sqlite3.Row) -> UnlockCommand:
        return UnlockCommand(
            command_id=row["command_id"], event_id=row["event_id"], session_id="demo-001",
            badge_id=row["badge_id"], device_id=row["device_id"], created_at=row["created_at"],
            expires_at=row["expires_at"], status=row["status"],
        )

    def commands(self) -> list[UnlockCommand]:
        with self.connection() as db:
            return [self.command(row) for row in db.execute(
                "SELECT * FROM commands ORDER BY created_at DESC, command_id")]

    def unlock(self, request: UnlockRequest, now: datetime) -> UnlockCommand:
        with self.connection(write=True) as db:
            visit = db.execute("SELECT * FROM visits WHERE event_id = ?", (request.event_id,)).fetchone()
            badge = db.execute("SELECT * FROM badges WHERE badge_id = ?", (request.badge_id,)).fetchone()
            if not visit or not badge:
                raise BusinessError(404, "到访或腰牌不存在")
            if visit["badge_id"] != request.badge_id or badge["device_id"] != request.device_id:
                raise BusinessError(409, "到访、腰牌与实物设备身份不一致")
            if visit["source"] != Source.PHYSICAL:
                raise BusinessError(403, "模拟数据不能控制实物腰牌")
            if visit["site_id"] != "A":
                raise BusinessError(409, "该地点游戏尚未实现")
            existing_id = db.execute("SELECT * FROM commands WHERE command_id = ?", (request.command_id,)).fetchone()
            if existing_id and existing_id["event_id"] != request.event_id:
                raise BusinessError(409, "请求编号已关联其他到访")
            existing = existing_id or db.execute("SELECT * FROM commands WHERE event_id = ?", (request.event_id,)).fetchone()
            if existing:
                return self.command(existing)
            db.execute("INSERT INTO commands VALUES (?, ?, ?, ?, ?, ?, 'pending')",
                       (request.command_id, request.event_id, request.badge_id, request.device_id,
                        now.isoformat(), (now + timedelta(minutes=5)).isoformat()))
            row = db.execute("SELECT * FROM commands WHERE command_id = ?", (request.command_id,)).fetchone()
            return self.command(row)

    def mark_sent(self, command_id: str, device_id: str, now: datetime) -> UnlockCommand:
        with self.connection(write=True) as db:
            row = db.execute("SELECT * FROM commands WHERE command_id = ?", (command_id,)).fetchone()
            if not row:
                raise BusinessError(404, "解锁请求不存在")
            if row["device_id"] != device_id:
                raise BusinessError(409, "设备身份不匹配")
            if datetime.fromisoformat(row["expires_at"]) <= now and row["status"] != "confirmed":
                raise BusinessError(409, "解锁请求已过期，请先读取设备状态")
            if row["status"] == "pending":
                db.execute("UPDATE commands SET status='sent' WHERE command_id=?", (command_id,))
            return self.command(db.execute("SELECT * FROM commands WHERE command_id=?", (command_id,)).fetchone())
