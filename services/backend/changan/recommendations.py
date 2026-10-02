"""基于已记录到访的推荐约束；规则建议不冒充模型输出。"""

import asyncio
from hashlib import sha256
from datetime import datetime, timedelta
from time import monotonic
from typing import Annotated, Callable, Literal, Protocol
from uuid import uuid4

from pydantic import Field, ValidationError, field_validator

from .catalog import SiteCatalog, SiteDefinition
from .models import Contract, CommandId, Identifier, SiteId, SiteStatistics, Source
from .storage import BusinessError, Repository
from .statistics import build_map

RuleFailure = Literal["not_configured", "invalid_output", "timeout", "unavailable"]
RULE_PREFIXES: dict[RuleFailure, str] = {
    "not_configured": "AI 未配置",
    "invalid_output": "AI 输出校验失败",
    "timeout": "AI 八秒内未返回",
    "unavailable": "AI 服务不可用",
}


class RecommendationRequest(Contract):
    badge_id: Identifier
    event_id: CommandId


class RecommendationCandidate(Contract):
    site: SiteDefinition
    statistics: SiteStatistics
    visited: bool


class RecommendationInput(Contract):
    snapshot_id: Identifier
    session_id: Literal["demo-001"] = "demo-001"
    data_source: Source
    generated_at: datetime
    expires_at: datetime
    catalog_version: int
    selected_visit_site: SiteId
    visited_sites: list[SiteId]
    completed_games: list[Literal["qin_formation"]]
    progress_verified_at: datetime | None
    candidates: list[RecommendationCandidate]


class RecommendationResult(Contract):
    snapshot_id: Identifier
    source: Literal["model", "rule_fallback", "none"]
    fallback_reason: RuleFailure | Literal["no_candidates"] | None
    selected_site: SiteId | None
    child_text: Annotated[str, Field(max_length=200)]
    operator_reason: Annotated[str, Field(max_length=500)]
    input: RecommendationInput


class ModelOutput(Contract):
    snapshot_id: Identifier
    selected_site: SiteId
    child_text: Annotated[str, Field(min_length=1, max_length=200)]
    operator_reason: Annotated[str, Field(min_length=1, max_length=500)]

    @field_validator("child_text", "operator_reason")
    @classmethod
    def nonblank(cls, value: str) -> str:
        if not value.strip():
            raise ValueError("模型文案不能为空白")
        return value


class RecommendationModel(Protocol):
    async def recommend(self, snapshot: RecommendationInput) -> str: ...


class ModelUnavailable(RuntimeError):
    """由外部适配器转译的服务故障；异常详情不得回显。"""


class RecommendationRecord(Contract):
    delivery: Literal["historical"] = "historical"
    retrieved_at: datetime
    expired: bool
    result: RecommendationResult


class RecommendationAudit(Contract):
    recorded_at: datetime
    model_attempted: bool
    raw_output: Annotated[str, Field(max_length=4096)] | None
    raw_sha256: str | None
    raw_truncated: bool
    validation: Literal["not_requested", "accepted", "invalid_output", "timeout", "unavailable"]
    result: RecommendationResult


class RecommendationRejection(Contract):
    recorded_at: datetime
    badge_id: Identifier
    event_id: CommandId
    reason: Literal["expired"]
    model_attempted: bool
    raw_output: Annotated[str, Field(max_length=4096)] | None
    raw_sha256: str | None
    raw_truncated: bool
    validation: Literal["not_requested", "accepted", "invalid_output", "timeout", "unavailable"]
    input: RecommendationInput


class RecommendationService:
    def __init__(self, repository: Repository, catalog: SiteCatalog,
                 model: RecommendationModel | None = None) -> None:
        self.repository = repository
        self.catalog = catalog
        self.model = model

    async def create(self, request: RecommendationRequest, clock: Callable[[], datetime]) -> RecommendationResult:
        result = self._generate(request, clock())
        attempted = self.model is not None and bool(result.input.candidates)
        raw: str | None = None
        if attempted:
            snapshot = RecommendationInput.model_validate_json(result.input.model_dump_json())
            try:
                raw = await self._model_output(snapshot)
            except (OSError, ModelUnavailable):
                # 网络异常详情可能含服务地址或凭据，不记日志，也不对外回显。
                result = self._rule(result.input, "unavailable")
            else:
                try:
                    if raw is None:
                        result = self._rule(result.input, "timeout")
                    else:
                        result = self._validated_result(raw, result)
                except (ValidationError, ValueError):
                    result = self._rule(result.input, "invalid_output")
        validation: Literal["not_requested", "accepted", "invalid_output", "timeout", "unavailable"] = "not_requested"
        if attempted:
            if result.source == "model":
                validation = "accepted"
            elif result.fallback_reason in ("invalid_output", "timeout", "unavailable"):
                validation = result.fallback_reason
        audit = RecommendationAudit(recorded_at=clock(), model_attempted=attempted,
                                    raw_output=None if raw is None else raw[:4096],
                                    raw_sha256=None if raw is None else sha256(raw.encode("utf-8")).hexdigest(),
                                    raw_truncated=raw is not None and len(raw) > 4096,
                                    validation=validation, result=result)
        if result.input.expires_at <= audit.recorded_at:
            rejection = RecommendationRejection(
                recorded_at=audit.recorded_at, badge_id=request.badge_id, event_id=request.event_id,
                reason="expired", model_attempted=audit.model_attempted, raw_output=audit.raw_output,
                raw_sha256=audit.raw_sha256, raw_truncated=audit.raw_truncated,
                validation=audit.validation, input=result.input)
            self.repository.save_recommendation_rejection(result.snapshot_id, rejection.model_dump_json())
            raise BusinessError(409, "推荐输入快照已过期，请重新生成，不使用晚到结果")
        self.repository.save_recommendation(result.snapshot_id, request.badge_id, request.event_id,
                                             result.model_dump_json(), audit.model_dump_json())
        return result

    def audit(self, snapshot_id: str) -> RecommendationAudit:
        return RecommendationAudit.model_validate_json(self.repository.recommendation_audit_json(snapshot_id))

    def rejections(self) -> list[RecommendationRejection]:
        return [RecommendationRejection.model_validate_json(record)
                for record in self.repository.recommendation_rejections_json()]

    async def _model_output(self, snapshot: RecommendationInput) -> str | None:
        assert self.model is not None
        task = asyncio.create_task(self.model.recommend(snapshot))
        # 超时或调用方取消后，晚到异常只被消费，不记入日志或恢复成成功。
        task.add_done_callback(self._consume_model_completion)
        started = monotonic()
        try:
            done, _ = await asyncio.wait({task}, timeout=8)
        except asyncio.CancelledError:
            task.cancel()
            raise
        if not done or monotonic() - started >= 8:
            task.cancel()
            return None
        return task.result()

    @staticmethod
    def _consume_model_completion(task: asyncio.Task[str]) -> None:
        if not task.cancelled():
            task.exception()

    @staticmethod
    def _validated_result(raw: str, result: RecommendationResult) -> RecommendationResult:
        if len(raw) > 4096:
            raise ValueError("模型结果超长")
        output = ModelOutput.model_validate_json(raw)
        if (output.snapshot_id != result.snapshot_id or not any(
                candidate.site.site_id == output.selected_site for candidate in result.input.candidates)):
            raise ValueError("模型快照或候选不匹配")
        return RecommendationResult(snapshot_id=result.snapshot_id, source="model", fallback_reason=None,
                                    selected_site=output.selected_site, child_text=output.child_text,
                                    operator_reason=output.operator_reason, input=result.input)

    def read(self, snapshot_id: str, now: datetime) -> RecommendationRecord:
        result = RecommendationResult.model_validate_json(self.repository.recommendation_json(snapshot_id))
        return RecommendationRecord(retrieved_at=now, expired=result.input.expires_at <= now, result=result)

    def _generate(self, request: RecommendationRequest, now: datetime) -> RecommendationResult:
        records = self.repository.recommendation_observations(request.badge_id)
        visits, heartbeats = records.visits, records.heartbeats
        event = next((visit for visit in visits if visit.event_id == request.event_id), None)
        if event is None:
            raise BusinessError(404, "到访事件不存在")
        if event.badge_id != request.badge_id:
            raise BusinessError(409, "到访事件与腰牌不匹配")
        if (event.time_quality != "synced" or event.captured_at > now
                or event.captured_at + timedelta(seconds=90) <= now):
            raise BusinessError(409, "所选到访时间不可靠或已过时，请重新选择有效到访")
        own = [visit for visit in visits if visit.badge_id == request.badge_id and visit.source == event.source
               and visit.session_id == "demo-001" and visit.time_quality == "synced" and visit.captured_at <= now]
        if any(visit.captured_at > event.captured_at for visit in own):
            raise BusinessError(409, "已有更新的同来源到访，请选择最近到访")
        completed: list[Literal["qin_formation"]] = ["qin_formation"] if (
            event.source == Source.PHYSICAL and records.qin_completed is True) else []
        verified_at = records.verified_at if event.source == Source.PHYSICAL else None
        visited = sorted({visit.site_id for visit in own})
        current_site = next(site for site in self.catalog.sites if site.site_id == event.site_id)
        statistics = build_map(visits, heartbeats, now, event.source)
        candidates: list[RecommendationCandidate] = []
        for site in sorted(self.catalog.sites, key=lambda site: site.site_id):
            observed = next(item for item in statistics.sites if item.site_id == site.site_id)
            if (site.site_id in current_site.reachable_sites and site.is_open
                    and site.game_id not in completed
                    and observed.data_status == "fresh" and observed.updated_at is not None
                    and observed.updated_at + timedelta(seconds=90) > now):
                candidates.append(RecommendationCandidate(site=site, statistics=observed,
                                                           visited=site.site_id in visited))
        expires_at = min([now + timedelta(seconds=30), event.captured_at + timedelta(seconds=90)] + [
            candidate.statistics.updated_at + timedelta(seconds=90)
            for candidate in candidates if candidate.statistics.updated_at is not None
        ])
        snapshot = RecommendationInput(
            snapshot_id=uuid4().hex, data_source=event.source, generated_at=now,
            expires_at=expires_at, catalog_version=self.catalog.version,
            selected_visit_site=event.site_id, visited_sites=visited,
            completed_games=completed, progress_verified_at=verified_at, candidates=candidates,
        )
        return self._rule(snapshot, "not_configured")

    @staticmethod
    def _rule(snapshot: RecommendationInput, reason: RuleFailure) -> RecommendationResult:
        if snapshot.candidates:
            selected = min(snapshot.candidates, key=lambda candidate: (candidate.visited,
                            candidate.statistics.recent_unique_badges, candidate.site.site_id))
            prefix = RULE_PREFIXES[reason]
            explanation = (f"{prefix}；这是演示规则建议，优先尚未到访、近期打卡较少的有效候选。"
                           f"{selected.site.name} 最近五分钟 {selected.statistics.recent_unique_badges} 枚腰牌。")
            if not selected.site.game_available:
                explanation += "该点小游戏尚未接入，只有地图与内容示意。"
            return RecommendationResult(snapshot_id=snapshot.snapshot_id, source="rule_fallback",
                                        fallback_reason=reason, selected_site=selected.site.site_id,
                                        child_text=f"下一站去{selected.site.name}看看吧。", operator_reason=explanation, input=snapshot)
        return RecommendationResult(snapshot_id=snapshot.snapshot_id, source="none", fallback_reason="no_candidates",
                                    selected_site=None, child_text="", operator_reason="暂无开放、可达且数据新鲜的下一站",
                                    input=snapshot)
