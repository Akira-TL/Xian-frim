from datetime import timedelta

from fastapi.testclient import TestClient

from changan.models import MapSnapshot, SiteSelection, TerminalConfiguration, TerminalHeartbeat
from test_visits import client, operator, post_scan, register, scan, terminal, NOW


def snapshot(client: TestClient, source: str = "physical_scan_simulated_site") -> MapSnapshot:
    response = client.get("/api/v1/map?source=" + source, headers=terminal())
    assert response.status_code == 200, response.text
    return MapSnapshot.model_validate_json(response.text)


def test_five_minute_unique_badges_and_previous_window_are_reproducible(client: TestClient) -> None:
    register(client)
    register(client, "badge-002", "esp32-other")
    post_scan(client, scan("previous", -400))
    post_scan(client, scan("recent-1", -150))
    post_scan(client, scan("recent-2", -70))  # 同枚腰牌再次到访，但只算一枚。
    post_scan(client, scan("recent-other", -10).model_copy(update={"badge_id": "badge-002"}))
    result = snapshot(client)
    site = result.sites[0]
    assert (site.site_id, site.recent_unique_badges, site.previous_unique_badges, site.change) == ("A", 2, 1, 1)
    assert site.heat == "low" and site.data_status == "fresh"
    assert result.sites[1].heat == "insufficient" and result.sites[1].data_status == "missing"
    assert len(result.trend) == 36
    assert result.trend[-3].unique_badges == 2


def heartbeat(client: TestClient, seconds: int = 0) -> None:
    request = TerminalHeartbeat(terminal_id="k230-001", site_id="A", config_version=1,
                                captured_at=NOW + timedelta(seconds=seconds))
    response = client.post("/api/v1/terminal/heartbeat", content=request.model_dump_json(), headers=terminal())
    assert response.status_code == 200


def test_stale_or_untrusted_data_never_looks_like_low_heat(client: TestClient) -> None:
    register(client)
    post_scan(client, scan("stale", -120))
    site = snapshot(client).sites[0]
    assert site.recent_unique_badges == 1 and site.heat == "insufficient" and site.data_status == "stale"
    heartbeat(client)
    post_scan(client, scan("untrusted", -3600).model_copy(update={"time_quality": "untrusted"}))
    site = snapshot(client).sites[0]
    assert site.recent_unique_badges == 1 and site.excluded_untrusted_events == 1
    assert site.heat == "insufficient" and site.data_status == "untrusted"


def test_recent_feedback_distinguishes_recorded_zero_from_missing(client: TestClient) -> None:
    assert snapshot(client).sites[0].data_status == "missing"
    heartbeat(client)
    result = snapshot(client)
    assert result.sites[0].recent_unique_badges == 0 and result.sites[0].data_status == "fresh"
    assert result.sites[1].heat == "insufficient"
    heartbeat(client, -600)
    assert snapshot(client).sites[0].updated_at == NOW


def test_exact_window_boundaries_and_simulation_sources_are_separate(client: TestClient) -> None:
    register(client)
    post_scan(client, scan("boundary", -300))
    post_scan(client, scan("outside", -600))
    post_scan(client, scan("generated", -10), "/api/v1/demo/visits")
    physical = snapshot(client).sites[0]
    assert (physical.recent_unique_badges, physical.previous_unique_badges) == (0, 1)
    assert physical.heat == "insufficient"
    generated = snapshot(client, "generated_simulation")
    assert generated.sites[0].recent_unique_badges == 1
    assert generated.source == "generated_simulation"
    assert generated.sites[1].data_status == "missing"


def test_route_transitions_follow_recorded_order_not_configuration_changes(client: TestClient) -> None:
    register(client)
    post_scan(client, scan("A", -400))
    for site, version, seconds in (("B", 2, -250), ("C", 3, -10)):
        response = client.put("/api/v1/terminal/configuration",
                              content=SiteSelection(site_id=site).model_dump_json(), headers=operator())
        config = TerminalConfiguration.model_validate_json(response.text)
        assert config.config_version == version
        request = scan(site, seconds).model_copy(update={"site_id": site, "config_version": version})
        post_scan(client, request)
    result = snapshot(client)
    assert [(item.from_site, item.to_site, item.count) for item in result.transitions if item.count] == [("A", "B", 1), ("B", "C", 1)]
    assert result.sites[0].previous_unique_badges == 1 and result.sites[2].recent_unique_badges == 1


def test_map_is_readable_by_staff_but_not_anonymous_clients(client: TestClient) -> None:
    assert client.get("/api/v1/map", headers=operator()).status_code == 200
    assert client.get("/api/v1/map").status_code == 401
    assert client.get("/api/v1/map?source=other", headers=terminal()).status_code == 422
