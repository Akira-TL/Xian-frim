"""基于已记录到访的推荐约束；规则建议不冒充模型输出。"""

from datetime import datetime, timedelta
from typing import Annotated, Literal
from uuid import uuid4

from pydantic import Field

from .catalog import SiteCatalog, SiteDefinition
from .models import Contract, CommandId, Identifier, SiteId, SiteStatistics, Source
from .storage import BusinessError, Repository
from .statistics import build_map


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
    source: Literal["rule_fallback", "none"]
    fallback_reason: Literal["not_configured", "no_candidates"]
    selected_site: SiteId | None
    child_text: Annotated[str, Field(max_length=200)]
    operator_reason: Annotated[str, Field(max_length=500)]
    input: RecommendationInput


class RecommendationService:
    def __init__(self, repository: Repository, catalog: SiteCatalog) -> None:
        self.repository = repository
        self.catalog = catalog

    def create(self, request: RecommendationRequest, now: datetime) -> RecommendationResult:
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
        if candidates:
            selected = min(candidates, key=lambda candidate: (candidate.visited,
                            candidate.statistics.recent_unique_badges, candidate.site.site_id))
            reason = ("AI 未配置；这是演示规则建议，优先尚未到访、近期打卡较少的有效候选。"
                      f"{selected.site.name} 最近五分钟 {selected.statistics.recent_unique_badges} 枚腰牌。")
            if not selected.site.game_available:
                reason += "该点小游戏尚未接入，只有地图与内容示意。"
            return RecommendationResult(snapshot_id=snapshot.snapshot_id, source="rule_fallback",
                                        fallback_reason="not_configured", selected_site=selected.site.site_id,
                                        child_text=f"下一站去{selected.site.name}看看吧。", operator_reason=reason, input=snapshot)
        return RecommendationResult(snapshot_id=snapshot.snapshot_id, source="none", fallback_reason="no_candidates",
                                    selected_site=None, child_text="", operator_reason="暂无开放、可达且数据新鲜的下一站",
                                    input=snapshot)
