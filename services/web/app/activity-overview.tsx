"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { api } from "../lib/api";
import { sourceSchema, type ActivitySnapshot, type DataSource } from "../lib/contracts";

const siteNames = { A: "秦俑工坊", B: "长安城门", C: "诗意庭院" };
const statusNames = { fresh: "数据新鲜", stale: "数据已过时", missing: "尚无数据", untrusted: "时间不可靠" };
const heatNames = { low: "低", medium: "中", high: "高", insufficient: "数据不足" };
const heatStyles = {
  low: "border-emerald-300 bg-emerald-50", medium: "border-amber-300 bg-amber-50",
  high: "border-red-300 bg-red-50", insufficient: "border-stone-300 bg-stone-100",
};

export default function ActivityOverview() {
  const [source, setSource] = useState<DataSource>("physical_scan_simulated_site");
  const [snapshot, setSnapshot] = useState<ActivitySnapshot>();
  const [offline, setOffline] = useState(true);
  const [notice, setNotice] = useState("正在读取活动概览");
  const [refresh, setRefresh] = useState(0);
  useEffect(() => {
    let active = true, pending = false;
    setOffline(true); setNotice("正在读取所选来源");
    async function load() {
      if (pending) return;
      pending = true;
      try {
        const value = await api.activity(source);
        if (value.map.source !== source) throw new Error("概览来源不匹配");
        if (active) { setSnapshot(value); setOffline(false); setNotice("每五秒更新，不控制实物设备"); }
      } catch {
        if (active) { setOffline(true); setNotice("概览读取失败，当前情况未确认；可重试"); }
      } finally { pending = false; }
    }
    void load();
    const timer = setInterval(() => { void load(); }, 5000);
    return () => { active = false; clearInterval(timer); };
  }, [source, refresh]);
  const current = snapshot?.map.source === source ? snapshot : undefined;
  return <section className="mb-6 rounded-2xl border border-stone-200 bg-white p-5" aria-label="手机活动概览">
    <h2 className="text-xl font-semibold">活动概览</h2>
    <p className="mt-2 text-sm text-stone-600">参与腰牌打卡数据，不是实时在场人数。</p>
    <div className="my-3 flex flex-wrap items-center gap-3">
      <label className="text-sm">概览数据来源 <select aria-label="概览数据来源" value={source} className="ml-2 max-w-full rounded-lg border p-2"
        onChange={event => setSource(sourceSchema.parse(event.target.value))}>
        <option value="physical_scan_simulated_site">实物扫码接口 · 模拟地点</option>
        <option value="interface_test">接口联调测试 · 不计真实到访</option>
        <option value="generated_simulation">生成模拟数据</option>
      </select></label>
      <button type="button" className="rounded-lg border px-3 py-2 text-sm" onClick={() => setRefresh(value => value + 1)}>刷新概览</button>
    </div>
    <p role="status" className={`mb-3 rounded-lg p-2 text-sm ${offline ? "bg-amber-100" : "bg-stone-100"}`}>
      {notice}{offline && current ? "；以下为上次成功读取的旧快照" : ""}
    </p>
    {!current ? <p className="text-sm text-stone-600">暂无所选来源快照，不填充其他来源的数字。</p> : <div data-overview-source={source}>
      <div className="grid gap-3 sm:grid-cols-3">{current.map.sites.map(site => {
        const heat = offline ? "insufficient" : site.heat;
        return <article key={site.site_id} data-overview-site={site.site_id} data-heat={heat}
          className={`rounded-xl border-2 p-3 ${heatStyles[heat]}`}>
          <h3 className="font-semibold">{site.site_id} · {siteNames[site.site_id]}</h3>
          <p className="mt-2">最近五分钟 <span data-overview-count>{site.recent_unique_badges}</span> 枚</p>
          <p className="text-sm">热度{heatNames[heat]} · {offline ? "当前未确认" : statusNames[site.data_status]}</p>
          <p className="mt-1 text-xs text-stone-600">观测更新：{site.updated_at ? new Date(site.updated_at).toLocaleString("zh-CN", { hour12: false }) : "无记录"}</p>
        </article>;
      })}</div>
      <p className="mt-3 text-sm">本活动累计 {current.visits.total_visits} 次有效到访，参与 {current.visits.participating_badges} 枚腰牌。</p>
      <p className="mt-1 text-xs text-stone-600">演示阈值：低 0—{current.map.heat_thresholds.medium_min - 1}、中 {current.map.heat_thresholds.medium_min}—{current.map.heat_thresholds.high_min - 1}、高 {current.map.heat_thresholds.high_min} 及以上。过期或时间不可靠显示数据不足，不代表场地安全容量。</p>
      <p className="mt-1 text-xs text-stone-600">快照时间：{new Date(current.map.generated_at).toLocaleString("zh-CN", { hour12: false })}。不是设备在线或执行确认。</p>
    </div>}
    <p className="mt-3 text-sm text-stone-600">下一站建议请打开底部“路线”，活动概览不改变腰牌连接或游玩进度。</p>
    <Link href="/dashboard" className="mt-2 inline-block text-sm underline">查看完整地图、趋势与情景推演</Link>
  </section>;
}
