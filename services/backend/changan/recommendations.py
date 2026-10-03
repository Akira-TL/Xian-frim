"""基于已记录到访的推荐约束；规则建议不冒充模型输出。"""

import asyncio
import re
from hashlib import sha256
from datetime import datetime, timedelta
from time import monotonic
from typing import Annotated, Callable, Literal, Protocol
from uuid import uuid4

from pydantic import Field, ValidationError, field_validator

from .catalog import SiteCatalog, SiteDefinition
from .models import Contract, CommandId, HeatThresholds, Identifier, SiteId, SiteStatistics, Source
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


class VisitorProfile(Contract):
    party: Literal["family", "friends", "older", "solo"] = "family"
    interest: Literal["history", "photography", "poetry"] = "history"
    pace: Literal["relaxed", "normal"] = "normal"


class GuideRequest(Contract):
    start_site: SiteId = "A"
    visitor_profile: VisitorProfile = Field(default_factory=VisitorProfile)
    data_source: Literal["physical_scan_simulated_site", "generated_simulation"] = "generated_simulation"
    crowd_scenario: Literal["balanced", "gate_busy", "courtyard_busy"] = "balanced"


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
    heat_thresholds: HeatThresholds = Field(default_factory=HeatThresholds)
    selected_visit_site: SiteId
    visited_sites: list[SiteId]
    completed_games: list[Literal["qin_formation"]]
    progress_verified_at: datetime | None
    candidates: list[RecommendationCandidate]
    visitor_profile: VisitorProfile | None = None


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
    reason: Literal["expired", "cancelled"]
    model_attempted: bool
    raw_output: Annotated[str, Field(max_length=4096)] | None
    raw_sha256: str | None
    raw_truncated: bool
    validation: Literal["not_requested", "accepted", "invalid_output", "timeout", "unavailable", "cancelled"]
    input: RecommendationInput


class RecommendationService:
    def __init__(self, repository: Repository, catalog: SiteCatalog,
                 model: RecommendationModel | None = None) -> None:
        self.repository = repository
        self.catalog = catalog
        self.model = model

    async def create(self, request: RecommendationRequest, clock: Callable[[], datetime]) -> RecommendationResult:
        result = self._generate(request, clock())
        return await self._finish(request, result, clock)

    async def create_guide(self, request: GuideRequest, clock: Callable[[], datetime]) -> RecommendationResult:
        now = clock()
        visits, heartbeats = self.repository.observations()
        source = Source(request.data_source)
        statistics = build_map(visits, heartbeats, now, source, self.catalog.heat_thresholds)
        if source == Source.GENERATED:
            # 明示的比赛演示输入，不写到访、不冒充实时在场人数。
            counts = {"balanced": (4, 3, 3), "gate_busy": (4, 9, 2), "courtyard_busy": (4, 2, 9)}[request.crowd_scenario]
            statistics.sites = [SiteStatistics(site_id=site.site_id, recent_unique_badges=count,
                previous_unique_badges=count, change=0, excluded_untrusted_events=0,
                updated_at=now, data_status="fresh", heat="low" if count < self.catalog.heat_thresholds.medium_min
                else "medium" if count < self.catalog.heat_thresholds.high_min else "high")
                for site in self.catalog.sites
                for count in [counts[0 if site.site_id == "A" else 1 if site.site_id == "B" else 2]]]
        start = next(site for site in self.catalog.sites if site.site_id == request.start_site)
        candidates = [RecommendationCandidate(site=site, statistics=observed, visited=False)
            for site in self.catalog.sites for observed in statistics.sites
            if observed.site_id == site.site_id and site.site_id in start.reachable_sites
            and site.is_open and observed.data_status == "fresh" and observed.updated_at is not None]
        snapshot = RecommendationInput(snapshot_id=uuid4().hex, data_source=source, generated_at=now,
            expires_at=min([now + timedelta(seconds=30)] + [item.statistics.updated_at + timedelta(seconds=90)
                for item in candidates if item.statistics.updated_at is not None]),
            catalog_version=self.catalog.version, heat_thresholds=self.catalog.heat_thresholds,
            selected_visit_site=request.start_site, visited_sites=[], completed_games=[], progress_verified_at=None,
            candidates=candidates, visitor_profile=request.visitor_profile)
        # 指引请求只留推荐审计记录，不构造扫码或把自选起点当作到访。
        context = RecommendationRequest(badge_id="visitor-demo", event_id="guide-" + snapshot.snapshot_id)
        return await self._finish(context, self._rule(snapshot, "not_configured"), clock, guide=True)

    async def _finish(self, request: RecommendationRequest, result: RecommendationResult,
                      clock: Callable[[], datetime], *, guide: bool = False) -> RecommendationResult:
        attempted = self.model is not None and bool(result.input.candidates)
        raw: str | None = None
        if attempted:
            snapshot = RecommendationInput.model_validate_json(result.input.model_dump_json())
            try:
                raw = await self._model_output(snapshot)
            except asyncio.CancelledError:
                # 只记录服务端已观察到的取消，不等待或采纳模型晚到返回。
                rejection = RecommendationRejection(
                    recorded_at=clock(), badge_id=request.badge_id, event_id=request.event_id,
                    reason="cancelled", model_attempted=True, raw_output=None,
                    raw_sha256=None, raw_truncated=False, validation="cancelled", input=result.input)
                self.repository.save_recommendation_rejection(result.snapshot_id, rejection.model_dump_json())
                raise
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
        if guide:
            self.repository.save_guide_recommendation(result.snapshot_id, result.model_dump_json(), audit.model_dump_json())
        else:
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
        if any(re.search(r"当前(?:所在)?位置(?:的|是|为|在)\s*[ABC]", text)
               for text in (output.child_text, output.operator_reason)):
            raise ValueError("到访记录不证明当前位置，不能声明实时定位")
        if any(re.search(r"不会(?:太)?拥挤|无需排队|不用排队", text)
               for text in (output.child_text, output.operator_reason)):
            raise ValueError("节点热度不证明现场拥挤程度或排队时间")
        negative_prefixes = ("不声称", "未声称", "不会声称", "不表示", "未表示", "没有", "暂无", "无", "不能说",
                             "不声称可玩或", "未声称可玩或", "不会声称可玩或")
        if not result.input.completed_games and any(
                not text[:match.start()].endswith(negative_prefixes)
                for text in (output.child_text, output.operator_reason)
                for match in re.finditer(r"已完成|已通关|已收藏|已解锁|已获得奖励", text)):
            raise ValueError("没有认证完成记录，不能声明已完成或已取得奖励状态")
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
        statistics = build_map(visits, heartbeats, now, event.source, self.catalog.heat_thresholds)
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
            expires_at=expires_at, catalog_version=self.catalog.version, heat_thresholds=self.catalog.heat_thresholds,
            selected_visit_site=event.site_id, visited_sites=visited,
            completed_games=completed, progress_verified_at=verified_at, candidates=candidates,
        )
        return self._rule(snapshot, "not_configured")

    @staticmethod
    def _rule(snapshot: RecommendationInput, reason: RuleFailure) -> RecommendationResult:
        if snapshot.candidates:
            def rank(candidate: RecommendationCandidate) -> tuple[int, bool, str]:
                preference = 0
                profile = snapshot.visitor_profile
                if profile is not None:
                    preferred = {"history": "A", "photography": "B", "poetry": "C"}[profile.interest]
                    preference += 3 if candidate.site.site_id == preferred else 0
                    preference += 1 if profile.party == "family" and candidate.site.site_id == "A" else 0
                    preference += 1 if (profile.pace == "relaxed" or profile.party == "older") and candidate.site.site_id == "C" else 0
                return (candidate.statistics.recent_unique_badges - preference, candidate.visited, candidate.site.site_id)
            selected = min(snapshot.candidates, key=rank) if snapshot.visitor_profile is not None else min(
                snapshot.candidates, key=lambda candidate: (candidate.visited,
                    candidate.statistics.recent_unique_badges, candidate.site.site_id))
            prefix = RULE_PREFIXES[reason]
            explanation = (f"{prefix}；这是演示规则建议，优先尚未到访、近期打卡较少的有效候选。"
                           f"{selected.site.name} 最近五分钟 {selected.statistics.recent_unique_badges} 枚腰牌。")
            if snapshot.visitor_profile is not None:
                explanation = f"{prefix}；结合你填写的同行情况、兴趣、游览节奏和节点热度提供规则建议。"
                heat_name = {"low": "低", "medium": "中", "high": "高", "insufficient": "数据不足"}[selected.statistics.heat]
                explanation += f"{selected.site.name}的输入热度为{heat_name}。"
            if not selected.site.game_available:
                explanation += "该点小游戏尚未接入，只有地图与内容示意。"
            return RecommendationResult(snapshot_id=snapshot.snapshot_id, source="rule_fallback",
                                        fallback_reason=reason, selected_site=selected.site.site_id,
                                        child_text=f"下一站去{selected.site.name}看看吧。", operator_reason=explanation, input=snapshot)
        return RecommendationResult(snapshot_id=snapshot.snapshot_id, source="none", fallback_reason="no_candidates",
                                    selected_site=None, child_text="", operator_reason="暂无开放、可达且数据新鲜的下一站",
                                    input=snapshot)
