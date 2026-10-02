"""跨端契约；拒绝未知字段，避免静默接受错误协议。"""

from datetime import datetime
from enum import StrEnum
from typing import Annotated, Literal

from pydantic import AwareDatetime, BaseModel, ConfigDict, Field

Identifier = Annotated[str, Field(min_length=1, max_length=47, pattern=r"^[A-Za-z0-9_-]+$")]
CommandId = Annotated[str, Field(min_length=1, max_length=63, pattern=r"^[A-Za-z0-9_-]+$")]
SiteId = Literal["A", "B", "C"]


class Contract(BaseModel):
    model_config = ConfigDict(extra="forbid")


class Source(StrEnum):
    PHYSICAL = "physical_scan_simulated_site"
    GENERATED = "generated_simulation"


class BadgeRegistration(Contract):
    badge_id: Identifier
    display_number: Annotated[str, Field(min_length=1, max_length=12)]
    device_id: Identifier


class ScanRequest(Contract):
    event_id: CommandId
    session_id: Literal["demo-001"]
    badge_id: Identifier
    terminal_id: Literal["k230-001"]
    site_id: SiteId
    config_version: Annotated[int, Field(ge=1)]
    captured_at: AwareDatetime
    time_quality: Literal["synced", "untrusted"]


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
