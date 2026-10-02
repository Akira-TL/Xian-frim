"""明示假设的离散情景推演，不读取或写入活动事实。"""

from datetime import datetime
from typing import Annotated, Literal, Self

from pydantic import Field, FiniteFloat, model_validator

from .models import Contract, SiteId


class ScenarioNode(Contract):
    site_id: SiteId
    initial_people: Annotated[FiniteFloat, Field(ge=0, le=10000)]
    arrivals_per_minute: Annotated[FiniteFloat, Field(ge=0, le=1000)]
    stay_minutes: Annotated[FiniteFloat, Field(ge=1, le=240)]


class ScenarioRequest(Contract):
    nodes: Annotated[list[ScenarioNode], Field(min_length=3, max_length=3)]
    from_site: SiteId
    to_site: SiteId
    adoption_ratio: Annotated[FiniteFloat, Field(ge=0, le=1)]
    duration_minutes: Annotated[int, Field(ge=1, le=120)]

    @model_validator(mode="after")
    def validate_sites(self) -> Self:
        if {node.site_id for node in self.nodes} != {"A", "B", "C"}:
            raise ValueError("必须提供 A、B、C 各一个节点")
        if self.from_site == self.to_site:
            raise ValueError("分流原目标和新目标必须不同")
        return self


class ScenarioPopulation(Contract):
    site_id: SiteId
    people: Annotated[FiniteFloat, Field(ge=0)]


class ScenarioPoint(Contract):
    minute: int
    baseline: list[ScenarioPopulation]
    guided: list[ScenarioPopulation]
    diverted_arrivals: Annotated[FiniteFloat, Field(ge=0)]


class ScenarioResult(Contract):
    source: Literal["scenario_simulation"] = "scenario_simulation"
    generated_at: datetime
    step_minutes: Literal[1] = 1
    departure_rule: Literal["previous_people / stay_minutes"] = "previous_people / stay_minutes"
    metric_label: Literal["假设估计人数；情景推演；非现场观测"] = "假设估计人数；情景推演；非现场观测"
    parameters: ScenarioRequest
    series: list[ScenarioPoint]


def simulate(request: ScenarioRequest, now: datetime) -> ScenarioResult:
    nodes = sorted(request.nodes, key=lambda node: node.site_id)
    baseline = [ScenarioPopulation(site_id=node.site_id, people=node.initial_people) for node in nodes]
    guided = [point.model_copy() for point in baseline]
    origin = next(node for node in nodes if node.site_id == request.from_site)
    diverted = origin.arrivals_per_minute * request.adoption_ratio
    series = [ScenarioPoint(minute=0, baseline=baseline, guided=guided, diverted_arrivals=0)]
    for minute in range(1, request.duration_minutes + 1):
        baseline = [ScenarioPopulation(site_id=node.site_id,
                                       people=max(0, prior.people + node.arrivals_per_minute
                                                  - prior.people / node.stay_minutes))
                    for node, prior in zip(nodes, baseline)]
        guided = [ScenarioPopulation(site_id=node.site_id,
                                     people=max(0, prior.people + node.arrivals_per_minute
                                                - (diverted if node.site_id == request.from_site else 0)
                                                + (diverted if node.site_id == request.to_site else 0)
                                                - prior.people / node.stay_minutes))
                  for node, prior in zip(nodes, guided)]
        series.append(ScenarioPoint(minute=minute, baseline=baseline, guided=guided,
                                    diverted_arrivals=diverted))
    return ScenarioResult(generated_at=now, parameters=request, series=series)
