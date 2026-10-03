"""跨端契约；拒绝未知字段，避免静默接受错误协议。"""

from datetime import datetime
from enum import StrEnum
from typing import Annotated, Literal, Self

from pydantic import AwareDatetime, BaseModel, ConfigDict, Field, model_validator

Identifier = Annotated[str, Field(min_length=1, max_length=47, pattern=r"^[A-Za-z0-9_-]+$")]
CommandId = Annotated[str, Field(min_length=1, max_length=63, pattern=r"^[A-Za-z0-9_-]+$")]
SiteId = Literal["A", "B", "C"]


class Contract(BaseModel):
    model_config = ConfigDict(extra="forbid")


class Source(StrEnum):
    PHYSICAL = "physical_scan_simulated_site"
    GENERATED = "generated_simulation"
    INTERFACE_TEST = "interface_test"


class BadgeRegistration(Contract):
    badge_id: Identifier
    display_number: Annotated[str, Field(min_length=1, max_length=12)]
    device_id: Identifier


class DemoPreparation(Contract):
    batch_id: Identifier


class ScanRequest(Contract):
    event_id: CommandId
    session_id: Literal["demo-001"]
    badge_id: Identifier
    terminal_id: Literal["k230-001"]
    site_id: SiteId
    config_version: Annotated[int, Field(ge=1)]
    captured_at: AwareDatetime
    time_quality: Literal["synced", "untrusted"]


class InterfaceTestScanRequest(ScanRequest):
    terminal_id: Literal["interface-test-001"]
    site_id: Literal["A"]
    config_version: Literal[1]


class Visit(Contract):
    event_id: str
    session_id: str
    badge_id: str
    terminal_id: str
    site_id: SiteId
    config_version: int
    captured_at: datetime
    received_at: datetime
    time_quality: Literal["synced", "untrusted"]
    source: Source


class ScanResponse(Contract):
    visit: Visit
    duplicate: bool
    can_unlock: bool


class TerminalConfiguration(Contract):
    terminal_id: Literal["k230-001"] = "k230-001"
    site_id: SiteId
    config_version: int
    source: Literal["physical_scan_simulated_site"] = "physical_scan_simulated_site"


class SiteSelection(Contract):
    site_id: SiteId


class UnlockRequest(Contract):
    command_id: CommandId
    event_id: CommandId
    badge_id: Identifier
    device_id: Identifier


class UnlockCommand(Contract):
    command_id: str
    event_id: str
    session_id: Literal["demo-001"]
    badge_id: str
    device_id: str
    game_id: Literal["qin_formation"] = "qin_formation"
    created_at: datetime
    expires_at: datetime
    status: Literal["pending", "sent", "confirmed", "unknown", "failed"]


class SentReport(Contract):
    device_id: Identifier


class ErrorResponse(Contract):
    detail: str


class Health(Contract):
    status: Literal["ok"] = "ok"


class TerminalHeartbeat(Contract):
    terminal_id: Literal["k230-001"]
    site_id: SiteId
    config_version: Annotated[int, Field(ge=1)]
    captured_at: AwareDatetime


class HeartbeatReceipt(TerminalHeartbeat):
    received_at: datetime


class SiteStatistics(Contract):
    site_id: SiteId
    recent_unique_badges: int
    previous_unique_badges: int
    change: int
    excluded_untrusted_events: int
    updated_at: datetime | None
    data_status: Literal["fresh", "stale", "missing", "untrusted"]
    heat: Literal["low", "medium", "high", "insufficient"]


class TrendPoint(Contract):
    site_id: SiteId
    window_start: datetime
    window_end: datetime
    unique_badges: int


class TransitionCount(Contract):
    from_site: SiteId
    to_site: SiteId
    count: int


class HeatThresholds(Contract):
    medium_min: Annotated[int, Field(strict=True, ge=1, le=2147483647)] = 3
    high_min: Annotated[int, Field(strict=True, ge=2, le=2147483647)] = 6

    @model_validator(mode="after")
    def ordered(self) -> Self:
        if self.high_min <= self.medium_min:
            raise ValueError("高热度起点必须大于中热度起点")
        return self


class MapSnapshot(Contract):
    session_id: Literal["demo-001"] = "demo-001"
    source: Source
    generated_at: datetime
    window_seconds: Literal[300] = 300
    stale_after_seconds: Literal[90] = 90
    demo_thresholds: Literal[True] = True
    heat_thresholds: HeatThresholds = Field(default_factory=HeatThresholds)
    metric_label: Literal["参与腰牌打卡数据；非实时在场人数"] = "参与腰牌打卡数据；非实时在场人数"
    sites: list[SiteStatistics]
    trend: list[TrendPoint]
    transitions: list[TransitionCount]


class DeviceProgressSummary(Contract):
    game_id: Literal["qin_formation"] = "qin_formation"
    eligible_badges: Annotated[int, Field(ge=0)] = 0
    verified_badges: Annotated[int, Field(ge=0)] = 0
    unlocked_badges: Annotated[int, Field(ge=0)] = 0
    completed_badges: Annotated[int, Field(ge=0)] = 0
    collected_badges: Annotated[int, Field(ge=0)] = 0
    exhibiting_badges: Annotated[int, Field(ge=0)] = 0
    last_verified_at: datetime | None = None


class ActivitySnapshot(Contract):
    map: MapSnapshot
    progress: DeviceProgressSummary | None
