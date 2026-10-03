from datetime import datetime, timedelta, timezone
from pathlib import Path

from fastapi.testclient import TestClient

from changan.api import create_app
from changan.models import DemoPreparation, Source, UnlockRequest
from changan.storage import Repository, BusinessError
import pytest


def test_demo_preparation_is_fresh_isolated_and_retry_safe(tmp_path: Path) -> None:
    now = datetime(2026, 10, 3, 9, tzinfo=timezone.utc)
    client = TestClient(create_app(tmp_path / "demo.sqlite3", "operator", "terminal", lambda: now))
    headers = {"Authorization": "Bearer operator", "Content-Type": "application/json"}
    body = DemoPreparation(batch_id="first").model_dump_json()
    assert client.post("/api/v1/demo/prepare", content=body).status_code == 401
    assert client.post("/api/v1/demo/prepare", content=body, headers={"Authorization": "Bearer terminal"}).status_code == 401
    first = client.post("/api/v1/demo/prepare", content=body, headers=headers)
    assert first.status_code == 200
    records = first.json()
    assert len(records) == 10
    assert all(record["source"] == Source.GENERATED for record in records)
    assert all(record["terminal_id"] == "demo-generator-001" for record in records)
    now += timedelta(seconds=5)
    assert client.post("/api/v1/demo/prepare", content=body, headers=headers).json() == records
    assert len(client.get("/api/v1/visits", headers=headers).json()) == 10
    generated = client.get("/api/v1/activity?source=generated_simulation", headers=headers).json()
    assert generated["progress"] is None
    assert [(site["recent_unique_badges"], site["heat"], site["data_status"]) for site in generated["map"]["sites"]] == [
        (6, "high", "fresh"), (3, "medium", "fresh"), (1, "low", "fresh")]
    physical = client.get("/api/v1/activity", headers=headers).json()
    assert all(site["recent_unique_badges"] == 0 for site in physical["map"]["sites"])
    assert physical["progress"]["eligible_badges"] == 0
    request = UnlockRequest(command_id="blocked", event_id=records[0]["event_id"],
                            badge_id=records[0]["badge_id"], device_id="virtual-map-A-1")
    assert client.post("/api/v1/unlock-commands", content=request.model_dump_json(), headers=headers).status_code == 403
    assert client.get("/api/v1/unlock-commands", headers=headers).json() == []
    recommendation = client.post("/api/v1/recommendations", headers=headers,
                                 json={"badge_id": "demo-map-A-1", "event_id": records[0]["event_id"]})
    assert recommendation.status_code == 200
    assert recommendation.json()["selected_site"] == "C"
    assert {item["site"]["site_id"] for item in recommendation.json()["input"]["candidates"]} == {"B", "C"}
    assert recommendation.json()["input"]["completed_games"] == []
    now += timedelta(seconds=90)
    second = client.post("/api/v1/demo/prepare", content=DemoPreparation(batch_id="second").model_dump_json(), headers=headers)
    assert second.status_code == 200
    assert len(client.get("/api/v1/visits", headers=headers).json()) == 20
    assert client.get("/api/v1/terminal/configuration", headers={"Authorization": "Bearer terminal"}).json()["config_version"] == 1


def test_demo_collision_rolls_back_without_overwriting(tmp_path: Path) -> None:
    repository = Repository(tmp_path / "collision.sqlite3")
    with repository.connection(write=True) as db:
        db.execute("INSERT INTO badges VALUES ('demo-map-A-2', '用户登记', 'real-device')")
    with pytest.raises(BusinessError, match="演示专用编号"):
        repository.prepare_demo("collision", datetime.now(timezone.utc))
    assert repository.visits() == []
    assert [badge.badge_id for badge in repository.badges()] == ["demo-map-A-2"]
