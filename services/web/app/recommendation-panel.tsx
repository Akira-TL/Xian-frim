"use client";

import { useEffect, useRef, useState } from "react";
import { api } from "../lib/api";
import type { RecommendationResult, Visit } from "../lib/contracts";

type View = { result: RecommendationResult; historical: boolean; historyExpired: boolean };
function time(value: string) { return new Date(value).toLocaleString("zh-CN", { hour12: false }); }

export default function RecommendationPanel({ visit, disabled = false }: { visit: Visit; disabled?: boolean }) {
  const [view, setView] = useState<View>();
  const [notice, setNotice] = useState("点击生成建议；模型不可用时，规则建议会明确标注");
  const [busy, setBusy] = useState(false);
  const [now, setNow] = useState(Date.now());
  const [decision, setDecision] = useState<"accepted" | "rejected">();
  const locked = useRef(false);
  const generation = useRef(0);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => { clearInterval(timer); generation.current += 1; };
  }, []);
  const captured = Date.parse(visit.captured_at);
  const usableVisit = visit.time_quality === "synced" && captured <= now && now - captured < 90_000;
  const result = view?.result;
  const expired = !!view && (view.historyExpired || Date.parse(view.result.input.expires_at) <= now);
  const candidate = result?.input.candidates.find(item => item.site.site_id === result.selected_site);
  const originLabel = result?.source === "model" ? "模型建议（输出校验通过）"
    : result?.source === "rule_fallback" ? result.fallback_reason === "invalid_output"
      ? "规则建议（模型输出校验失败）" : result.fallback_reason === "timeout"
        ? "规则建议（模型八秒内未返回）" : "规则建议（AI 未配置）" : "无有效候选";
  const mayChoose = !!candidate && !view?.historical && !expired && !busy && !disabled;

  async function request(historical: boolean) {
    if (locked.current || (historical && !result)) return;
    locked.current = true; setBusy(true); setNotice(historical ? "正在回读历史快照" : "正在生成下一站建议");
    const current = generation.current;
    try {
      let next: View;
      if (historical && result) {
        const record = await api.recommendationRecord(result.snapshot_id);
        if (record.result.snapshot_id !== result.snapshot_id) throw new Error("历史快照编号不匹配");
        next = { result: record.result, historical: true, historyExpired: record.expired };
      } else {
        const generated = await api.recommend({ badge_id: visit.badge_id, event_id: visit.event_id });
        if (generated.input.data_source !== visit.source || generated.input.selected_visit_site !== visit.site_id) {
          throw new Error("推荐来源或到访地点不匹配，不能展示");
        }
        next = { result: generated, historical: false, historyExpired: false };
      }
      if (generation.current !== current) return;
      setView(next); setDecision(undefined); setNow(Date.now());
      setNotice(historical ? "历史回读完成；没有发生新的模型请求" : "建议已读取；不会自动执行设备操作");
    } catch (error) {
      if (generation.current !== current) return;
      setView(undefined); setDecision(undefined);
      setNotice(error instanceof TypeError || error instanceof DOMException ? "网络连接失败或查询超时，未取得可用建议"
        : error instanceof Error ? error.message : "建议查询失败");
    } finally {
      locked.current = false;
      if (generation.current === current) setBusy(false);
    }
  }

  return <section className="rounded-xl border border-stone-200 bg-white p-4">
    <h2 className="text-lg font-semibold">下一站建议</h2>
    <p className="mt-2 text-sm text-stone-600">以选定到访为依据，建议可拒绝。采纳只表示本页人工选择，不产生到访、解锁或完成记录。</p>
    <div className="mt-3 flex flex-wrap gap-2">
      <button type="button" className="rounded-lg bg-stone-800 px-4 py-2 text-white" disabled={busy || disabled || !usableVisit}
        onClick={() => { void request(false); }}>生成下一站建议</button>
      <button type="button" className="rounded-lg border px-4 py-2" disabled={busy || disabled || !result}
        onClick={() => { void request(true); }}>核对历史记录</button>
    </div>
    {!usableVisit && <p className="mt-2 text-sm text-amber-800">所选到访时间不可靠、来自未来或已达到九十秒，请选择新的有效到访。</p>}
    <p role="status" aria-live="polite" className="mt-3 text-sm">{notice}</p>
    {result && <div className="mt-4 space-y-3">
      <div className={`rounded-lg p-3 ${expired || view?.historical ? "bg-amber-100" : "bg-stone-100"}`}>
        <p className="font-semibold">{view?.historical ? "历史记录 · 原结果：" : "本次结果："}{originLabel}</p>
        {view?.historical && <p>不是本次实时 AI 输出；历史回读不延长有效期。</p>}
        {expired && <p>快照已失效，不能作为当前建议；请重新生成。</p>}
        <p className="mt-2 text-xs">生成：{time(result.input.generated_at)} · 失效：{time(result.input.expires_at)}</p>
        <p className="break-all text-xs">快照编号：{result.snapshot_id}</p>
      </div>
      {candidate && <div>
        <h3 className="font-semibold">原建议地点：{candidate.site.site_id} · {candidate.site.name}</h3>
        <p>{expired || view?.historical ? "历史儿童文案（不作为当前建议）：" : "给孩子的话："}{result.child_text}</p>
        <p className="mt-2 text-sm text-stone-600">内容提示：{candidate.site.task_prompt}</p>
        {!candidate.site.game_available && <p className="text-sm text-amber-800">该点触摸小游戏尚未接入。</p>}
      </div>}
      <p className="text-sm">工作人员依据：{result.operator_reason}</p>
      <div className="flex flex-wrap gap-2">
        <button type="button" disabled={!mayChoose} className="rounded-lg border px-3 py-2" onClick={() => setDecision("accepted")}>采纳建议（仅本页选择）</button>
        <button type="button" disabled={!mayChoose} className="rounded-lg border px-3 py-2" onClick={() => setDecision("rejected")}>不采用建议</button>
      </div>
      {decision && <p className="text-sm">{expired ? "先前选择已失效，请重新生成。" : decision === "accepted"
        ? `本页选择：前往 ${candidate?.site.name}；仍须实际到访后再操作设备。` : "本页选择：不采用，保留原路线。"}</p>}
      <details className="rounded-lg bg-stone-50 p-3"><summary className="cursor-pointer text-sm font-semibold">输入统计与最终依据</summary>
        <div className="mt-3 space-y-2 text-sm">
          <p>来源：{result.input.data_source === "generated_simulation" ? "生成模拟数据；不具备实物解锁资格" : "实物扫码接口 · 模拟地点"}</p>
          <p>配置版本：{result.input.catalog_version} · 已到访节点：{result.input.visited_sites.join("、") || "无"}</p>
          <p>已认证完成任务：{result.input.completed_games.length ? "秦俑归阵" : "无已认证完成记录"} · 认证时间：{result.input.progress_verified_at ? time(result.input.progress_verified_at) : "无实物认证记录"}</p>
          <ul>{result.input.candidates.map(item => <li className="mt-2" key={item.site.site_id}>
            {item.site.site_id} · {item.site.name}：最近五分钟 {item.statistics.recent_unique_badges} 枚腰牌，{item.visited ? "已到访" : "尚未到访"}，观测更新 {item.statistics.updated_at ? time(item.statistics.updated_at) : "无记录"}
          </li>)}</ul>
          <p>上述为输入快照，不代表实时在场人数、现场安全容量或儿童兴趣画像。</p>
        </div>
      </details>
    </div>}
  </section>;
}
