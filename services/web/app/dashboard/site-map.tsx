import { useId } from "react";
import type { ActivitySnapshot, SiteCatalog } from "../../lib/contracts";

const colors = { low: "#047857", medium: "#b45309", high: "#b91c1c", insufficient: "#78716c" };
const heatNames = { low: "低", medium: "中", high: "高", insufficient: "数据不足" };
const statusNames = { fresh: "数据新鲜", stale: "数据已过时", missing: "尚无数据", untrusted: "时间不可靠" };
const sourceNames = {
  physical_scan_simulated_site: "实物扫码接口 · 模拟地点",
  generated_simulation: "生成模拟数据",
  interface_test: "接口联调测试 · 不计真实到访",
};

export default function SiteMap({ catalog, map, offline }: {
  catalog: SiteCatalog;
  map: ActivitySnapshot["map"];
  offline: boolean;
}) {
  const arrowId = useId();
  const position = (site: SiteCatalog["sites"][number]) => ({ x: 140 + site.x * 680, y: 90 + site.y * 220 });
  return <figure className="mt-4 overflow-hidden rounded-xl border border-stone-200 bg-stone-50">
    <svg viewBox="0 0 960 420" className="w-full" role="img" aria-label="园区三节点示意地图，箭头表示配置的可达方向，非真实地理地图">
      <defs><marker id={arrowId} viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
        <path d="M 0 0 L 10 5 L 0 10 z" fill="#a8a29e" />
      </marker></defs>
      {catalog.sites.flatMap(site => site.reachable_sites.map(targetId => {
        const target = catalog.sites.find(candidate => candidate.site_id === targetId);
        if (!target) return null;
        const mutual = target.reachable_sites.includes(site.site_id);
        if (mutual && site.site_id > targetId) return null;
        const start = position(site), end = position(target);
        const length = Math.hypot(end.x - start.x, end.y - start.y);
        if (length === 0) return null;
        const dx = (end.x - start.x) / length, dy = (end.y - start.y) / length;
        return <line key={`${site.site_id}-${targetId}`} x1={start.x + dx * 60} y1={start.y + dy * 60}
          x2={end.x - dx * 60} y2={end.y - dy * 60} stroke="#a8a29e" strokeWidth="3" strokeDasharray="8 6"
          markerStart={mutual ? `url(#${arrowId})` : undefined} markerEnd={`url(#${arrowId})`} />;
      }))}
      {catalog.sites.map(site => {
        const observation = map.sites.find(value => value.site_id === site.site_id);
        const heat = !offline && observation?.data_status === "fresh" ? observation.heat : "insufficient";
        const point = position(site);
        const status = offline ? "旧快照，当前未确认" : observation ? statusNames[observation.data_status] : "尚无数据";
        return <g key={site.site_id} data-site={site.site_id} data-heat={heat} transform={`translate(${point.x},${point.y})`}>
          <title>{site.site_id} · {site.name}；{status}；热度{heatNames[heat]}；{site.is_open ? "开放" : "关闭"}</title>
          <circle r="51" fill={colors[heat]} stroke="white" strokeWidth="4" strokeDasharray={site.is_open ? undefined : "6 4"} />
          <text textAnchor="middle" y="-9" fill="white" fontSize="24" fontWeight="600">{site.site_id}</text>
          <text textAnchor="middle" y="20" fill="white" fontSize="18">{observation?.recent_unique_badges ?? "—"} 枚</text>
          <text textAnchor="middle" y="77" fill="#292524" fontSize="20" fontWeight="600">{site.name}{site.is_open ? "" : "（关闭）"}</text>
          <text textAnchor="middle" y="103" fill="#57534e" fontSize="16">{status} · {heatNames[heat]}</text>
        </g>;
      })}
    </svg>
    <figcaption className="space-y-2 border-t border-stone-200 p-3 text-sm text-stone-600">
      <p>来源：{sourceNames[map.source]}。园区示意，非真实地理地图；位置和箭头来自节点配置第 {catalog.version} 版，不表示实际距离或已发生的移动。</p>
      <p>圆内为最近五分钟不同腰牌数，不是实时在场人数。灰色表示数据不足或当前未确认；详细更新时间见下方卡片。</p>
      <div className="flex flex-wrap gap-4">{Object.entries(heatNames).map(([key, label]) => <span key={key} className="flex items-center gap-2">
        <span aria-hidden="true" className="inline-block h-3 w-3 rounded-full" style={{ backgroundColor: colors[key as keyof typeof colors] }} />{label}
      </span>)}</div>
    </figcaption>
  </figure>;
}
