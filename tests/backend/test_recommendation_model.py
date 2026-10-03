import asyncio
import json
from dataclasses import dataclass
from datetime import datetime, timedelta
from pathlib import Path
from time import monotonic

from fastapi.testclient import TestClient
from pydantic import BaseModel, SecretStr, TypeAdapter
import httpx
import pytest

from changan.api import create_app
from changan.recommendations import ModelUnavailable, RecommendationAudit, RecommendationInput, RecommendationRejection, RecommendationResult
from test_recommendations import refresh_site
from test_visits import NOW, operator, post_scan, register, scan


class ValidModel:
    async def recommend(self, snapshot: RecommendationInput) -> str:
        return ('{"snapshot_id":"' + snapshot.snapshot_id
                + '","selected_site":"C","child_text":"下一站去诗意庭院看看吧。",'
                '"operator_reason":"诗意庭院在本次候选中，可查看庭院文字内容。"}')


class ExternalMessage(BaseModel):
    role: str
    content: str


class ExternalRequest(BaseModel):
    model: str
    messages: list[ExternalMessage]


def test_deepseek_http_response_passes_through_real_recommendation_validation(tmp_path: Path) -> None:
    from changan.deepseek import DeepSeekModel

    async def provider(request: httpx.Request) -> httpx.Response:
        assert str(request.url) == "https://api.deepseek.com/chat/completions"
        assert request.headers["authorization"] == "Bearer test-only-key"
        sent = ExternalRequest.model_validate_json(request.content)
        assert sent.model == "deepseek-flash"
        assert sent.messages[-1].role == "user"
        snapshot = RecommendationInput.model_validate_json(sent.messages[-1].content)
        assert snapshot.selected_visit_site == "A"
        assert "test-only-key" not in sent.messages[-1].content
        raw = await ValidModel().recommend(snapshot)
        return httpx.Response(200, content='{"choices":[{"finish_reason":"stop","message":{"content":'
                              + json.dumps(raw) + '}}]}')

    model = DeepSeekModel(SecretStr("test-only-key"), transport=httpx.MockTransport(provider))
    with TestClient(create_app(tmp_path / "deepseek.sqlite3", "operator-test", "terminal-test", lambda: NOW,
                              recommendation_model=model)) as client:
        register(client)
        post_scan(client, scan())
        refresh_site(client, "B")
        refresh_site(client, "C")
        response = client.post("/api/v1/recommendations",
                               content='{"badge_id":"badge-001","event_id":"scan-001"}', headers=operator())
        assert response.status_code == 200
        result = RecommendationResult.model_validate_json(response.text)
        assert result.source == "model" and result.selected_site == "C"
        assert result.child_text == "下一站去诗意庭院看看吧。"
        audit = client.get("/api/v1/recommendations/" + result.snapshot_id + "/audit", headers=operator())
        assert RecommendationAudit.model_validate_json(audit.text).validation == "accepted"
        assert "test-only-key" not in response.text + audit.text


@pytest.mark.parametrize("fault", ["http", "redirect", "malformed", "oversize"])
def test_deepseek_service_failures_do_not_leak_response_or_turn_into_success(tmp_path: Path, fault: str) -> None:
    from changan.deepseek import DeepSeekModel

    def provider(request: httpx.Request) -> httpx.Response:
        if fault == "http":
            return httpx.Response(401, content="PRIVATE_PROVIDER_DETAIL")
        if fault == "redirect":
            return httpx.Response(302, headers=[("Location", "https://outside.invalid")])
        return httpx.Response(200, content="x" * 65537 if fault == "oversize" else "PRIVATE_PROVIDER_DETAIL")

    model = DeepSeekModel(SecretStr("test-only-key"), transport=httpx.MockTransport(provider))
    with TestClient(create_app(tmp_path / "deepseek-fault.sqlite3", "operator-test", "terminal-test", lambda: NOW,
                              recommendation_model=model)) as client:
        register(client)
        post_scan(client, scan())
        refresh_site(client, "B")
        response = client.post("/api/v1/recommendations",
                               content='{"badge_id":"badge-001","event_id":"scan-001"}', headers=operator())
        assert response.status_code == 200
        result = RecommendationResult.model_validate_json(response.text)
        assert result.source == "rule_fallback" and result.fallback_reason == "unavailable"
        audit = client.get("/api/v1/recommendations/" + result.snapshot_id + "/audit", headers=operator())
        assert "PRIVATE_PROVIDER_DETAIL" not in response.text + audit.text
        assert "test-only-key" not in response.text + audit.text
        assert client.get("/api/v1/unlock-commands", headers=operator()).text == "[]"


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
        if self.fault == "oversize":
            return "x" * 4097
        if self.fault == "non_json":
            return "请去候选之外的其他景区"
        snapshot_id = "another-snapshot" if self.fault == "snapshot" else snapshot.snapshot_id
        site = "A" if self.fault == "candidate" else "C"
        text = "   " if self.fault == "blank" else "x" * 201 if self.fault == "long" else "去庭院看看。"
        extra = ',"unlocked":true' if self.fault == "extra" else ""
        return ('{"snapshot_id":"' + snapshot_id + '","selected_site":"' + site
                + '","child_text":"' + text + '","operator_reason":"测试外部错误输出"' + extra + '}')


class UnverifiedCompletionModel:
    async def recommend(self, snapshot: RecommendationInput) -> str:
        return ('{"snapshot_id":"' + snapshot.snapshot_id
                + '","selected_site":"B","child_text":"下一站去城门观察图案。",'
                '"operator_reason":"快照显示已完成A站，因此建议去B站。"}')


class DeniedCompletionModel:
    async def recommend(self, snapshot: RecommendationInput) -> str:
        return ('{"snapshot_id":"' + snapshot.snapshot_id
                + '","selected_site":"B","child_text":"下一站去城门观察图案。",'
                '"operator_reason":"没有认证完成记录，不声称已完成或可玩。"}')


def test_explicit_denial_of_completion_is_not_a_false_positive(tmp_path: Path) -> None:
    with TestClient(create_app(tmp_path / "denied-completion.sqlite3", "operator-test", "terminal-test", lambda: NOW,
                              recommendation_model=DeniedCompletionModel())) as client:
        register(client)
        post_scan(client, scan())
        refresh_site(client, "B")
        response = client.post("/api/v1/recommendations",
                               content='{"badge_id":"badge-001","event_id":"scan-001"}', headers=operator())
        assert response.status_code == 200
        result = RecommendationResult.model_validate_json(response.text)
        assert result.source == "model"
        assert result.operator_reason == "没有认证完成记录，不声称已完成或可玩。"


def test_model_cannot_turn_a_visit_without_verified_progress_into_completion(tmp_path: Path) -> None:
    with TestClient(create_app(tmp_path / "false-completion.sqlite3", "operator-test", "terminal-test", lambda: NOW,
                              recommendation_model=UnverifiedCompletionModel())) as client:
        register(client)
        post_scan(client, scan())
        refresh_site(client, "B")
        response = client.post("/api/v1/recommendations",
                               content='{"badge_id":"badge-001","event_id":"scan-001"}', headers=operator())
        assert response.status_code == 200
        result = RecommendationResult.model_validate_json(response.text)
        assert result.source == "rule_fallback" and result.fallback_reason == "invalid_output"
        assert "已完成A站" not in result.operator_reason
        assert result.input.completed_games == []


@pytest.mark.parametrize("fault", ["non_json", "snapshot", "candidate", "blank", "long", "extra", "oversize"])
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
        audit_response = client.get("/api/v1/recommendations/" + result.snapshot_id + "/audit", headers=operator())
        audit = RecommendationAudit.model_validate_json(audit_response.text)
        assert audit.validation == "invalid_output"
        assert audit.result == result
        assert audit.raw_output is not None
        assert audit.raw_truncated == (fault == "oversize")
        assert len(audit.raw_output) <= 4096


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


def test_expired_output_has_private_rejection_evidence_without_a_suggestion(tmp_path: Path) -> None:
    clock = TestClock()
    database = tmp_path / "rejected.sqlite3"
    with TestClient(create_app(database, "operator-test", "terminal-test", clock,
                              recommendation_model=ExpiredModel(clock))) as client:
        register(client)
        post_scan(client, scan())
        refresh_site(client, "B")
        refresh_site(client, "C")
        response = client.post("/api/v1/recommendations",
                               content='{"badge_id":"badge-001","event_id":"scan-001"}', headers=operator())
        assert response.status_code == 409
        evidence = client.get("/api/v1/recommendation-rejections", headers=operator())
        assert evidence.status_code == 200
        records = TypeAdapter(list[RecommendationRejection]).validate_json(evidence.text)
        assert len(records) == 1
        record = records[0]
        assert record.reason == "expired"
        assert record.badge_id == "badge-001"
        assert record.event_id == "scan-001"
        assert record.model_attempted is True
        assert record.validation == "accepted"
        assert record.raw_output == ('{"snapshot_id":"' + record.input.snapshot_id
                + '","selected_site":"C","child_text":"下一站去诗意庭院看看吧。",'
                '"operator_reason":"诗意庭院在本次候选中，可查看庭院文字内容。"}')
        assert record.input.selected_visit_site == "A"
        assert record.input.data_source == "physical_scan_simulated_site"
        assert record.input.completed_games == []
        assert record.raw_truncated is False
        assert record.raw_sha256 is not None and len(record.raw_sha256) == 64
        snapshot_id = record.input.snapshot_id
        assert client.get("/api/v1/recommendations/" + snapshot_id, headers=operator()).status_code == 404
        assert client.get("/api/v1/unlock-commands", headers=operator()).text == "[]"
        assert client.get("/api/v1/recommendation-rejections").status_code == 401
        assert client.get("/api/v1/recommendation-rejections",
                          headers={"Authorization": "Bearer terminal-test"}).status_code == 401
    with TestClient(create_app(database, "operator-test", "terminal-test", clock)) as restarted:
        persisted = restarted.get("/api/v1/recommendation-rejections", headers=operator())
        assert TypeAdapter(list[RecommendationRejection]).validate_json(persisted.text) == records


class CancelledLateModel:
    def __init__(self) -> None:
        self.started = asyncio.Event()
        self.release_late = asyncio.Event()
        self.finished = asyncio.Event()

    async def recommend(self, snapshot: RecommendationInput) -> str:
        self.started.set()
        try:
            await asyncio.Event().wait()
        except asyncio.CancelledError:
            await self.release_late.wait()
        try:
            return await ValidModel().recommend(snapshot)
        finally:
            self.finished.set()


def test_cancelled_request_preserves_rejection_without_accepting_late_output(tmp_path: Path) -> None:
    database = tmp_path / "cancelled.sqlite3"
    with TestClient(create_app(database, "operator-test", "terminal-test", lambda: NOW)) as setup:
        register(setup)
        post_scan(setup, scan())
        refresh_site(setup, "B")
        refresh_site(setup, "C")

    async def exercise() -> list[RecommendationRejection]:
        model = CancelledLateModel()
        app = create_app(database, "operator-test", "terminal-test", lambda: NOW, recommendation_model=model)
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://testserver") as client:
            request = asyncio.create_task(client.post("/api/v1/recommendations",
                content='{"badge_id":"badge-001","event_id":"scan-001"}', headers=operator()))
            await asyncio.wait_for(model.started.wait(), timeout=2)
            request.cancel()
            with pytest.raises(asyncio.CancelledError):
                await request
            response = await client.get("/api/v1/recommendation-rejections", headers=operator())
            assert response.status_code == 200
            records = TypeAdapter(list[RecommendationRejection]).validate_json(response.text)
            assert len(records) == 1
            record = records[0]
            assert record.reason == "cancelled"
            assert record.validation == "cancelled"
            assert record.model_attempted is True
            assert record.raw_output is None and record.raw_sha256 is None
            assert record.raw_truncated is False
            assert record.badge_id == "badge-001" and record.event_id == "scan-001"
            assert record.input.selected_visit_site == "A"
            model.release_late.set()
            await asyncio.wait_for(model.finished.wait(), timeout=2)
            after_late = await client.get("/api/v1/recommendation-rejections", headers=operator())
            assert TypeAdapter(list[RecommendationRejection]).validate_json(after_late.text) == records
            assert (await client.get("/api/v1/recommendations/" + record.input.snapshot_id,
                                     headers=operator())).status_code == 404
            assert (await client.get("/api/v1/unlock-commands", headers=operator())).text == "[]"
            return records

    records = asyncio.run(exercise())
    with TestClient(create_app(database, "operator-test", "terminal-test", lambda: NOW)) as restarted:
        persisted = restarted.get("/api/v1/recommendation-rejections", headers=operator())
        assert TypeAdapter(list[RecommendationRejection]).validate_json(persisted.text) == records


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
        private = client.get("/api/v1/recommendations/" + result.snapshot_id + "/audit", headers=operator())
        assert private.status_code == 200
        assert "TEST_PRIVATE_MARKER" not in private.text
        assert client.get("/api/v1/unlock-commands", headers=operator()).text == "[]"


def test_original_model_output_is_private_and_persists_across_restart(tmp_path: Path) -> None:
    database = tmp_path / "audit.sqlite3"
    with TestClient(create_app(database, "operator-test", "terminal-test", lambda: NOW,
                              recommendation_model=ValidModel())) as client:
        register(client)
        post_scan(client, scan())
        refresh_site(client, "B")
        refresh_site(client, "C")
        response = client.post("/api/v1/recommendations",
                               content='{"badge_id":"badge-001","event_id":"scan-001"}', headers=operator())
        result = RecommendationResult.model_validate_json(response.text)
        path = "/api/v1/recommendations/" + result.snapshot_id + "/audit"
        audit = client.get(path, headers=operator())
        assert audit.status_code == 200
        saved = RecommendationAudit.model_validate_json(audit.text)
        assert saved.result == result
        assert saved.raw_output is not None
        assert saved.raw_sha256 is not None and len(saved.raw_sha256) == 64
        assert saved.raw_output == ('{"snapshot_id":"' + result.snapshot_id
                                    + '","selected_site":"C","child_text":"下一站去诗意庭院看看吧。",'
                                    '"operator_reason":"诗意庭院在本次候选中，可查看庭院文字内容。"}')
        assert '"model_attempted":true' in audit.text
        assert '"validation":"accepted"' in audit.text
        assert "下一站去诗意庭院看看吧。" in audit.text
        assert "raw_output" not in response.text
        assert client.get(path).status_code == 401
        assert client.get(path, headers={"Authorization": "Bearer terminal-test"}).status_code == 401
    with TestClient(create_app(database, "operator-test", "terminal-test", lambda: NOW)) as restarted:
        assert restarted.get(path, headers=operator()).text == audit.text
