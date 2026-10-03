"use client";
import { useEffect, useRef, useState } from "react";
import Image from "next/image";
import { api } from "../lib/api";
import type { RecommendationResult, Visit } from "../lib/contracts";

export default function VisitorRecommendation({ visit, disabled }: { visit?: Visit; disabled: boolean }) {
  const [result, setResult] = useState<RecommendationResult>();
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const [now, setNow] = useState(Date.now());
  const [decision, setDecision] = useState<"accepted" | "rejected">();
  const locked = useRef(false); const active = useRef(true);
  useEffect(() => { active.current = true; const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => { active.current = false; clearInterval(timer); }; }, []);
  const usable = visit?.time_quality === "synced" && Date.parse(visit.captured_at) <= now && now - Date.parse(visit.captured_at) < 90_000;
  const expired = result !== undefined && Date.parse(result.input.expires_at) <= now;
  const candidate = result?.input.candidates.find(item => item.site.site_id === result.selected_site);
  async function request() {
    if (!visit || !usable || locked.current || disabled) return;
    locked.current = true; setBusy(true); setNotice(""); setDecision(undefined); setResult(undefined);
    try {
      const value = await api.recommend({ badge_id: visit.badge_id, event_id: visit.event_id });
      if (value.input.data_source !== visit.source || value.input.selected_visit_site !== visit.site_id) throw new Error("建议未确认");
      if (active.current) setResult(value);
    } catch { if (active.current) setNotice("暂时没有建议，请稍后重试"); }
    finally { locked.current = false; if (active.current) setBusy(false); }
  }
  return <section className="visitor-feature visitor-next"><h2>下一站</h2>
    <Image src="/xks/images/changan-gate-v3.webp" width={780} height={260} alt="下一站文化探索" />
    <h3>{candidate && !expired ? candidate.site.name : "去发现长安"}</h3>
    <button className="visitor-primary" disabled={disabled || busy || !usable} onClick={() => void request()}>{busy ? "寻找中…" : "获取建议"}</button>
    {!usable && !result && <p className="visitor-notice">到站打卡后获取</p>}
    {result && <div className="visitor-suggestion" role="status">{expired ? <p>建议已过期，请重新获取</p> : !candidate ? <p>暂无合适的下一站</p> : <>
      <small>{result.source === "model" ? "智能建议" : "规则建议"}{visit?.source === "interface_test" ? " · 演示" : ""}</small><p>{result.child_text}</p>
      <div><button disabled={busy || disabled} onClick={() => setDecision("accepted")}>想去</button><button disabled={busy || disabled} onClick={() => setDecision("rejected")}>暂不去</button></div>
      {decision && <p>{decision === "accepted" ? "已记下你的选择" : "再探索其他地方吧"}</p>}</>}
    </div>}{notice && <p className="visitor-notice" role="status">{notice}</p>}
  </section>;
}
