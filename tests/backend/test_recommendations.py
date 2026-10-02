from datetime import timedelta
from pathlib import Path

from fastapi.testclient import TestClient
import pytest

from changan.api import create_app
from changan.catalog import default_catalog
from test_devices import authorize, device_client, report, submit
from changan.models import SiteId, TerminalConfiguration, TerminalHeartbeat
from test_visits import NOW, client, operator, post_scan, register, scan, terminal


def refresh_site(client: TestClient, site: SiteId, seconds: int = 0) -> None:
    configured = client.put("/api/v1/terminal/configuration", content=f'{{"site_id":"{site}"}}', headers=operator())
    assert configured.status_code == 200
    version = TerminalConfiguration.model_validate_json(configured.text).config_version
    heartbeat = TerminalHeartbeat(terminal_id="k230-001", site_id=site, config_version=version,
                                  captured_at=NOW + timedelta(seconds=seconds))
    assert client.post("/api/v1/terminal/heartbeat", content=heartbeat.model_dump_json(), headers=terminal()).status_code == 200


def test_missing_candidate_data_returns_no_suggestion_not_invented_heat(client: TestClient) -> None:
    register(client)
    post_scan(client, scan())
    response = client.post("/api/v1/recommendations", content='{"badge_id":"badge-001","event_id":"scan-001"}',
                           headers=operator())
    assert response.status_code == 200
    result = response.json()
    assert result["source"] == "none"
    assert result["fallback_reason"] == "no_candidates"
    assert result["selected_site"] is None
    assert result["input"]["candidates"] == []
    assert result["input"]["data_source"] == "physical_scan_simulated_site"
    assert result["child_text"] == ""


def test_unconfigured_ai_returns_labelled_rule_suggestion_from_fresh_candidates(client: TestClient) -> None:
    register(client)
    post_scan(client, scan())
    refresh_site(client, "B")
    refresh_site(client, "C")
    response = client.post("/api/v1/recommendations", content='{"badge_id":"badge-001","event_id":"scan-001"}',
                           headers=operator())
    assert response.status_code == 200
    result = response.json()
    assert result["source"] == "rule_fallback"
    assert result["fallback_reason"] == "not_configured"
    assert result["selected_site"] == "B"
    assert [candidate["site"]["site_id"] for candidate in result["input"]["candidates"]] == ["B", "C"]
    assert "长安城门" in result["child_text"]
    assert "小游戏尚未接入" in result["operator_reason"]
    assert result["input"]["completed_games"] == []


@pytest.mark.parametrize("closed", [True, False])
def test_closed_or_unreachable_nodes_never_enter_candidates(tmp_path: Path, closed: bool) -> None:
    catalog = default_catalog()
    if closed:
        catalog.sites[1].is_open = False
    else:
        catalog.sites[0].reachable_sites = ["C"]
    client = TestClient(create_app(tmp_path / "catalog.sqlite3", "operator-test", "terminal-test",
                                  lambda: NOW, site_catalog=catalog))
    register(client)
    post_scan(client, scan())
    refresh_site(client, "B")
    refresh_site(client, "C")
    result = client.post("/api/v1/recommendations", content='{"badge_id":"badge-001","event_id":"scan-001"}',
                         headers=operator()).json()
    assert [candidate["site"]["site_id"] for candidate in result["input"]["candidates"]] == ["C"]
    assert result["selected_site"] == "C"


def test_rule_changes_with_observed_counts_without_creating_visits(client: TestClient) -> None:
    register(client)
    post_scan(client, scan())
    refresh_site(client, "B")
    refresh_site(client, "C")
    first = client.post("/api/v1/recommendations", content='{"badge_id":"badge-001","event_id":"scan-001"}',
                        headers=operator()).json()
    assert first["selected_site"] == "B"
    register(client, "badge-002", "esp32-other")
    post_scan(client, scan("other-B").model_copy(update={"badge_id": "badge-002", "site_id": "B", "config_version": 2}))
    before = client.get("/api/v1/visits", headers=operator()).text
    second = client.post("/api/v1/recommendations", content='{"badge_id":"badge-001","event_id":"scan-001"}',
                         headers=operator()).json()
    assert second["selected_site"] == "C"
    assert first["snapshot_id"] != second["snapshot_id"]
    assert client.get("/api/v1/visits", headers=operator()).text == before
    assert client.get("/api/v1/unlock-commands", headers=operator()).text == "[]"


def test_stale_candidate_is_not_treated_as_low_heat(client: TestClient) -> None:
    register(client)
    post_scan(client, scan())
    refresh_site(client, "B", -91)
    refresh_site(client, "C")
    result = client.post("/api/v1/recommendations", content='{"badge_id":"badge-001","event_id":"scan-001"}',
                         headers=operator()).json()
    assert result["selected_site"] == "C"
    assert [candidate["site"]["site_id"] for candidate in result["input"]["candidates"]] == ["C"]


def test_more_recent_badge_visits_do_not_mix_sources(client: TestClient) -> None:
    register(client)
    post_scan(client, scan())
    refresh_site(client, "B")
    refresh_site(client, "C")
    post_scan(client, scan("generated-A"), "/api/v1/demo/visits")
    result = client.post("/api/v1/recommendations", content='{"badge_id":"badge-001","event_id":"generated-A"}',
                         headers=operator()).json()
    assert result["source"] == "none"
    assert result["input"]["data_source"] == "generated_simulation"
    assert result["input"]["progress_verified_at"] is None
    assert result["input"]["candidates"] == []


@pytest.mark.parametrize("seconds,quality", [(-91, "synced"), (1, "synced"), (0, "untrusted")])
def test_unusable_selected_visit_cannot_anchor_a_recommendation(client: TestClient, seconds: int, quality: str) -> None:
    register(client)
    post_scan(client, scan(seconds=seconds).model_copy(update={"time_quality": quality}))
    response = client.post("/api/v1/recommendations", content='{"badge_id":"badge-001","event_id":"scan-001"}',
                           headers=operator())
    assert response.status_code == 409


def test_an_older_visit_cannot_override_a_more_recent_site(client: TestClient) -> None:
    register(client)
    post_scan(client, scan(seconds=-30))
    refresh_site(client, "B")
    post_scan(client, scan("newer-B").model_copy(update={"site_id": "B", "config_version": 2}))
    response = client.post("/api/v1/recommendations", content='{"badge_id":"badge-001","event_id":"scan-001"}',
                           headers=operator())
    assert response.status_code == 409


def test_authenticated_completion_removes_that_task_from_candidates(device_client: TestClient) -> None:
    assert submit(device_client, report(authorize(device_client), 7)).status_code == 200
    refresh_site(device_client, "B")
    post_scan(device_client, scan("current-B").model_copy(update={"site_id": "B", "config_version": 2}))
    refresh_site(device_client, "C")
    response = device_client.post("/api/v1/recommendations", content='{"badge_id":"badge-001","event_id":"current-B"}',
                                  headers=operator())
    assert response.status_code == 200
    result = response.json()
    assert result["input"]["completed_games"] == ["qin_formation"]
    assert result["input"]["progress_verified_at"] == "2026-10-02T14:00:00Z"
    assert [candidate["site"]["site_id"] for candidate in result["input"]["candidates"]] == ["C"]
    assert result["selected_site"] == "C"
    # 同一枚腰牌在生成数据集中不能带入实物的认证通关。
    post_scan(device_client, scan("generated-C").model_copy(update={"site_id": "C", "config_version": 3}),
              "/api/v1/demo/visits")
    generated = device_client.post("/api/v1/recommendations", content='{"badge_id":"badge-001","event_id":"generated-C"}',
                                   headers=operator()).json()
    assert generated["input"]["completed_games"] == []
    assert generated["input"]["progress_verified_at"] is None


def test_recommendation_permissions_and_event_binding_fail_closed(client: TestClient) -> None:
    register(client)
    post_scan(client, scan())
    request = '{"badge_id":"badge-001","event_id":"scan-001"}'
    assert client.post("/api/v1/recommendations", content=request).status_code == 401
    assert client.post("/api/v1/recommendations", content=request, headers=terminal()).status_code == 401
    assert client.post("/api/v1/recommendations", content=request.replace("badge-001", "badge-other"), headers=operator()).status_code == 409
    assert client.post("/api/v1/recommendations", content=request.replace("scan-001", "unknown"), headers=operator()).status_code == 404
    assert client.post("/api/v1/recommendations", content=request[:-1] + ',"completed":true}', headers=operator()).status_code == 422
