"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import Image from "next/image";
import { api } from "../lib/api";
import type { Badge, DeviceState, Visit } from "../lib/contracts";
import { BadgeControl } from "../lib/badge-control";
import { bluetoothSupport, connectBadge } from "../lib/web-bluetooth";
import VisitorRecommendation from "./visitor-recommendation";
import ExploreRounded from "@mui/icons-material/ExploreRounded";
import CollectionsBookmarkRounded from "@mui/icons-material/CollectionsBookmarkRounded";
import RouteRounded from "@mui/icons-material/RouteRounded";
import LockOpenRounded from "@mui/icons-material/LockOpenRounded";
import SportsEsportsRounded from "@mui/icons-material/SportsEsportsRounded";
import ImageRounded from "@mui/icons-material/ImageRounded";
import CheckCircleRounded from "@mui/icons-material/CheckCircleRounded";
import BluetoothRounded from "@mui/icons-material/BluetoothRounded";
import SyncRounded from "@mui/icons-material/SyncRounded";

const siteNames = { A: "秦俑工坊", B: "长安城门", C: "诗意庭院" };
type Tab = "explore" | "collection" | "route";
export default function OperatorPanel() {
  const [badges, setBadges] = useState<Badge[]>([]);
  const [visits, setVisits] = useState<Visit[]>([]);
  const [badgeId, setBadgeId] = useState("");
  const [tab, setTab] = useState<Tab>("explore");
  const [online, setOnline] = useState(false);
  const [busy, setBusy] = useState(false);
  const [connected, setConnected] = useState(false);
  const [progress, setProgress] = useState<DeviceState>();
  const [notice, setNotice] = useState("");
  const [unsupported, setUnsupported] = useState<string>();
  const control = useRef<BadgeControl | undefined>(undefined);
  const generation = useRef(0);
  const locked = useRef(false);
  const badge = badges.find(item => item.badge_id === badgeId);
  const latestVisit = visits.filter(item => item.badge_id === badgeId && item.source !== "generated_simulation")
    .sort((a, b) => Date.parse(b.captured_at) - Date.parse(a.captured_at))[0];
  function disconnect() {
    generation.current += 1; control.current?.close(); control.current = undefined;
    setConnected(false); setProgress(undefined);
  }
  const refresh = useCallback(async () => {
    const [registered, arrived] = await Promise.all([api.badges(), api.visits()]);
    setBadges(registered); setVisits(arrived); setOnline(true);
  }, []);
  useEffect(() => {
    let active = true;
    setUnsupported(bluetoothSupport());
    const load = () => { void refresh().catch(() => { if (active) setOnline(false); }); };
    load(); const timer = setInterval(load, 5000);
    return () => { active = false; clearInterval(timer); generation.current += 1; control.current?.close(); };
  }, [refresh]);
  async function connect() {
    if (!badge) throw new Error("请先选择腰牌");
    disconnect(); const current = generation.current;
    const link = await connectBadge(() => {
      if (current === generation.current) { disconnect(); setNotice("连接已断开，请重新连接"); }
    });
    if (current !== generation.current) { link.close(); throw new Error("请重新选择腰牌"); }
    const session = new BadgeControl(badge, link, api); control.current = session;
    try {
      const state = await session.sync();
      if (current !== generation.current) throw new Error("连接已失效，请重试");
      setProgress(state); setConnected(true); setNotice("");
    } catch (error) { disconnect(); throw error; }
  }
  async function sync(unlock = false) {
    const session = control.current;
    if (!session || !connected) throw new Error("请先连接腰牌");
    const current = generation.current;
    try {
      const state = await (unlock && latestVisit ? session.unlock(latestVisit) : session.sync());
      if (current !== generation.current) throw new Error("连接已失效，请重试");
      setProgress(state); setNotice(unlock ? "游戏已解锁，在腰牌上开始吧" : "进度已同步");
    } catch (error) { disconnect(); throw error; }
  }
  async function operate(action: () => Promise<void>) {
    if (locked.current) return;
    locked.current = true; setBusy(true); setNotice("");
    try { await action(); } catch (error) { setNotice(error instanceof Error ? error.message : "操作未完成，请重试"); }
    finally { locked.current = false; setBusy(false); }
  }
  const steps = [{ name: "解锁", done: progress?.unlocked, Icon: LockOpenRounded }, { name: "通关", done: progress?.completed, Icon: SportsEsportsRounded },
    { name: "收藏", done: progress?.collected, Icon: CollectionsBookmarkRounded }, { name: "展示", done: progress?.exhibiting, Icon: ImageRounded }];
  return <main className="visitor-app">
    <header className="visitor-header"><h1>长安游迹</h1>
      <Image src="/xks/images/changan-gate-v3.webp" width={780} height={260} alt="云山间的长安城门" priority className="visitor-landscape" />
    </header>
    <section className="visitor-badge" aria-label="我的腰牌">
      <div className="visitor-card-heading"><h2>我的腰牌</h2><span className={connected ? "visitor-connected" : "visitor-muted"}>{connected ? "已连接" : "未连接"}</span></div>
      <div className="visitor-connection-row"><select aria-label="选择腰牌编号" value={badgeId} disabled={busy || !online}
        onChange={event => { if (!locked.current) { disconnect(); setBadgeId(event.target.value); setNotice(""); } }}>
        <option value="">选择编号</option>
        {badges.filter(item => /^esp32s3-[0-9a-f]{12}$/.test(item.device_id)).map(item => <option key={item.badge_id} value={item.badge_id}>{item.display_number} 号</option>)}
      </select><button className="visitor-primary" disabled={busy || !badge || !online || !!unsupported}
        onClick={() => void operate(connected ? () => sync() : connect)}>{connected ? <SyncRounded fontSize="small" /> : <BluetoothRounded fontSize="small" />}{busy ? "处理中…" : connected ? "同步进度" : "连接腰牌"}</button></div>
      <ol className="visitor-steps">{steps.map(step => <li key={step.name}>
        <span className={`visitor-step-icon ${step.done ? "is-complete" : ""}`} role="img" aria-label={`${step.name}${step.done ? "已完成" : "未确认"}`}><step.Icon />{step.done && <CheckCircleRounded className="visitor-step-check" />}</span><span>{step.name}</span>
      </li>)}</ol>
      {connected && !progress?.unlocked && latestVisit?.site_id === "A" && <button className="visitor-primary visitor-unlock" disabled={busy || !online}
        onClick={() => void operate(() => sync(true))}>解锁秦俑归阵{latestVisit.source === "interface_test" ? "（演示）" : ""}</button>}
      {(notice || unsupported || !online) && <p className="visitor-notice" role="status">{unsupported || notice || "网络暂不可用"}</p>}
    </section>
    {tab === "explore" && <div className="visitor-feature-grid">
      <button className="visitor-feature visitor-collection" onClick={() => setTab("collection")}><h2>我的收藏</h2>
        <Image src="/xks/images/qin-guardian-v3.webp" width={240} height={240} alt="秦俑守护收藏" />
        <span>{progress?.collected ? "秦俑守护" : progress ? "通关后获得" : "连接后查看"}</span></button>
      <VisitorRecommendation key={latestVisit?.event_id ?? badgeId} visit={latestVisit} disabled={!online || busy || !badge} />
    </div>}
    {tab === "collection" && <section className="visitor-subpage"><h2>我的收藏</h2>
      <Image src="/xks/images/qin-guardian-v3.webp" width={240} height={240} alt="秦俑守护" />
      <h3>{progress?.collected ? "秦俑守护" : progress ? "完成秦俑归阵即可收藏" : "连接腰牌，查看你的收藏"}</h3>
      {progress?.collected && <p>{progress.exhibiting ? "正在腰牌上展示" : "可在腰牌上设为展示"}</p>}
    </section>}
    {tab === "route" && <section className="visitor-route"><h2>探索路线</h2>
      <Image src="/xks/images/changan-gate-v3.webp" width={780} height={260} alt="长安文化探索" />
      <ol>{(["A", "B", "C"] as const).map(site => <li key={site}><span>{siteNames[site]}</span><small>{visits.some(item => item.badge_id === badgeId && item.site_id === site && item.source === "physical_scan_simulated_site") ? "已打卡" : "待探索"}</small></li>)}</ol><p>路线示意</p>
    </section>}
    <nav className="visitor-nav" aria-label="页面导航">{([{value: "explore", name: "探索", Icon: ExploreRounded}, {value: "collection", name: "收藏", Icon: CollectionsBookmarkRounded}, {value: "route", name: "路线", Icon: RouteRounded}] as const)
      .map(({value, name, Icon}) => <button key={value} aria-current={tab === value ? "page" : undefined} onClick={() => setTab(value)}><Icon fontSize="small" />{name}</button>)}</nav>
  </main>;
}
