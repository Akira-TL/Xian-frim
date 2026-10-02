from datetime import datetime, timedelta, timezone
from pathlib import Path

from fastapi.testclient import TestClient
import pytest

from changan.api import create_app
from changan.models import (
    BadgeRegistration, ScanRequest, ScanResponse, SentReport, SiteSelection,
    TerminalConfiguration, UnlockCommand, UnlockRequest, Visit,
)
from pydantic import TypeAdapter

NOW = datetime(2026, 10, 2, 14, 0, tzinfo=timezone.utc)


@pytest.fixture
def client(tmp_path: Path) -> TestClient:
    return TestClient(create_app(tmp_path / "test.sqlite3", "operator-test", "terminal-test", lambda: NOW))


def operator() -> list[tuple[str, str]]:
    return [("Authorization", "Bearer operator-test"), ("Content-Type", "application/json")]


def terminal() -> list[tuple[str, str]]:
    return [("Authorization", "Bearer terminal-test"), ("Content-Type", "application/json")]


def register(client: TestClient, badge_id: str = "badge-001", device_id: str = "esp32-test") -> None:
    request = BadgeRegistration(badge_id=badge_id, display_number="001", device_id=device_id)
    assert client.post("/api/v1/badges", content=request.model_dump_json(), headers=operator()).status_code == 200


def scan(event_id: str = "scan-001", seconds: int = 0) -> ScanRequest:
    return ScanRequest(event_id=event_id, session_id="demo-001", badge_id="badge-001",
                       terminal_id="k230-001", site_id="A", config_version=1,
                       captured_at=NOW + timedelta(seconds=seconds), time_quality="synced")


def post_scan(client: TestClient, request: ScanRequest, route: str = "/api/v1/visits") -> ScanResponse:
    response = client.post(route, content=request.model_dump_json(),
                           headers=operator() if "/demo/" in route else terminal())
    assert response.status_code == 200, response.text
    return ScanResponse.model_validate_json(response.text)


def test_staff_can_read_registry_without_exposing_it_to_terminal(client: TestClient) -> None:
    register(client)
    response = client.get("/api/v1/badges", headers=operator())
    assert response.status_code == 200
    assert TypeAdapter(list[BadgeRegistration]).validate_json(response.text) == [
        BadgeRegistration(badge_id="badge-001", display_number="001", device_id="esp32-test")
    ]
    assert client.get("/api/v1/badges", headers=terminal()).status_code == 401
    assert client.get("/api/v1/badges").status_code == 401


def test_scan_retry_and_short_window_have_one_visit(client: TestClient) -> None:
    register(client)
    first = post_scan(client, scan())
    assert not first.duplicate and first.can_unlock
    assert post_scan(client, scan()).duplicate
    second = post_scan(client, scan("scan-002", -40))
    assert second.duplicate and second.visit.event_id == "scan-001"
    # 超过 60 秒另计一次；统计去重仍应按腰牌而非人次。
    third = post_scan(client, scan("scan-003", -61))
    assert not third.duplicate
    response = client.get("/api/v1/visits", headers=operator())
    visits = TypeAdapter(list[Visit]).validate_json(response.text)
    assert len(visits) == 2


def test_reused_event_id_with_different_payload_is_rejected(client: TestClient) -> None:
    register(client)
    post_scan(client, scan())
    response = client.post("/api/v1/visits", content=scan(seconds=-1).model_dump_json(), headers=terminal())
    assert response.status_code == 409


def test_unknown_badge_is_rejected(client: TestClient) -> None:
    response = client.post("/api/v1/visits", content=scan().model_dump_json(), headers=terminal())
    assert response.status_code == 404


def test_terminal_switch_preserves_old_event_and_offline_config(client: TestClient) -> None:
    register(client)
    first = post_scan(client, scan())
    response = client.put("/api/v1/terminal/configuration",
                          content=SiteSelection(site_id="B").model_dump_json(), headers=operator())
    config = TerminalConfiguration.model_validate_json(response.text)
    assert config.site_id == "B" and config.config_version == 2
    # 切换前已采集、未送达的 A 点事件仍使用版本 1。
    delayed = post_scan(client, scan("offline-A", -120))
    assert delayed.visit.site_id == "A" and delayed.visit.config_version == 1
    new = scan("scan-B").model_copy(update={"site_id": "B", "config_version": 2})
    assert post_scan(client, new).visit.site_id == "B"
    retry = post_scan(client, scan())
    assert retry.visit == first.visit
    bad = scan("bad-config").model_copy(update={"site_id": "B"})
    assert client.post("/api/v1/visits", content=bad.model_dump_json(), headers=terminal()).status_code == 409


def test_unlock_requires_correct_physical_identity_and_real_visit(client: TestClient) -> None:
    register(client)
    post_scan(client, scan())
    wrong = UnlockRequest(command_id="unlock-001", event_id="scan-001",
                          badge_id="badge-001", device_id="wrong-device")
    assert client.post("/api/v1/unlock-commands", content=wrong.model_dump_json(), headers=operator()).status_code == 409
    right = wrong.model_copy(update={"device_id": "esp32-test"})
    response = client.post("/api/v1/unlock-commands", content=right.model_dump_json(), headers=operator())
    command = UnlockCommand.model_validate_json(response.text)
    assert command.status == "pending" and command.game_id == "qin_formation"
    retry = right.model_copy(update={"command_id": "different-request-id"})
    result = client.post("/api/v1/unlock-commands", content=retry.model_dump_json(), headers=operator())
    assert UnlockCommand.model_validate_json(result.text).command_id == "unlock-001"
    sent = client.post("/api/v1/unlock-commands/unlock-001/sent",
                       content=SentReport(device_id="esp32-test").model_dump_json(), headers=operator())
    assert UnlockCommand.model_validate_json(sent.text).status == "sent"
    generated = post_scan(client, scan("fake-scan", -10), "/api/v1/demo/visits")
    assert not generated.can_unlock
    fake_unlock = right.model_copy(update={"event_id": "fake-scan", "command_id": "fake-unlock"})
    assert client.post("/api/v1/unlock-commands", content=fake_unlock.model_dump_json(), headers=operator()).status_code == 403


def test_auth_roles_do_not_allow_terminal_to_control_badge(client: TestClient) -> None:
    register(client)
    assert client.post("/api/v1/visits", content=scan().model_dump_json(), headers=operator()).status_code == 401
    request = UnlockRequest(command_id="x", event_id="x", badge_id="badge-001", device_id="esp32-test")
    assert client.post("/api/v1/unlock-commands", content=request.model_dump_json(), headers=terminal()).status_code == 401


def test_unknown_fields_and_naive_time_are_rejected(client: TestClient) -> None:
    register(client)
    payload = scan().model_dump_json().replace('"time_quality":"synced"', '"time_quality":"synced","source":"generated_simulation"')
    assert client.post("/api/v1/visits", content=payload, headers=terminal()).status_code == 422
    payload = scan().model_dump_json().replace("Z", "")
    assert client.post("/api/v1/visits", content=payload, headers=terminal()).status_code == 422


def test_registry_and_visits_survive_backend_restart(tmp_path: Path) -> None:
    path = tmp_path / "persistent.sqlite3"
    first = TestClient(create_app(path, "operator-test", "terminal-test", lambda: NOW))
    register(first)
    post_scan(first, scan())
    restarted = TestClient(create_app(path, "operator-test", "terminal-test", lambda: NOW))
    assert post_scan(restarted, scan()).duplicate


def test_non_ascii_authorization_is_rejected_without_server_error(client: TestClient) -> None:
    # HTTP 字段可携带单字节扩展字符；无效令牌应返回 401 而不是抛出异常。
    response = client.get("/api/v1/visits", headers=[("Authorization", b"Bearer \xff")])
    assert response.status_code == 401


def test_staff_reads_request_status_without_confirming_execution(client: TestClient) -> None:
    register(client)
    post_scan(client, scan())
    request = UnlockRequest(command_id="unlock-001", event_id="scan-001",
                            badge_id="badge-001", device_id="esp32-test")
    created = client.post("/api/v1/unlock-commands", content=request.model_dump_json(), headers=operator())
    pending = UnlockCommand.model_validate_json(created.text)
    response = client.get("/api/v1/unlock-commands", headers=operator())
    assert response.status_code == 200
    assert TypeAdapter(list[UnlockCommand]).validate_json(response.text) == [pending]
    client.post("/api/v1/unlock-commands/unlock-001/sent",
                content=SentReport(device_id="esp32-test").model_dump_json(), headers=operator())
    for _ in range(2):
        listed = TypeAdapter(list[UnlockCommand]).validate_json(
            client.get("/api/v1/unlock-commands", headers=operator()).text)
        assert listed == [pending.model_copy(update={"status": "sent"})]
    assert client.get("/api/v1/badges/badge-001/progress", headers=operator()).status_code == 404
    assert client.get("/api/v1/unlock-commands", headers=terminal()).status_code == 401
    assert client.get("/api/v1/unlock-commands").status_code == 401
