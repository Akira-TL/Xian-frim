from datetime import timedelta
from pathlib import Path

from fastapi.testclient import TestClient

from changan.models import ActivitySnapshot, MapSnapshot, SiteSelection, TerminalConfiguration, TerminalHeartbeat
from changan.api import create_app
from changan.catalog import SiteCatalog, default_catalog
from changan.recommendations import RecommendationRecord, RecommendationResult
from changan.statistics import summarize_visits, build_map, estimate_trend
from changan.models import Source, Visit
from test_recommendations import refresh_site
from test_visits import client, operator, post_scan, register, scan, terminal, NOW


def snapshot(client: TestClient, source: str = "physical_scan_simulated_site") -> MapSnapshot:
    response = client.get("/api/v1/map?source=" + source, headers=terminal())
    assert response.status_code == 200, response.text
    return MapSnapshot.model_validate_json(response.text)


def test_activity_totals_use_deduplicated_visits_and_same_badge_intervals(client: TestClient) -> None:
    register(client)
    register(client, "badge-002", "esp32-other")
    post_scan(client, scan("first", -500))
    post_scan(client, scan("retry", -480))  # 同一地点短时重扫不会新增有效到访。
    post_scan(client, scan("second", -300))
    post_scan(client, scan("third", -100))
    post_scan(client, scan("other", -20).model_copy(update={"badge_id": "badge-002"}))
    post_scan(client, scan("simulated", -10), "/api/v1/demo/visits")
    response = client.get("/api/v1/activity", headers=operator())
    assert response.status_code == 200
    summary = ActivitySnapshot.model_validate_json(response.text).visits
    assert summary.total_visits == 4 and summary.participating_badges == 2
    assert [site.visits for site in summary.sites] == [4, 0, 0]
    assert summary.interval_samples == 2 and summary.average_scan_interval_seconds == 200
    generated = client.get("/api/v1/activity?source=generated_simulation", headers=operator())
    simulated = ActivitySnapshot.model_validate_json(generated.text)
    assert simulated.visits.total_visits == 1 and simulated.visits.participating_badges == 1
    assert simulated.visits.interval_samples == 0 and simulated.visits.average_scan_interval_seconds is None
    assert simulated.progress is None


def test_activity_summary_excludes_other_sessions_future_and_untrusted_times() -> None:
    def visit(event: str, seconds: int, site: str = "A", badge: str = "one", **changes: str) -> Visit:
        return Visit.model_validate({"event_id": event, "session_id": "demo-001", "badge_id": badge,
            "terminal_id": "k230-001", "site_id": site, "config_version": 1,
            "captured_at": NOW + timedelta(seconds=seconds), "received_at": NOW,
            "source": Source.PHYSICAL, "time_quality": "synced", **changes})
    records = [visit("last", -10, "C"), visit("first", -310), visit("other", -20, "B", "two"),
               visit("future", 10), visit("uncertain", -60, time_quality="untrusted"),
               visit("old-session", -200, session_id="other"),
               visit("generated", -100, source="generated_simulation")]
    summary = summarize_visits(records, NOW, Source.PHYSICAL)
    assert summary.total_visits == 3 and summary.participating_badges == 2
    assert [site.visits for site in summary.sites] == [1, 1, 1]
    assert summary.interval_samples == 1 and summary.average_scan_interval_seconds == 300
    assert summary.excluded_untrusted_events == 1 and summary.excluded_future_events == 1
    empty = summarize_visits([], NOW, Source.INTERFACE_TEST)
    assert empty.total_visits == empty.participating_badges == empty.interval_samples == 0
    assert empty.average_scan_interval_seconds is None


def test_activity_intervals_keep_same_timestamp_as_zero_not_missing() -> None:
    record = Visit(event_id="a", session_id="demo-001", badge_id="one", terminal_id="k230-001",
                   site_id="A", config_version=1, captured_at=NOW, received_at=NOW,
                   source=Source.PHYSICAL, time_quality="synced")
    summary = summarize_visits([record, record.model_copy(update={"event_id": "b", "site_id": "B"})], NOW, Source.PHYSICAL)
    assert summary.interval_samples == 1 and summary.average_scan_interval_seconds == 0


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


def test_trend_estimate_uses_valid_visit_counts_not_unique_badges(client: TestClient) -> None:
    register(client)
    for event, seconds in (("prev-one", -500), ("prev-two", -400), ("boundary", -300),
                           ("now-one", -150), ("now-two", -10)):
        post_scan(client, scan(event, seconds))
    response = client.get("/api/v1/activity", headers=operator())
    assert response.status_code == 200
    activity = ActivitySnapshot.model_validate_json(response.text)
    estimate = activity.trend_estimates[0]
    assert estimate.status == "ready"
    assert (estimate.current_window_visits, estimate.previous_window_visits) == (2, 3)
    assert estimate.estimated_next_visits == 2.3
    assert activity.map.sites[0].recent_unique_badges == 1  # 次数与去重腰牌数明确分开。
    assert activity.trend_estimates[1].status == "missing"
    assert activity.trend_estimates[1].estimated_next_visits is None


def test_trend_estimate_rejects_missing_stale_uncertain_and_one_window_samples() -> None:
    def record(event: str, seconds: int, **changes: str) -> Visit:
        return Visit.model_validate({"event_id": event, "session_id": "demo-001", "badge_id": "one",
            "terminal_id": "k230-001", "site_id": "A", "config_version": 1,
            "captured_at": NOW + timedelta(seconds=seconds), "received_at": NOW,
            "source": Source.PHYSICAL, "time_quality": "synced", **changes})
    cases = [([], "missing"), ([record("one", -10)], "insufficient_samples"),
             ([record("old", -400), record("stale", -120)], "stale"),
             ([record("old", -400), record("fresh", -10), record("bad", -30, time_quality="untrusted")], "untrusted")]
    for records, status in cases:
        estimate = estimate_trend(records, build_map(records, [], NOW, Source.PHYSICAL))[0]
        assert estimate.status == status and estimate.estimated_next_visits is None
    records = [record("old", -400), record("fresh", -10), record("future", 10),
               record("wrong-source", -100, source="generated_simulation"),
               record("wrong-session", -100, session_id="other"), record("outside", -600)]
    estimate = estimate_trend(records, build_map(records, [], NOW, Source.PHYSICAL))[0]
    assert estimate.current_window_visits == estimate.previous_window_visits == 1
    assert estimate.estimated_next_visits == 1.0


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


def test_configured_thresholds_change_heat_without_changing_facts(tmp_path: Path) -> None:
    configuration = default_catalog().model_dump_json().replace('"version":1', '"version":2')
    configuration = configuration.replace('"heat_thresholds":{"medium_min":3,"high_min":6}',
                                          '"heat_thresholds":{"medium_min":1,"high_min":2}')
    catalog = SiteCatalog.model_validate_json(configuration)
    with TestClient(create_app(tmp_path / "thresholds.sqlite3", "operator-test", "terminal-test",
                              lambda: NOW, site_catalog=catalog)) as client:
        register(client)
        register(client, "badge-002", "esp32-other")
        post_scan(client, scan("recent-one", -10))
        assert snapshot(client).sites[0].heat == "medium"
        post_scan(client, scan("recent-two", -5).model_copy(update={"badge_id": "badge-002"}))
        result = snapshot(client)
        assert result.sites[0].recent_unique_badges == 2
        assert result.sites[0].heat == "high"
        assert result.sites[1].heat == "insufficient"
        assert result.heat_thresholds.medium_min == 1
        assert result.heat_thresholds.high_min == 2
        assert result.demo_thresholds is True
        activity = client.get("/api/v1/activity", headers=operator())
        assert activity.status_code == 200
        assert ActivitySnapshot.model_validate_json(activity.text).map == result
        refresh_site(client, "B")
        recommended = client.post("/api/v1/recommendations",
                                 content='{"badge_id":"badge-001","event_id":"recent-one"}', headers=operator())
        assert recommended.status_code == 200
        recommendation = RecommendationResult.model_validate_json(recommended.text)
        assert recommendation.input.catalog_version == 2
        assert recommendation.input.heat_thresholds.medium_min == 1
        assert recommendation.input.heat_thresholds.high_min == 2
    with TestClient(create_app(tmp_path / "thresholds.sqlite3", "operator-test", "terminal-test",
                              lambda: NOW)) as reconfigured:
        current = snapshot(reconfigured)
        assert current.sites[0].recent_unique_badges == 2 and current.sites[0].heat == "low"
        history = reconfigured.get("/api/v1/recommendations/" + recommendation.snapshot_id, headers=operator())
        assert history.status_code == 200
        assert RecommendationRecord.model_validate_json(history.text).result == recommendation
