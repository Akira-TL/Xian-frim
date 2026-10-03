"use client";
import {useEffect, useRef, useState} from "react";
import Image from "next/image";
import AutoAwesomeRounded from "@mui/icons-material/AutoAwesomeRounded";
import RouteRounded from "@mui/icons-material/RouteRounded";
import PeopleAltRounded from "@mui/icons-material/PeopleAltRounded";
import {api} from "../lib/api";
import type {GuideRequest, RecommendationResult, VisitorProfile} from "../lib/contracts";
import {addGuideHistory, guideHistoryKey, readGuideHistory, type GuideHistoryItem} from "../lib/guide-history";

const places = {
  A: {name: "秦俑工坊", image: "/xks/images/guide-qin-v1.webp", description: "看看秦俑的神态与铠甲，拼回属于你的秦俑守护。"},
  B: {name: "长安城门", image: "/xks/images/gate-game-v1.webp", description: "从城门楼阁到旗鼓纹样，发现长安城里的有趣细节。"},
  C: {name: "诗意庭院", image: "/xks/images/guide-poetry-v1.webp", description: "在古树、碑石与庭院之间，读一读熟悉的唐诗。"},
};
const heatNames = {low: "热度较低", medium: "热度适中", high: "热度较高", insufficient: "热度待确认"};
const partyNames = {family: "带孩子", friends: "朋友同行", older: "长者同行", solo: "独自游览"};
const interestNames = {history: "历史文化", photography: "摄影打卡", poetry: "诗词书法"};

export default function VisitorRouteGuide({disabled}: {disabled: boolean}) {
  const [profile, setProfile] = useState<VisitorProfile>({party: "family", interest: "history", pace: "normal"});
  const [start, setStart] = useState<GuideRequest["start_site"]>("A");
  const [source, setSource] = useState<GuideRequest["data_source"]>("generated_simulation");
  const [scenario, setScenario] = useState<GuideRequest["crowd_scenario"]>("balanced");
  const [result, setResult] = useState<RecommendationResult>();
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const [now, setNow] = useState(Date.now());
  const [decision, setDecision] = useState<"accepted" | "rejected">();
  const [history, setHistory] = useState<GuideHistoryItem[]>([]);
  const active = useRef(true);
  const locked = useRef(false);
  useEffect(() => {
    active.current = true;
    try {
      const saved = readGuideHistory(localStorage.getItem(guideHistoryKey));
      setHistory(saved);
      if (saved[0]) {
        setResult(saved[0].result); setDecision(saved[0].decision);
        if (saved[0].result.input.visitor_profile) setProfile(saved[0].result.input.visitor_profile);
        setStart(saved[0].result.input.selected_visit_site);
        if (saved[0].result.input.data_source !== "interface_test") setSource(saved[0].result.input.data_source);
      }
    } catch { /* 浏览器禁止存储时仍可游览。 */ }
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => { active.current = false; clearInterval(timer); };
  }, []);
  const expired = result !== undefined && Date.parse(result.input.expires_at) <= now;
  const candidate = result?.input.candidates.find(item => item.site.site_id === result.selected_site);
  const place = candidate ? places[candidate.site.site_id] : undefined;
  function saveHistory(items: GuideHistoryItem[]) {
    setHistory(items);
    try { localStorage.setItem(guideHistoryKey, JSON.stringify(items)); }
    catch { setNotice("当前浏览器无法保存记录，离开页面后记录可能丢失"); }
  }
  function choose(value: "accepted" | "rejected") {
    if (!result || expired) return;
    setDecision(value);
    saveHistory(history.map(item => item.result.snapshot_id === result.snapshot_id ? {...item, decision: value} : item));
  }
  function clear() { setResult(undefined); setDecision(undefined); setNotice(""); }
  function preference<K extends keyof VisitorProfile>(key: K, value: VisitorProfile[K]) {
    setProfile(previous => ({...previous, [key]: value})); clear();
  }
  async function request() {
    if (locked.current || disabled) return;
    locked.current = true; setBusy(true); clear();
    try {
      const value = await api.guide({start_site: start, visitor_profile: profile, data_source: source, crowd_scenario: scenario});
      if (active.current) { setResult(value); setNow(Date.now()); saveHistory(addGuideHistory(history, value)); }
    } catch (error) {
      if (active.current) setNotice(error instanceof Error ? error.message : "暂时没有建议，请重试");
    } finally { locked.current = false; if (active.current) setBusy(false); }
  }
  return <section className="visitor-route-guide" aria-label="智能路线指引">
    <div className="guide-heading"><div><span>你的长安，怎么逛？</span><h1>下一站指引</h1></div><RouteRounded /></div>
    <div className="guide-preferences">
      <label>同行<select aria-label="同行情况" value={profile.party} disabled={busy}
        onChange={event => preference("party", event.target.value as VisitorProfile["party"])}>
        <option value="family">带孩子</option><option value="friends">朋友同行</option>
        <option value="older">长者同行</option><option value="solo">独自游览</option>
      </select></label>
      <label>兴趣<select aria-label="游览兴趣" value={profile.interest} disabled={busy}
        onChange={event => preference("interest", event.target.value as VisitorProfile["interest"])}>
        <option value="history">历史文化</option><option value="photography">摄影打卡</option><option value="poetry">诗词书法</option>
      </select></label>
      <label>节奏<select aria-label="游览节奏" value={profile.pace} disabled={busy}
        onChange={event => preference("pace", event.target.value as VisitorProfile["pace"])}>
        <option value="normal">正常节奏</option><option value="relaxed">慢慢逛</option>
      </select></label>
    </div>
    <div className="guide-start"><label>从哪里出发<select aria-label="出发地点" value={start} disabled={busy}
      onChange={event => {setStart(event.target.value as GuideRequest["start_site"]); clear();}}>
      {(["A", "B", "C"] as const).map(site => <option key={site} value={site}>{places[site].name}</option>)}
    </select></label><span>{source === "generated_simulation" ? "演示热度" : "打卡热度"}</span></div>
    <button className="visitor-primary guide-request" disabled={busy || disabled} onClick={() => void request()}>
      <AutoAwesomeRounded fontSize="small" />{busy ? "正在为你规划…" : result ? "重新推荐" : "为我推荐下一站"}
    </button>
    {place && candidate && result ? <article className="guide-destination" aria-live="polite">
      <div className="guide-picture"><Image key={place.image} src={place.image} width={720} height={480} alt={`${place.name}文化主题插画`} priority />
        <span>{result.source === "model" ? "AI 推荐" : "规则建议"}</span></div>
      <div className="guide-destination-body"><div className="guide-place-heading"><h2>{place.name}</h2>
        <span className={`guide-heat heat-${candidate.statistics.heat}`}><PeopleAltRounded fontSize="small" />{heatNames[candidate.statistics.heat]}</span></div>
        <p className="guide-description">{place.description}</p>
          <p className="guide-ai-text">{result.child_text}</p>
          <details className="guide-reason"><summary>为什么推荐这里</summary><p>{result.operator_reason}</p></details>
          {expired ? <p className="guide-expired">历史建议 · 当时的热度已过期，可重新推荐</p> :
          <div className="guide-actions"><button className="visitor-primary" onClick={() => choose("accepted")}>就去这里</button>
            <button onClick={() => choose("rejected")}>暂不去</button></div>}
          {decision && <p className="guide-decision">{decision === "accepted" ? "下一站就去这里，抵达后再打卡" : "换个兴趣或出发点，再看看推荐"}</p>}
      </div>
    </article> : <div className="guide-empty"><Image src="/xks/images/changan-gate-v3.webp" width={780} height={260} alt="长安文化探索插画" />
      <p>{busy ? "结合你的偏好与节点热度，寻找下一站" : result ? "暂时没有开放、可达且数据有效的下一站" : "告诉我们你的偏好，下一站不必随大流"}</p></div>}
    {notice && <p className="visitor-notice" role="status">{notice}</p>}
    <section className="guide-history" aria-label="路线推荐记录">
      <div className="guide-history-heading"><h2>路线记录</h2><span>最近 {history.length} 次建议</span></div>
      {history.length === 0 ? <p className="guide-history-empty">推荐会留在这里，随时回看。</p> :
        <ol>{history.map(({result: record, decision: choice}) => {
          const destination = record.selected_site ? places[record.selected_site] : undefined;
          const heat = record.input.candidates.find(item => item.site.site_id === record.selected_site)?.statistics.heat;
          return <li key={record.snapshot_id}>
            {destination && <Image src={destination.image} width={72} height={72} alt={`${destination.name}主题插画`} />}
            <div className="guide-history-content"><div className="guide-history-title"><h3>{destination?.name ?? "暂无合适下一站"}</h3>
              <time dateTime={record.input.generated_at}>{new Date(record.input.generated_at).toLocaleTimeString("zh-CN", {hour: "2-digit", minute: "2-digit"})}</time></div>
              <p>{choice === "accepted" ? "想去" : choice === "rejected" ? "暂不去" : "推荐建议"} · {record.source === "model" ? "AI 推荐" : record.source === "none" ? "暂无建议" : "规则建议"}</p>
              <details><summary>{record.child_text || "查看当次条件"}</summary>
                <p>{record.operator_reason}</p><p>从{places[record.input.selected_visit_site].name}出发 · {record.input.data_source === "generated_simulation" ? "演示热度" : "打卡热度"}{heat ? ` · 当时${heatNames[heat]}` : ""}</p>
                {record.input.visitor_profile && <p>{partyNames[record.input.visitor_profile.party]} · {interestNames[record.input.visitor_profile.interest]} · {record.input.visitor_profile.pace === "relaxed" ? "慢慢逛" : "正常节奏"}</p>}
                <p>推荐于 {new Date(record.input.generated_at).toLocaleString("zh-CN")}；仅保留当次依据，不代表当前客流或已到访。</p>
              </details>
            </div>
          </li>;
        })}</ol>}
    </section>
    <details className="guide-demo-settings"><summary>热度来源与演示设置</summary>
      <label>数据来源<select aria-label="热度数据来源" value={source} disabled={busy}
        onChange={event => {setSource(event.target.value as GuideRequest["data_source"]); clear();}}>
        <option value="generated_simulation">演示情景</option><option value="physical_scan_simulated_site">参与腰牌打卡</option>
      </select></label>
      {source === "generated_simulation" && <label>演示情景<select aria-label="演示热度情景" value={scenario} disabled={busy}
        onChange={event => {setScenario(event.target.value as GuideRequest["crowd_scenario"]); clear();}}>
        <option value="balanced">热度相近</option><option value="gate_busy">城门较热</option><option value="courtyard_busy">庭院较热</option>
      </select></label>}
      <p>热度来自演示输入或参与腰牌打卡，不是实时在场人数。文化主题插画，非实地导航。</p>
    </details>
  </section>;
}
