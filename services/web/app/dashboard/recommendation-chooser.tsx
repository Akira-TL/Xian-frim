"use client";

import { useEffect, useState } from "react";
import { api } from "../../lib/api";
import type { DataSource, Visit } from "../../lib/contracts";
import RecommendationPanel from "../recommendation-panel";

const siteNames = { A: "秦俑工坊", B: "长安城门", C: "诗意庭院" };

export default function RecommendationChooser({ source, refresh }: { source: DataSource; refresh: number }) {
  const [visits, setVisits] = useState<Visit[]>([]);
  const [selectedId, setSelectedId] = useState("");
  const [offline, setOffline] = useState(true);
  const [notice, setNotice] = useState("正在读取推荐用到访记录");
  useEffect(() => {
    let active = true;
    let pending = false;
    setOffline(true);
    async function load() {
      if (pending) return;
      pending = true;
      try {
        const records = await api.visits();
        if (!active) return;
        setVisits(records.filter(visit => visit.source === source));
        setOffline(false); setNotice("每五秒更新到访列表；选择后手动生成建议，不自动请求推荐");
      } catch (error) {
        if (!active) return;
        setOffline(true);
        setNotice(error instanceof TypeError || error instanceof DOMException
          ? "到访查询失败或超时；旧列表不代表当前状态，暂停生成与采纳"
          : error instanceof Error ? error.message : "到访查询失败");
      } finally { pending = false; }
    }
    void load();
    const timer = setInterval(() => { void load(); }, 5000);
    return () => { active = false; clearInterval(timer); };
  }, [source, refresh]);
  const selected = visits.find(visit => visit.event_id === selectedId);

  return <section aria-label="看板下一站建议" className="rounded-2xl border border-stone-200 bg-white p-5">
    <h2 className="text-xl font-semibold">推荐依据选择</h2>
    <p className="mt-2 text-sm text-stone-600">当前来源：{source === "generated_simulation" ? "生成模拟数据，不具备实物解锁资格" : "实物扫码接口 · 模拟地点"}。切换来源清除旧建议与人工选择。</p>
    <p className={`mt-2 text-sm ${offline ? "text-amber-800" : "text-stone-600"}`} role="status">{notice}</p>
    <label className="mt-4 block">选择腰牌到访
      <select aria-label="推荐依据到访" className="mt-2 w-full rounded-lg border bg-white p-2"
        value={selected ? selectedId : ""} disabled={offline || visits.length === 0}
        onChange={event => setSelectedId(event.target.value)}>
        <option value="">请选择；不会自动选取或生成</option>
        {visits.map(visit => <option key={visit.event_id} value={visit.event_id}>
          {visit.badge_id} · {siteNames[visit.site_id]} · {new Date(visit.captured_at).toLocaleString("zh-CN", { hour12: false })} · {visit.event_id}
        </option>)}
      </select>
    </label>
    {!offline && visits.length === 0 && <p className="mt-3">当前来源暂无到访，不填充虚构推荐。</p>}
    {selected ? <div className="mt-4"><RecommendationPanel key={selected.event_id} visit={selected} disabled={offline} /></div>
      : <p className="mt-3 text-sm text-stone-600">未选择可用记录；当前 AI 未配置，生成结果只会明确标注为规则建议或无有效候选。</p>}
  </section>;
}
