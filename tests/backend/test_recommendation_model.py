import asyncio
from dataclasses import dataclass
from datetime import datetime, timedelta
from pathlib import Path
from time import monotonic

from fastapi.testclient import TestClient
import pytest

from changan.api import create_app
from changan.recommendations import ModelUnavailable, RecommendationInput, RecommendationResult
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


class SlowModel:
    def __init__(self, late: bool = False) -> None:
        self.late = late

    async def recommend(self, snapshot: RecommendationInput) -> str:
        try:
            await asyncio.sleep(20)
        except asyncio.CancelledError:
            if not self.late:
                raise
            await asyncio.sleep(0.2)
        return await ValidModel().recommend(snapshot)


@pytest.mark.parametrize("late", [False, True])
def test_model_has_eight_second_deadline_and_cannot_confirm_late_result(tmp_path: Path, late: bool) -> None:
    with TestClient(create_app(tmp_path / "timeout.sqlite3", "operator-test", "terminal-test",
                              lambda: NOW, recommendation_model=SlowModel(late))) as client:
        register(client)
        post_scan(client, scan())
        refresh_site(client, "B")
        refresh_site(client, "C")
        started = monotonic()
        response = client.post("/api/v1/recommendations",
                               content='{"badge_id":"badge-001","event_id":"scan-001"}', headers=operator())
        elapsed = monotonic() - started
        assert response.status_code == 200
        result = RecommendationResult.model_validate_json(response.text)
        assert result.source == "rule_fallback"
        assert result.fallback_reason == "timeout"
        assert result.selected_site == "B"
        assert 7.5 <= elapsed < 10
        assert "八秒" in result.operator_reason
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


@dataclass
class TestClock:
    __test__ = False
    now: datetime = NOW

    def __call__(self) -> datetime:
        return self.now


class ExpiredModel:
    def __init__(self, clock: TestClock) -> None:
        self.clock = clock

    async def recommend(self, snapshot: RecommendationInput) -> str:
        self.clock.now += timedelta(seconds=31)
        return await ValidModel().recommend(snapshot)


def test_model_output_after_snapshot_expiry_is_not_a_current_suggestion(tmp_path: Path) -> None:
    clock = TestClock()
    with TestClient(create_app(tmp_path / "expired.sqlite3", "operator-test", "terminal-test",
                              clock, recommendation_model=ExpiredModel(clock))) as client:
        register(client)
        post_scan(client, scan())
        refresh_site(client, "B")
        refresh_site(client, "C")
        response = client.post("/api/v1/recommendations",
                               content='{"badge_id":"badge-001","event_id":"scan-001"}', headers=operator())
        assert response.status_code == 409
        assert "快照已过期" in response.text


class UnreachableModel:
    def __init__(self, service: bool = False) -> None:
        self.service = service

    async def recommend(self, snapshot: RecommendationInput) -> str:
        if self.service:
            raise ModelUnavailable("TEST_PRIVATE_MARKER: 服务错误的内部详情")
        raise ConnectionError("TEST_PRIVATE_MARKER: 网络失败的内部详情")


@pytest.mark.parametrize("service", [False, True])
def test_unreachable_model_returns_explicit_rule_without_exception_detail(tmp_path: Path,
                                                                         caplog: pytest.LogCaptureFixture,
                                                                         service: bool) -> None:
    with TestClient(create_app(tmp_path / "unreachable.sqlite3", "operator-test", "terminal-test",
                              lambda: NOW, recommendation_model=UnreachableModel(service))) as client:
        register(client)
        post_scan(client, scan())
        refresh_site(client, "B")
        refresh_site(client, "C")
        response = client.post("/api/v1/recommendations",
                               content='{"badge_id":"badge-001","event_id":"scan-001"}', headers=operator())
        assert response.status_code == 200
        result = RecommendationResult.model_validate_json(response.text)
        assert result.source == "rule_fallback"
        assert result.fallback_reason == "unavailable"
        assert result.selected_site == "B"
        assert "服务不可用" in result.operator_reason
        assert "TEST_PRIVATE_MARKER" not in response.text
        history = client.get("/api/v1/recommendations/" + result.snapshot_id, headers=operator())
        assert '"fallback_reason":"unavailable"' in history.text
        assert "TEST_PRIVATE_MARKER" not in history.text
        assert "TEST_PRIVATE_MARKER" not in caplog.text
        assert client.get("/api/v1/unlock-commands", headers=operator()).text == "[]"
