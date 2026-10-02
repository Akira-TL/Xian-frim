"""三节点演示园区配置；不代表真实景区或已部署的扩展小游戏。"""

from typing import Annotated, Literal, Self

from pydantic import Field, FiniteFloat, model_validator

from .models import Contract, HeatThresholds, SiteId


class SiteDefinition(Contract):
    site_id: SiteId
    name: Annotated[str, Field(min_length=1, max_length=32)]
    x: Annotated[FiniteFloat, Field(ge=0, le=1)]
    y: Annotated[FiniteFloat, Field(ge=0, le=1)]
    is_open: bool
    reachable_sites: Annotated[list[SiteId], Field(max_length=2)]
    task_name: Annotated[str, Field(min_length=1, max_length=32)]
    task_prompt: Annotated[str, Field(min_length=1, max_length=120)]
    game_id: Literal["qin_formation", "gate_search", "poem_completion"]
    game_available: bool

    @model_validator(mode="after")
    def validate_connections(self) -> Self:
        if self.site_id in self.reachable_sites or len(set(self.reachable_sites)) != len(self.reachable_sites):
            raise ValueError("可达节点不能包含自身或重复项")
        if self.game_available and self.game_id != "qin_formation":
            raise ValueError("首版只有秦俑归阵小游戏已接入")
        return self


class SiteCatalog(Contract):
    version: Annotated[int, Field(ge=1)] = 1
    source: Literal["demo_site_configuration"] = "demo_site_configuration"
    geographic_map: Literal[False] = False
    heat_thresholds: HeatThresholds = Field(default_factory=HeatThresholds)
    sites: Annotated[list[SiteDefinition], Field(min_length=3, max_length=3)]

    @model_validator(mode="after")
    def validate_sites(self) -> Self:
        if {site.site_id for site in self.sites} != {"A", "B", "C"}:
            raise ValueError("演示配置必须包含 A、B、C 各一个节点")
        return self


def default_catalog() -> SiteCatalog:
    return SiteCatalog(sites=[
        SiteDefinition(site_id="A", name="秦俑工坊", x=0.15, y=0.65, is_open=True,
                       reachable_sites=["B", "C"], task_name="秦俑归阵",
                       task_prompt="在圆屏腰牌上完成三片拼接，收藏秦俑奖励", game_id="qin_formation", game_available=True),
        SiteDefinition(site_id="B", name="长安城门", x=0.5, y=0.2, is_open=True,
                       reachable_sites=["A", "C"], task_name="城门寻宝",
                       task_prompt="观察城门图案；内容示意，触摸小游戏尚未接入", game_id="gate_search", game_available=False),
        SiteDefinition(site_id="C", name="诗意庭院", x=0.85, y=0.65, is_open=True,
                       reachable_sites=["A", "B"], task_name="诗句补全",
                       task_prompt="观察庭院文字；内容示意，触摸小游戏尚未接入", game_id="poem_completion", game_available=False),
    ])
