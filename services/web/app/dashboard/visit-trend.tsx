import type { ActivitySnapshot } from "../../lib/contracts";

const sites = [
  { id: "A", name: "秦俑工坊", color: "#2563eb" },
  { id: "B", name: "长安城门", color: "#b45309" },
  { id: "C", name: "诗意庭院", color: "#7c3aed" },
] as const;
const sourceNames = {
  physical_scan_simulated_site: "实物扫码接口 · 模拟地点",
  generated_simulation: "生成模拟数据",
  interface_test: "接口联调测试 · 不计真实到访",
};
function clock(value: string) {
  return new Date(value).toLocaleTimeString("zh-CN", { hour12: false, hour: "2-digit", minute: "2-digit" });
}

export default function VisitTrend({ map, offline }: { map: ActivitySnapshot["map"]; offline: boolean }) {
  const windows = map.trend.filter((point, index, values) => values.findIndex(value =>
    value.window_start === point.window_start && value.window_end === point.window_end) === index)
    .sort((left, right) => Date.parse(left.window_end) - Date.parse(right.window_end));
  if (windows.length === 0) return <p className="mt-4 rounded-xl bg-stone-100 p-3">暂无趋势窗口，不绘制虚构曲线。</p>;
  const top = Math.max(4, Math.ceil(Math.max(...map.trend.map(point => point.unique_badges)) / 4) * 4);
  const x = (index: number) => 65 + (windows.length === 1 ? 330 : index * 660 / (windows.length - 1));
  const y = (value: number) => 270 - value * 210 / top;
  const ticks = [...new Set([0, Math.floor((windows.length - 1) / 2), windows.length - 1])];
  return <figure className="mt-4 rounded-xl border border-stone-200 bg-stone-50 p-3" data-trend-source={map.source}>
    <svg viewBox="0 0 800 340" className="w-full" role="img" aria-label="三个节点最近一小时的五分钟去重到访观测趋势">
      <text x="65" y="25" fill="#57534e" fontSize="16">枚不同腰牌 / 五分钟</text>
      {[0, 1, 2, 3, 4].map(index => {
        const value = index * top / 4;
        return <g key={index}><line x1="65" x2="725" y1={y(value)} y2={y(value)} stroke="#d6d3d1" />
          <text x="50" y={y(value) + 5} textAnchor="end" fontSize="15" fill="#57534e">{value}</text></g>;
      })}
      {sites.map(site => {
        let joined = false;
        const points = windows.map((window, index) => ({ index, point: map.trend.find(value =>
          value.site_id === site.id && value.window_start === window.window_start && value.window_end === window.window_end) }));
        const path = points.map(({ index, point }) => {
          if (!point) { joined = false; return ""; }
          const command = joined ? "L" : "M"; joined = true;
          return `${command}${x(index)},${y(point.unique_badges)}`;
        }).join(" ");
        return <g key={site.id} data-trend-site={site.id}>
          <path d={path} fill="none" stroke={site.color} strokeWidth="2.5" />
          {points.map(({ index, point }) => point && <circle key={point.window_start} cx={x(index)} cy={y(point.unique_badges)}
            r="3.5" fill={site.color} data-window-end={point.window_end} data-count={point.unique_badges}>
            <title>{site.id} · {site.name}，{clock(point.window_start)}—{clock(point.window_end)}：{point.unique_badges} 枚</title>
          </circle>)}
        </g>;
      })}
      {ticks.map(index => <text key={index} x={x(index)} y="302" textAnchor="middle" fill="#57534e" fontSize="15">{clock(windows[index].window_end)}</text>)}
      <text x="725" y="328" textAnchor="end" fill="#57534e" fontSize="14">窗口结束时间</text>
    </svg>
    <figcaption className="space-y-2 text-sm text-stone-600">
      <div className="flex flex-wrap gap-4">{sites.map(site => <span key={site.id} className="flex items-center gap-2">
        <span aria-hidden="true" className="inline-block h-1 w-5" style={{ background: site.color }} />{site.id} · {site.name}
      </span>)}</div>
      <p>来源：{sourceNames[map.source]}。范围：{new Date(windows[0].window_start).toLocaleString("zh-CN", { hour12: false })}—{new Date(windows[windows.length - 1].window_end).toLocaleString("zh-CN", { hour12: false })}。</p>
      <p>{offline ? "上次成功读取的旧快照，当前未确认。" : "已记录到访的观测曲线。"}实线连接五分钟窗口的统计点，不是连续客流、预测或情景推演；零表示没有合格记录，不表示现场无人。缺失点断线，具体数值见下方明细表。</p>
    </figcaption>
  </figure>;
}
