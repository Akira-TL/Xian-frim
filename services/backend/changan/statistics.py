"""只计算已记录到访；没有现场在场人数或安全容量推断。"""

from datetime import datetime, timedelta

from .models import (
    HeartbeatReceipt, HeatThresholds, MapSnapshot, SiteId, SiteStatistics, Source,
    TransitionCount, TrendPoint, Visit, VisitSummary, SiteVisitTotal, TrendEstimate,
)

SITES: tuple[SiteId, ...] = ("A", "B", "C")


def summarize_visits(visits: list[Visit], now: datetime, source: Source) -> VisitSummary:
    records = [visit for visit in visits if visit.source == source and visit.session_id == "demo-001"]
    trusted = [visit for visit in records if visit.time_quality == "synced" and visit.captured_at <= now]
    ordered = sorted(trusted, key=lambda visit: (visit.badge_id, visit.captured_at, visit.event_id))
    intervals = [(right.captured_at - left.captured_at).total_seconds()
                 for left, right in zip(ordered, ordered[1:]) if left.badge_id == right.badge_id]
    return VisitSummary(
        total_visits=len(trusted), participating_badges=len({visit.badge_id for visit in trusted}),
        sites=[SiteVisitTotal(site_id=site, visits=sum(visit.site_id == site for visit in trusted)) for site in SITES],
        interval_samples=len(intervals),
        average_scan_interval_seconds=sum(intervals) / len(intervals) if intervals else None,
        excluded_untrusted_events=sum(visit.time_quality == "untrusted" for visit in records),
        excluded_future_events=sum(visit.time_quality == "synced" and visit.captured_at > now for visit in records),
    )


def estimate_trend(visits: list[Visit], snapshot: MapSnapshot) -> list[TrendEstimate]:
    """两窗有效到访次数的加权估计；与去重腰牌观测及情景推演分开。"""
    now = snapshot.generated_at
    boundary = now - timedelta(minutes=5)
    start = now - timedelta(minutes=10)
    trusted = [visit for visit in visits if visit.session_id == snapshot.session_id
               and visit.source == snapshot.source and visit.time_quality == "synced"
               and start < visit.captured_at <= now]
    estimates: list[TrendEstimate] = []
    for site in snapshot.sites:
        recent = sum(visit.site_id == site.site_id and boundary < visit.captured_at for visit in trusted)
        previous = sum(visit.site_id == site.site_id and visit.captured_at <= boundary for visit in trusted)
        # 两个窗口各至少一条，避免将刚启动或完全缺观测的窗口当作可靠零值。
        status = site.data_status if site.data_status != "fresh" else (
            "ready" if recent > 0 and previous > 0 else "insufficient_samples")
        estimates.append(TrendEstimate(site_id=site.site_id,
            current_window_visits=recent, previous_window_visits=previous, status=status,
            estimated_next_visits=(7 * recent + 3 * previous) / 10 if status == "ready" else None))
    return estimates


def count_badges(visits: list[Visit], start: datetime, end: datetime) -> int:
    return len({visit.badge_id for visit in visits if start < visit.captured_at <= end})


def build_map(visits: list[Visit], heartbeats: list[HeartbeatReceipt],
              now: datetime, source: Source, thresholds: HeatThresholds | None = None) -> MapSnapshot:
    thresholds = thresholds or HeatThresholds()
    records = [visit for visit in visits if visit.source == source and visit.session_id == "demo-001"]
    trusted = [visit for visit in records if visit.time_quality == "synced" and visit.captured_at <= now]
    recent_start = now - timedelta(minutes=5)
    previous_start = now - timedelta(minutes=10)
    sites: list[SiteStatistics] = []
    trend: list[TrendPoint] = []
    for site in SITES:
        site_records = [visit for visit in trusted if visit.site_id == site]
        recent = count_badges(site_records, recent_start, now)
        previous = count_badges(site_records, previous_start, recent_start)
        uncertain = sum(visit.site_id == site and visit.time_quality == "untrusted"
                        and previous_start < visit.received_at <= now for visit in records)
        updates = [visit.captured_at for visit in site_records]
        if source == Source.PHYSICAL:
            updates.extend(heartbeat.captured_at for heartbeat in heartbeats
                           if heartbeat.site_id == site and heartbeat.captured_at <= now)
        updated_at = max(updates, default=None)
        if uncertain:
            status = "untrusted"
        elif updated_at is None:
            status = "missing"
        elif now - updated_at > timedelta(seconds=90):
            status = "stale"
        else:
            status = "fresh"
        heat = "insufficient" if status != "fresh" else (
            "low" if recent < thresholds.medium_min else "medium" if recent < thresholds.high_min else "high")
        sites.append(SiteStatistics(site_id=site, recent_unique_badges=recent,
                                    previous_unique_badges=previous, change=recent - previous,
                                    excluded_untrusted_events=uncertain, updated_at=updated_at,
                                    data_status=status, heat=heat))
    # 时间先后、节点次序固定；60 分钟观测曲线只报告已记录的去重腰牌数。
    for offset in range(12, 0, -1):
        start = now - timedelta(minutes=5 * offset)
        end = start + timedelta(minutes=5)
        for site in SITES:
            trend.append(TrendPoint(site_id=site, window_start=start, window_end=end,
                                    unique_badges=count_badges([v for v in trusted if v.site_id == site], start, end)))
    transitions: list[TransitionCount] = []
    routes = sorted(trusted, key=lambda visit: (visit.badge_id, visit.captured_at, visit.event_id))
    for origin in SITES:
        for destination in SITES:
            if origin == destination:
                continue
            count = sum(left.badge_id == right.badge_id and left.site_id == origin
                        and right.site_id == destination and previous_start < right.captured_at <= now
                        for left, right in zip(routes, routes[1:]))
            transitions.append(TransitionCount(from_site=origin, to_site=destination, count=count))
    return MapSnapshot(source=source, generated_at=now, heat_thresholds=thresholds,
                       sites=sites, trend=trend, transitions=transitions)
