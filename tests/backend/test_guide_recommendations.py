from pathlib import Path
from fastapi.testclient import TestClient
from changan.api import create_app
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
