from fastapi.testclient import TestClient

from test_devices import DEVICE, authorize, device_client, report, submit
from test_visits import client, operator, post_scan, register, scan, terminal


def test_empty_activity_has_no_verified_progress(client: TestClient) -> None:
    response = client.get("/api/v1/activity", headers=operator())
    assert response.status_code == 200
    snapshot = response.json()
    assert snapshot["progress"] == {
        "game_id": "qin_formation", "eligible_badges": 0, "verified_badges": 0,
        "unlocked_badges": 0, "completed_badges": 0, "collected_badges": 0,
        "exhibiting_badges": 0, "last_verified_at": None,
    }
    assert [site["data_status"] for site in snapshot["map"]["sites"]] == ["missing"] * 3


def test_progress_counts_only_authenticated_devices_once(device_client: TestClient) -> None:
    register(device_client, badge_id="badge-002", device_id="esp32-other")
    post_scan(device_client, scan("scan-002").model_copy(update={"badge_id": "badge-002"}))
    # 请求已发送不算设备确认。
    sent = device_client.post("/api/v1/unlock-commands/unlock-001/sent",
                              json={"device_id": DEVICE}, headers=operator())
    assert sent.status_code == 200
    before = device_client.get("/api/v1/activity", headers=operator()).json()["progress"]
    assert (before["eligible_badges"], before["verified_badges"], before["unlocked_badges"]) == (2, 0, 0)
    receipt = report(authorize(device_client), 15)
    assert submit(device_client, receipt).status_code == 200
    assert submit(device_client, receipt).status_code == 200
    after = device_client.get("/api/v1/activity", headers=operator()).json()["progress"]
    assert after == {
        "game_id": "qin_formation", "eligible_badges": 2, "verified_badges": 1,
        "unlocked_badges": 1, "completed_badges": 1, "collected_badges": 1,
        "exhibiting_badges": 1, "last_verified_at": "2026-10-02T14:00:00Z",
    }


def test_generated_activity_never_reuses_physical_progress(device_client: TestClient) -> None:
    assert submit(device_client, report(authorize(device_client), 15)).status_code == 200
    post_scan(device_client, scan("generated-001"), "/api/v1/demo/visits")
    register(device_client, badge_id="generated-only", device_id="esp32-generated")
    post_scan(device_client, scan("generated-002").model_copy(update={"badge_id": "generated-only"}),
              "/api/v1/demo/visits")
    response = device_client.get("/api/v1/activity?source=generated_simulation", headers=operator())
    assert response.status_code == 200
    snapshot = response.json()
    assert snapshot["progress"] is None
    assert snapshot["map"]["source"] == "generated_simulation"
    assert snapshot["map"]["sites"][0]["recent_unique_badges"] == 2
    physical = device_client.get("/api/v1/activity", headers=operator()).json()
    assert physical["progress"]["eligible_badges"] == 1
    assert physical["progress"]["completed_badges"] == 1


def test_activity_is_staff_only_and_rejects_unknown_source(client: TestClient) -> None:
    assert client.get("/api/v1/activity").status_code == 401
    assert client.get("/api/v1/activity", headers=terminal()).status_code == 401
    assert client.get("/api/v1/activity?source=unknown", headers=operator()).status_code == 422


def test_interface_test_progress_is_authenticated_and_source_filtered(device_client: TestClient) -> None:
    register(device_client, "physical-only", "esp32-physical-only")
    post_scan(device_client, scan("physical-only-event").model_copy(update={"badge_id": "physical-only"}))
    payload = scan("test-progress-event").model_dump_json().replace('"k230-001"', '"interface-test-001"')
    assert device_client.post("/api/v1/interface-test/visits", content=payload, headers=operator()).status_code == 200
    before = device_client.get("/api/v1/activity?source=interface_test", headers=operator()).json()
    assert before["progress"] is not None
    assert before["progress"]["eligible_badges"] == 1
    assert before["progress"]["verified_badges"] == 0
    assert submit(device_client, report(authorize(device_client), 15)).status_code == 200
    after = device_client.get("/api/v1/activity?source=interface_test", headers=operator()).json()["progress"]
    assert after == {
        "game_id": "qin_formation", "eligible_badges": 1, "verified_badges": 1,
        "unlocked_badges": 1, "completed_badges": 1, "collected_badges": 1,
        "exhibiting_badges": 1, "last_verified_at": "2026-10-02T14:00:00Z",
    }
    assert device_client.get("/api/v1/activity", headers=operator()).json()["progress"]["eligible_badges"] == 2
    assert device_client.get("/api/v1/activity?source=generated_simulation", headers=operator()).json()["progress"] is None
