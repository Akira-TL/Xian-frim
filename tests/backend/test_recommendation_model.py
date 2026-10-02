from pathlib import Path

from fastapi.testclient import TestClient
import pytest

from changan.api import create_app
from changan.recommendations import RecommendationInput, RecommendationResult
from test_recommendations import refresh_site
from test_visits import NOW, operator, post_scan, register, scan


class ValidModel:
    async def recommend(self, snapshot: RecommendationInput) -> str:
        return ('{"snapshot_id":"' + snapshot.snapshot_id
                + '","selected_site":"C","child_text":"下一站去诗意庭院看看吧。",'
                '"operator_reason":"诗意庭院在本次候选中，可查看庭院文字内容。"}')


def test_valid_model_output_uses_its_candidate_not_rule_choice(tmp_path: Path) -> None:
    with TestClient(create_app(tmp_path / "model.sqlite3", "operator-test", "terminal-test",
                              lambda: NOW, recommendation_model=ValidModel())) as client:
        register(client)
        post_scan(client, scan())
        refresh_site(client, "B")
        refresh_site(client, "C")
        response = client.post("/api/v1/recommendations",
                               content='{"badge_id":"badge-001","event_id":"scan-001"}', headers=operator())
        assert response.status_code == 200
        result = RecommendationResult.model_validate_json(response.text)
        assert result.source == "model"
        assert result.fallback_reason is None
        assert result.selected_site == "C"
        assert result.child_text == "下一站去诗意庭院看看吧。"
        assert client.get("/api/v1/unlock-commands", headers=operator()).text == "[]"
        history = client.get("/api/v1/recommendations/" + result.snapshot_id, headers=operator())
        assert history.status_code == 200
        assert '"delivery":"historical"' in history.text


class InvalidModel:
    def __init__(self, fault: str) -> None:
        self.fault = fault

    async def recommend(self, snapshot: RecommendationInput) -> str:
        if self.fault == "non_json":
            return "请去候选之外的其他景区"
        snapshot_id = "another-snapshot" if self.fault == "snapshot" else snapshot.snapshot_id
        site = "A" if self.fault == "candidate" else "C"
        text = "   " if self.fault == "blank" else "x" * 201 if self.fault == "long" else "去庭院看看。"
        extra = ',"unlocked":true' if self.fault == "extra" else ""
        return ('{"snapshot_id":"' + snapshot_id + '","selected_site":"' + site
                + '","child_text":"' + text + '","operator_reason":"测试外部错误输出"' + extra + '}')


@pytest.mark.parametrize("fault", ["non_json", "snapshot", "candidate", "blank", "long", "extra"])
def test_invalid_model_output_cannot_replace_valid_rule_or_unlock(tmp_path: Path, fault: str) -> None:
    with TestClient(create_app(tmp_path / "invalid.sqlite3", "operator-test", "terminal-test",
                              lambda: NOW, recommendation_model=InvalidModel(fault))) as client:
        register(client)
        post_scan(client, scan())
        refresh_site(client, "B")
        refresh_site(client, "C")
        response = client.post("/api/v1/recommendations",
                               content='{"badge_id":"badge-001","event_id":"scan-001"}', headers=operator())
        assert response.status_code == 200
        result = RecommendationResult.model_validate_json(response.text)
        assert result.source == "rule_fallback"
        assert result.fallback_reason == "invalid_output"
        assert result.selected_site == "B"
        assert "校验失败" in result.operator_reason
        assert client.get("/api/v1/unlock-commands", headers=operator()).text == "[]"
