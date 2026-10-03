"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { api } from "../../lib/api";
import { sourceSchema, type ActivitySnapshot, type DataSource } from "../../lib/contracts";
import ScenarioPanel from "./scenario-panel";
import RecommendationChooser from "./recommendation-chooser";

const siteNames = { A: "秦俑工坊", B: "长安城门", C: "诗意庭院" };
const statusNames = { fresh: "数据新鲜", stale: "数据已过时", missing: "尚无数据", untrusted: "时间不可靠" };
const heatNames = { low: "低", medium: "中", high: "高", insufficient: "数据不足" };
const heatStyles = {
  low: "border-emerald-300 bg-emerald-50", medium: "border-amber-300 bg-amber-50",
  high: "border-red-300 bg-red-50", insufficient: "border-stone-300 bg-stone-100",
};
const panel = "rounded-2xl border border-stone-200 bg-white p-5";
function time(value: string | null) {
  return value === null ? "无认证记录" : new Date(value).toLocaleString("zh-CN", { hour12: false });
}
function clock(value: string) {
  return new Date(value).toLocaleTimeString("zh-CN", { hour12: false });
}

export default function Dashboard() {
  const [source, setSource] = useState<DataSource>("physical_scan_simulated_site");
  const [snapshot, setSnapshot] = useState<ActivitySnapshot>();
  const [notice, setNotice] = useState("正在读取看板数据");
  const [offline, setOffline] = useState(true);
  const [refresh, setRefresh] = useState(0);
  useEffect(() => {
    let active = true;
    let pending = false;
    setOffline(true); setNotice("正在读取所选来源的数据");
    async function load() {
      if (pending) return;
      pending = true;
      try {
        const value = await api.activity(source);
        if (!active) return;
        if (value.map.source !== source) throw new Error("响应来源不匹配，不能展示");
        setSnapshot(value); setOffline(false); setNotice("每五秒自动更新；无需登录");
      } catch (error) {
        if (active) {
          setOffline(true);
          setNotice(error instanceof TypeError || error instanceof DOMException
            ? "网络连接失败或查询超时，当前数据未确认" : error instanceof Error ? error.message : "读取失败");
        }
      } finally { pending = false; }
    }
    void load();
    const timer = setInterval(() => { void load(); }, 5000);
    return () => { active = false; clearInterval(timer); };
  }, [source, refresh]);
  // 切换来源期间绝不显示另一来源留下的数据。
  const current = snapshot?.map.source === source ? snapshot : undefined;
  const map = current?.map;
  const progress = current?.progress;
  const windows = map?.trend.filter(point => point.site_id === "A") ?? [];
  const completedRate = progress && progress.unlocked_badges > 0
    ? `${(100 * progress.completed_badges / progress.unlocked_badges).toFixed(1)}%` : "暂无可计算数据";

  return <main className="mx-auto max-w-7xl space-y-6 p-4 md:p-8">
    <header className="flex flex-wrap items-start justify-between gap-4">
      <div><p className="text-sm text-stone-600">长安游迹 · 固定演示会话 demo-001</p>
        <h1 className="mt-1 text-3xl font-semibold">活动数据看板</h1>
        <p className="mt-2 text-stone-600">参与腰牌打卡数据；非实时在场人数</p></div>
      <div className="flex flex-wrap items-center gap-3">
        <Link className="underline" href="/">手机操作页</Link>
        <label>数据来源 <select className="rounded-lg border bg-white p-2" value={source}
          onChange={event => setSource(sourceSchema.parse(event.target.value))}>
          <option value="physical_scan_simulated_site">实物扫码接口 · 模拟地点</option>
          <option value="generated_simulation">生成模拟数据</option>
          <option value="interface_test">接口联调测试 · 不计真实到访</option>
        </select></label>
        <button className="rounded-lg bg-stone-800 px-4 py-2 text-white" onClick={() => setRefresh(value => value + 1)}>刷新</button>
      </div>
    </header>
    <div role="status" aria-live="polite" className={`rounded-xl p-3 ${offline ? "bg-amber-100" : "bg-stone-100"}`}>
      {notice}{offline && current ? "；以下为上次成功读取的旧快照，不代表当前情况" : ""}
      {map && <span className="ml-3">快照时间：{time(map.generated_at)}</span>}
    </div>
    {!map ? <p className={panel}>暂无所选来源的快照；不会填充虚构数值。</p> : <>
      <section className={panel}>
        <h2 className="text-xl font-semibold">节点示意与近期热度</h2>
        <p className="mt-1 text-sm text-stone-600">最近五分钟的不同腰牌数；节点示意不代表真实地理坐标。演示阈值：低 0—{map.heat_thresholds.medium_min - 1}、中 {map.heat_thresholds.medium_min}—{map.heat_thresholds.high_min - 1}、高 {map.heat_thresholds.high_min} 及以上；不代表场地安全容量。超过九十秒未更新或时间不可靠显示数据不足。</p>
        <div className="mt-4 grid gap-4 md:grid-cols-3">{map.sites.map(site => <article key={site.site_id}
          className={`rounded-xl border-2 p-4 ${heatStyles[site.heat]}`}>
          <h3 className="text-lg font-semibold">{site.site_id} · {siteNames[site.site_id]}</h3>
          <p className="mt-3 text-3xl font-semibold">{site.recent_unique_badges}<span className="ml-2 text-sm font-normal">枚腰牌 / 五分钟</span></p>
          <p className="mt-2">热度：{heatNames[site.heat]} · {statusNames[site.data_status]}</p>
          <p className="text-sm">较前五分钟：{site.change > 0 ? "+" : ""}{site.change} 枚</p>
          <p className="mt-3 text-xs text-stone-600">观测更新时间：{site.updated_at ? time(site.updated_at) : "无记录"}</p>
          <p className="text-xs text-stone-600">最近十分钟排除时间不可靠事件：{site.excluded_untrusted_events} 条</p>
        </article>)}</div>
      </section>
      <div className="grid gap-6 lg:grid-cols-2">
        <section className={panel}><h2 className="text-xl font-semibold">固定窗口到访趋势</h2>
          <p className="mt-1 text-sm text-stone-600">单位：枚不同腰牌 / 五分钟。仅纳入时间可靠的事件；零表示该窗口无合格记录，不表示现场无人。</p>
          <div className="mt-4 overflow-x-auto"><table className="w-full text-left text-sm">
            <thead><tr><th className="py-2">时间窗（左开右闭）</th>{map.sites.map(site => <th key={site.site_id}>{site.site_id} · {siteNames[site.site_id]}</th>)}</tr></thead>
            <tbody>{windows.map(window => <tr className="border-t" key={window.window_start}>
              <td className="py-2">{clock(window.window_start)}—{clock(window.window_end)}</td>
              {map.sites.map(site => <td key={site.site_id}>{map.trend.find(point => point.site_id === site.site_id && point.window_start === window.window_start)?.unique_badges ?? "无数据"}</td>)}
            </tr>)}</tbody>
          </table></div>
        </section>
        <div className="space-y-6">
          <section className={panel}><h2 className="text-xl font-semibold">已观察到的节点转移</h2>
            <p className="mt-1 text-sm text-stone-600">同一腰牌相邻有效到访；后一条在最近十分钟。不是精确轨迹或实际停留时长。</p>
            <ul className="mt-3 grid grid-cols-2 gap-2">{map.transitions.map(transition => <li className="rounded-lg bg-stone-50 p-2" key={`${transition.from_site}-${transition.to_site}`}>
              {transition.from_site} → {transition.to_site}：{transition.count} 次
            </li>)}</ul>
          </section>
          <section className={panel}><h2 className="text-xl font-semibold">《秦俑归阵》认证进度</h2>
            {!progress ? <p className="mt-3">生成模拟数据不适用实物进度统计。</p> : <>
              <p className="mt-2 text-sm text-stone-600">{source === "interface_test"
                ? "仅统计本会话有 A 点接口测试记录的腰牌，不计真实到访；设备状态来自真实认证回执。"
                : "仅统计本会话有 A 点实物来源到访的腰牌。"}状态为后台最后认证记录，不表示设备在线。</p>
              <dl className="mt-4 grid grid-cols-3 gap-3">{[
                ["符合到访条件", progress.eligible_badges], ["已认证状态", progress.verified_badges],
                ["设备确认解锁", progress.unlocked_badges], ["设备确认完成", progress.completed_badges],
                ["设备确认收藏", progress.collected_badges], ["设备确认展示", progress.exhibiting_badges],
              ].map(([label, value]) => <div key={label}><dt className="text-xs text-stone-600">{label}</dt><dd className="text-2xl">{value}</dd></div>)}</dl>
              <p className="mt-4">游戏完成率：{completedRate}</p>
              <p className="text-xs text-stone-600">最近认证：{time(progress.last_verified_at)}</p>
            </>}
            <p className="mt-3 text-sm text-stone-600">人工核验未启用；已发送请求不计入设备执行数。</p>
          </section>
        </div>
      </div>
    </>}
    <RecommendationChooser key={source} source={source} refresh={refresh} />
    <ScenarioPanel />
    <footer className={panel}>推荐按实际结果标注模型来源、规则降级或无有效候选。情景推演与到访观测、游戏进度完全独立。</footer>
  </main>;
}
