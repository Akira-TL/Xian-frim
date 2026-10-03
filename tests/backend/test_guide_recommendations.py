from pathlib import Path
from fastapi.testclient import TestClient
from changan.api import create_app
from changan.catalog import default_catalog
from changan.recommendations import GuideRequest, RecommendationInput, RecommendationResult
from test_visits import NOW, operator


def test_preferences_and_crowd_both_change_demo_recommendation_without_visits(tmp_path: Path) -> None:
    with TestClient(create_app(tmp_path / "guide.sqlite3", "operator-test", "terminal-test", lambda: NOW)) as client:
        request = GuideRequest()
        def recommend() -> RecommendationResult:
            response = client.post("/api/v1/guide-recommendations", content=request.model_dump_json(), headers=operator())
            assert response.status_code == 200, response.text
            return RecommendationResult.model_validate_json(response.text)
        request.visitor_profile.interest = "photography"
        assert recommend().selected_site == "B"
        request.visitor_profile.interest = "poetry"
        assert recommend().selected_site == "C"
        request.visitor_profile.interest = "photography"
        request.crowd_scenario = "gate_busy"
        result = recommend()
        assert result.selected_site == "C"
        assert result.source == "rule_fallback"
        assert result.input.data_source == "generated_simulation"
        assert result.input.visited_sites == [] and result.input.completed_games == []
        assert client.get("/api/v1/visits", headers=operator()).json() == []
        request.data_source = "physical_scan_simulated_site"
        assert recommend().source == "none"  # 无现场观测不能复用演示热度。


def test_change_recommendation_avoids_previous_without_inventing_visit(tmp_path: Path) -> None:
    with TestClient(create_app(tmp_path / "change.sqlite3", "operator-test", "terminal-test", lambda: NOW)) as client:
        request = GuideRequest()
        selected: list[str | None] = []
        for _ in range(4):
            response = client.post("/api/v1/guide-recommendations", content=request.model_dump_json(), headers=operator())
            assert response.status_code == 200
            result = RecommendationResult.model_validate_json(response.text)
            selected.append(result.selected_site)
            assert result.input.visited_sites == []
            assert result.input.previous_recommended_site == request.avoid_site
            request.avoid_site = result.selected_site
        assert selected == ["B", "C", "B", "C"]
        assert client.get("/api/v1/visits", headers=operator()).json() == []


def test_only_viable_candidate_may_repeat_with_explicit_reason(tmp_path: Path) -> None:
    catalog = default_catalog()
    next(site for site in catalog.sites if site.site_id == "C").is_open = False
    with TestClient(create_app(tmp_path / "single.sqlite3", "operator-test", "terminal-test", lambda: NOW,
                              site_catalog=catalog)) as client:
        request = GuideRequest(avoid_site="B")
        response = client.post("/api/v1/guide-recommendations", content=request.model_dump_json(), headers=operator())
        assert response.status_code == 200
        result = RecommendationResult.model_validate_json(response.text)
        assert result.selected_site == "B"
        assert "只有这个有效候选" in result.operator_reason


class ProfileModel:
    snapshot: RecommendationInput | None = None
    async def recommend(self, snapshot: RecommendationInput) -> str:
        self.snapshot = snapshot
        assert snapshot.visitor_profile is not None
        assert snapshot.visitor_profile.party == "older"
        assert snapshot.visitor_profile.pace == "relaxed"
        assert snapshot.candidates[0].statistics.recent_unique_badges == 9
        return '{"snapshot_id":"' + snapshot.snapshot_id + '","selected_site":"C",' \
            '"child_text":"下一站去诗意庭院赏诗，按你的节奏慢慢欣赏。",' \
            '"operator_reason":"游客自选慢节奏，演示输入中庭院热度较低。"}'


class RepeatingModel:
    async def recommend(self, snapshot: RecommendationInput) -> str:
        assert snapshot.previous_recommended_site == "B"
        assert [item.site.site_id for item in snapshot.candidates] == ["C"]
        return '{"snapshot_id":"' + snapshot.snapshot_id + '","selected_site":"B",' \
            '"child_text":"下一站去城门。","operator_reason":"重复上一条建议。"}'


def test_model_cannot_restore_excluded_previous_recommendation(tmp_path: Path) -> None:
    with TestClient(create_app(tmp_path / "repeat-model.sqlite3", "operator-test", "terminal-test", lambda: NOW,
                              recommendation_model=RepeatingModel())) as client:
        response = client.post("/api/v1/guide-recommendations", content=GuideRequest(avoid_site="B").model_dump_json(),
                               headers=operator())
        assert response.status_code == 200
        result = RecommendationResult.model_validate_json(response.text)
        assert result.selected_site == "C" and result.fallback_reason == "invalid_output"


def test_model_receives_self_reported_preferences_and_crowd_not_inferred_identity(tmp_path: Path) -> None:
    model = ProfileModel()
    with TestClient(create_app(tmp_path / "model.sqlite3", "operator-test", "terminal-test", lambda: NOW,
                              recommendation_model=model)) as client:
        request = GuideRequest(crowd_scenario="gate_busy")
        request.visitor_profile.party = "older"
        request.visitor_profile.pace = "relaxed"
        result = client.post("/api/v1/guide-recommendations", content=request.model_dump_json(), headers=operator())
        assert result.status_code == 200
        parsed = RecommendationResult.model_validate_json(result.text)
        assert parsed.source == "model" and parsed.selected_site == "C"
        assert model.snapshot is not None
        audit = client.get(f"/api/v1/recommendations/{parsed.snapshot_id}/audit", headers=operator())
        assert audit.status_code == 200 and audit.json()["validation"] == "accepted"
        assert client.get("/api/v1/visits", headers=operator()).json() == []
