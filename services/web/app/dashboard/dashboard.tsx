"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { api } from "../../lib/api";
import { sourceSchema, type ActivitySnapshot, type DataSource, type SiteCatalog } from "../../lib/contracts";
import ScenarioPanel from "./scenario-panel";
import RecommendationChooser from "./recommendation-chooser";
import SiteMap from "./site-map";
import VisitTrend from "./visit-trend";

const siteNames = { A: "秦俑工坊", B: "长安城门", C: "诗意庭院" };
const statusNames = { fresh: "数据新鲜", stale: "数据已过时", missing: "尚无数据", untrusted: "时间不可靠" };
const heatNames = { low: "低", medium: "中", high: "高", insufficient: "数据不足" };
const estimateStatusNames = { ready: "可估计", missing: "尚无数据", stale: "数据已过时",
  untrusted: "时间不可靠", insufficient_samples: "两窗样本不足" };
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
  const [preparing, setPreparing] = useState(false);
  const [preparationNotice, setPreparationNotice] = useState("");
  const [batchId, setBatchId] = useState<string>();
  const [catalog, setCatalog] = useState<SiteCatalog>();
  const [catalogNotice, setCatalogNotice] = useState("正在读取节点位置配置");
  useEffect(() => {
    let active = true;
    setCatalog(undefined);
    setCatalogNotice("正在读取节点位置配置");
    void api.sites().then(value => {
      if (active) setCatalog(value);
    }).catch(() => {
      if (active) setCatalogNotice("节点配置读取失败，暂不绘制地图；可点击刷新重试，统计卡片仍可使用。");
    });
    return () => { active = false; };
  }, [refresh]);
  async function prepareDemo() {
    if (preparing) return;
    setPreparing(true);
    const id = batchId ?? crypto.randomUUID();
    setBatchId(id);
    try {
      const visits = await api.prepareDemo(id);
      if (visits.length !== 10 || visits.some(visit => visit.source !== "generated_simulation")) {
        throw new Error("演示响应来源或数量不匹配，不能展示为成功");
      }
      setBatchId(undefined);
      setSource("generated_simulation"); setRefresh(value => value + 1);
      setPreparationNotice("已准备10条生成模拟记录；请选择虚拟A1的最新到访，再手动生成建议。数据90秒后过期，可再次准备；不控制实物、不自动调用模型。");
    } catch (error) {
      setPreparationNotice(error instanceof Error ? `${error.message}；再次点击沿用同一批次重试，不重复创建` : "准备失败，结果未确认");
    } finally { setPreparing(false); }
  }
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
  const visits = current?.visits;
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
        <button className="rounded-lg border border-amber-500 px-4 py-2 disabled:opacity-50" disabled={preparing}
          onClick={() => { void prepareDemo(); }}>{preparing ? "正在准备模拟数据" : "生成演示数据（非真实到访）"}</button>
      </div>
    </header>
    {preparationNotice && <p role="status" className="rounded-xl bg-amber-50 p-3 text-sm text-amber-900">{preparationNotice}</p>}
    <div role="status" aria-live="polite" className={`rounded-xl p-3 ${offline ? "bg-amber-100" : "bg-stone-100"}`}>
      {notice}{offline && current ? "；以下为上次成功读取的旧快照，不代表当前情况" : ""}
      {map && <span className="ml-3">快照时间：{time(map.generated_at)}</span>}
    </div>
    {!map ? <p className={panel}>暂无所选来源的快照；不会填充虚构数值。</p> : <>
      {visits && <section className={panel} aria-label="当前活动到访汇总">
        <h2 className="text-xl font-semibold">当前活动到访汇总</h2>
        <p className="mt-1 text-sm text-stone-600">固定会话 demo-001，自首条有效记录至快照时间；仅统计上方所选来源，不是全景区游客人数。合并短时重复扫码，只纳入时间可靠且不晚于快照的到访。</p>
        <dl className="mt-4 grid gap-4 md:grid-cols-3">
          <div><dt className="text-sm text-stone-600">累计有效到访</dt><dd className="text-3xl font-semibold">{visits.total_visits} 次</dd></div>
          <div><dt className="text-sm text-stone-600">活动参与腰牌</dt><dd className="text-3xl font-semibold">{visits.participating_badges} 枚</dd></div>
          <div><dt className="text-sm text-stone-600">平均扫码间隔</dt><dd className="text-3xl font-semibold">{visits.average_scan_interval_seconds === null ? "暂无样本" : `${visits.average_scan_interval_seconds.toFixed(1)} 秒`}</dd></div>
        </dl>
        <p className="mt-4">节点累计到访：{visits.sites.map(site => `${site.site_id} ${siteNames[site.site_id]} ${site.visits} 次`).join("；")}</p>
        <p className="mt-2 text-sm text-stone-600">间隔样本 {visits.interval_samples} 对，比较同一腰牌相邻时间可靠的有效到访，含同节点再次到访；不是实际停留时长。排除时间不可靠 {visits.excluded_untrusted_events} 条、未来时间 {visits.excluded_future_events} 条。</p>
      </section>}
      <section className={panel}>
        <h2 className="text-xl font-semibold">节点示意与近期热度</h2>
        <p className="mt-1 text-sm text-stone-600">最近五分钟的不同腰牌数；节点示意不代表真实地理坐标。演示阈值：低 0—{map.heat_thresholds.medium_min - 1}、中 {map.heat_thresholds.medium_min}—{map.heat_thresholds.high_min - 1}、高 {map.heat_thresholds.high_min} 及以上；不代表场地安全容量。超过九十秒未更新或时间不可靠显示数据不足。</p>
        {catalog ? <SiteMap catalog={catalog} map={map} offline={offline} /> : <p role="status" className="mt-4 rounded-xl bg-stone-100 p-3">{catalogNotice}</p>}
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
          <VisitTrend map={map} offline={offline} />
          <div className="mt-4 rounded-xl border border-dashed border-amber-400 bg-amber-50 p-3" aria-label="下一五分钟到访趋势估计">
            <h3 className="font-semibold">下一五分钟到访趋势估计</h3>
            <p className="mt-1 text-sm">当前窗到访次数 × 0.7 ＋ 前一窗到访次数 × 0.3；两窗各至少一条时间可靠记录且节点数据新鲜才估计。单位：次有效到访／五分钟，不是去重腰牌数或现场人数。</p>
            <ul className="mt-3 space-y-2">{current?.trend_estimates.map(estimate => <li key={estimate.site_id} data-estimate-site={estimate.site_id}>
              {estimate.site_id} · {siteNames[estimate.site_id]}：{offline ? "暂不估计（后台未连接）"
                : estimate.estimated_next_visits === null ? `暂不估计（${estimateStatusNames[estimate.status]}）`
                  : `${estimate.estimated_next_visits.toFixed(1)} 次`}
              <span className="ml-2 text-xs text-stone-600">当前窗 {estimate.current_window_visits} 次／前一窗 {estimate.previous_window_visits} 次</span>
            </li>)}</ul>
            <p className="mt-2 text-xs text-stone-600">窗口以当前快照时间为界；估计目标为快照之后五分钟。这是明示权重的统计估计，不是训练模型，不显示准确率，不参与解锁、推荐候选热度或现场安全决策。</p>
          </div>
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
