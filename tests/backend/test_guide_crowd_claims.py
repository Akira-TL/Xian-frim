from pathlib import Path
from fastapi.testclient import TestClient
from changan.api import create_app
from changan.recommendations import GuideRequest, RecommendationInput, RecommendationResult
from test_visits import NOW, operator


class UnsafeCrowdModel:
    async def recommend(self, snapshot: RecommendationInput) -> str:
        return '{"snapshot_id":"' + snapshot.snapshot_id + '","selected_site":"C",' \
            '"child_text":"这里不会太拥挤，不用排队。","operator_reason":"演示热度较低。"}'


def test_demo_heat_cannot_become_promise_about_real_crowds(tmp_path: Path) -> None:
    with TestClient(create_app(tmp_path / "crowd.sqlite3", "operator-test", "terminal-test", lambda: NOW,
                              recommendation_model=UnsafeCrowdModel())) as client:
        response = client.post("/api/v1/guide-recommendations", content=GuideRequest().model_dump_json(), headers=operator())
        assert response.status_code == 200
        result = RecommendationResult.model_validate_json(response.text)
        assert result.source == "rule_fallback" and result.fallback_reason == "invalid_output"
        assert "不用排队" not in result.child_text
