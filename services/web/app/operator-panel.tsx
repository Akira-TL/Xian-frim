"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import Image from "next/image";
import { api } from "../lib/api";
import type { BadgeRuntime } from "../lib/contracts";
import type { BadgeLink } from "../lib/badge-control";
import { readDemoSnapshot } from "../lib/demo-badge";
import { bluetoothSupport, connectBadge } from "../lib/web-bluetooth";
import VisitorRouteGuide from "./visitor-route-guide";
import ActivityOverview from "./activity-overview";
import BarChartRounded from "@mui/icons-material/BarChartRounded";
import ExploreRounded from "@mui/icons-material/ExploreRounded";
import CollectionsBookmarkRounded from "@mui/icons-material/CollectionsBookmarkRounded";
import RouteRounded from "@mui/icons-material/RouteRounded";
import SportsEsportsRounded from "@mui/icons-material/SportsEsportsRounded";
import ImageRounded from "@mui/icons-material/ImageRounded";
import CheckCircleRounded from "@mui/icons-material/CheckCircleRounded";
import BluetoothRounded from "@mui/icons-material/BluetoothRounded";
import SyncRounded from "@mui/icons-material/SyncRounded";
import ArrowForwardRounded from "@mui/icons-material/ArrowForwardRounded";
import ChevronRightRounded from "@mui/icons-material/ChevronRightRounded";
import BookmarkBorderRounded from "@mui/icons-material/BookmarkBorderRounded";
import LockOutlined from "@mui/icons-material/LockOutlined";

type Tab = "explore" | "collection" | "route" | "activity";
const screenNames = {cover: "入口封面", selection: "选择游戏", intro: "准备开始", playing: "正在游玩",
  result: "通关成功", collection: "查看收藏", exhibit: "展示收藏", settings: "调整设置"};
const games = {
  qin_formation: {name: "秦俑归阵", reward: "秦俑守护", image: "/xks/images/qin-guardian-v3.webp", total: 3},
  gate_search: {name: "城门寻宝", reward: "长安城门", image: "/xks/images/gate-game-v1.webp", total: 3},
  poem_completion: {name: "诗句补全", reward: "诗意长安", image: "/xks/images/poem-game-v1.webp", total: 2},
};
export default function OperatorPanel() {
  const [tab, setTab] = useState<Tab>("explore");
  const [connectionOpen, setConnectionOpen] = useState(false);
  const [featured, setFeatured] = useState<keyof typeof games>("qin_formation");
  const [online, setOnline] = useState(false);
  const [busy, setBusy] = useState(false);
  const [connected, setConnected] = useState(false);
  const [progress, setProgress] = useState<BadgeRuntime>();
  const [runtime, setRuntime] = useState<BadgeRuntime>();
  const [notice, setNotice] = useState("");
  const [unsupported, setUnsupported] = useState<string>();
  const control = useRef<BadgeLink | undefined>(undefined);
  const generation = useRef(0);
  const locked = useRef(false);
  function disconnect() {
    generation.current += 1; control.current?.close(); control.current = undefined;
    setConnected(false); setProgress(undefined); setRuntime(undefined);
  }
  const refresh = useCallback(async () => {
    await api.sites(); setOnline(true);
  }, []);
  useEffect(() => {
    let active = true;
    setUnsupported(bluetoothSupport());
    const load = () => { void refresh().catch(() => { if (active) setOnline(false); }); };
    load(); const timer = setInterval(load, 5000);
    return () => { active = false; clearInterval(timer); generation.current += 1; control.current?.close(); };
  }, [refresh]);
  useEffect(() => {
    if (!connected) return;
    const current = generation.current;
    let stopped = false;
    const poll = async () => {
      const session = control.current;
      if (stopped || document.hidden || locked.current || !session) return;
      locked.current = true;
      try {
        const live = await readDemoSnapshot(session);
        if (stopped || current !== generation.current) return;
        setRuntime(live);
        setProgress(live);
      } catch {
        if (!stopped && current === generation.current) {
          generation.current += 1; session.close(); control.current = undefined;
          setConnected(false); setProgress(undefined); setRuntime(undefined);
          setNotice("连接已断开，请重新连接");
        }
      } finally { locked.current = false; }
    };
    void poll();
    const timer = setInterval(() => { void poll(); }, 2000);
    return () => { stopped = true; clearInterval(timer); };
  }, [connected]);
  async function connect() {
    disconnect(); const current = generation.current;
    const link = await connectBadge(() => {
      if (current === generation.current) { disconnect(); setNotice("连接已断开，请重新连接"); }
    }, {snapshotOnly:true});
    if (current !== generation.current) { link.close(); throw new Error("连接已失效，请重试"); }
    control.current = link;
    try {
      const state = await readDemoSnapshot(link);
      if (current !== generation.current) throw new Error("连接已失效，请重试");
      setProgress(state); setRuntime(state); setConnected(true); setNotice("");
    } catch (error) { disconnect(); throw error; }
  }
  async function sync() {
    const session = control.current;
    if (!session || !connected) throw new Error("请先连接腰牌");
    const current = generation.current;
    try {
      const state = await readDemoSnapshot(session);
      if (current !== generation.current) throw new Error("连接已失效，请重试");
      setProgress(state); setRuntime(state); setNotice("进度已同步");
    } catch (error) { disconnect(); throw error; }
  }
  async function operate(action: () => Promise<void>) {
    if (locked.current) return;
    locked.current = true; setBusy(true); setNotice("");
    try { await action(); } catch (error) { setNotice(error instanceof Error ? error.message : "操作未完成，请重试"); }
    finally { locked.current = false; setBusy(false); }
  }
  const activeGame = games[runtime?.game_id ?? "qin_formation"];
  const liveStage = runtime?.v === 2 && runtime.game_id !== "qin_formation" ? runtime.stage :
    [0, 1, 2].filter(bit => ((runtime?.placed_mask ?? 0) & (1 << bit)) !== 0).length;
  const rewards = [
    {id: "qin_formation" as const, collected: !!progress?.collected, index: 0},
    {id: "gate_search" as const, collected: runtime?.v === 2 && (runtime.bonus_collected & 1) !== 0, index: 1},
    {id: "poem_completion" as const, collected: runtime?.v === 2 && (runtime.bonus_collected & 2) !== 0, index: 2},
  ];
  const rewardCount = rewards.filter(item => item.collected).length;
  const featuredReward = rewards.find(item => item.id === featured)!;
  const rewardImage = (id: keyof typeof games) => `/xks/images/display-v1/${id === "qin_formation" ? "qin" : id === "gate_search" ? "gate" : "poem"}-card.webp`;
  const rewardStatus = (item: typeof rewards[number]) => !connected ? "连接后查看" : !item.collected ? "通关后获得" :
    (runtime?.v === 2 ? runtime.exhibit_game === item.index : item.index === 0 && progress?.exhibiting) ? "腰牌展示中" : "已收藏";
  function openConnection() { setTab("explore"); setConnectionOpen(true); }
  const shownReward = runtime?.v === 2 && runtime.exhibit_game < 3 ? rewards[runtime.exhibit_game] : undefined;
  const localGame = runtime?.v === 2 && runtime.game_id !== "qin_formation" ?
    rewards[runtime.game_id === "gate_search" ? 1 : 2] : undefined;
  const steps = localGame ? [
    {name: "游玩", done: liveStage > 0 || localGame.collected || runtime?.screen === "playing", Icon: SportsEsportsRounded},
    {name: "收藏", done: localGame.collected, Icon: CollectionsBookmarkRounded},
    {name: "展示", done: runtime?.v === 2 && runtime.exhibit_game === localGame.index, Icon: ImageRounded},
  ] : [{ name: "通关", done: progress?.completed, Icon: SportsEsportsRounded },
    { name: "收藏", done: progress?.collected, Icon: CollectionsBookmarkRounded }, { name: "展示", done: runtime?.v === 2 ? runtime.exhibit_game === 0 : progress?.exhibiting, Icon: ImageRounded }];
  return <main className={`visitor-app display-app is-${tab}${runtime?.screen ? " has-runtime" : ""}`}>
    {tab === "explore" && <><header className="display-explore-hero">
      <Image src="/xks/images/display-v1/explore-hero.webp" width={1080} height={1200} alt="云山与长安城门文化主题插画" priority className="display-hero-art" />
      <div className="display-brand"><strong>长安游迹</strong><span>CHANG’AN JOURNEY</span></div>
      <button className="display-bookmark" aria-label="打开我的收藏" onClick={() => setTab("collection")}><BookmarkBorderRounded /></button>
      <div className="display-hero-copy"><p>一枚腰牌，一城故事</p><h1>把长安<br />带在身边</h1></div>
      <button className="display-start" onClick={() => setTab("route")}>开始探索<ArrowForwardRounded /></button>
    </header>
    <section className={`visitor-badge display-connection${connectionOpen ? " is-open" : ""}`} aria-label="我的腰牌">
      <div className="display-connection-strip"><BluetoothRounded className="display-bluetooth" />
        <div><h2>我的腰牌</h2><p>{connected ? "已连接 · 实时同步" : "连接后同步收藏"}</p></div>
        <button className="visitor-primary" aria-expanded={connectionOpen} aria-controls="badge-connection-details"
          disabled={busy || !!unsupported} onClick={() => {if (connected) setConnectionOpen(value => !value); else {setConnectionOpen(true); void operate(connect);}}}>{connected ? "查看进度" : "连接腰牌"}</button>
      </div>
      <div id="badge-connection-details" hidden={!connectionOpen}>
      <div className="visitor-connection-row"><button className="visitor-primary" disabled={busy || !!unsupported}
        onClick={() => void operate(connected ? () => sync() : connect)}>{connected ? <SyncRounded fontSize="small" /> : <BluetoothRounded fontSize="small" />}{busy ? "处理中…" : connected ? "同步进度" : "连接腰牌"}</button></div>
      <ol className="visitor-steps" style={{gridTemplateColumns: `repeat(${steps.length}, 1fr)`}} aria-label={`${activeGame.name}进度`}>{steps.map(step => <li key={step.name}>
        <span className={`visitor-step-icon ${step.done ? "is-complete" : ""}`} role="img" aria-label={`${step.name}${step.done ? "已完成" : "未确认"}`}><step.Icon />{step.done && <CheckCircleRounded className="visitor-step-check" />}</span><span>{step.name}</span>
      </li>)}</ol>
      {runtime?.screen && <div className="visitor-runtime" aria-live="polite">
        <Image src={runtime.screen === "cover" ? "/xks/images/journey-cover-v1.webp" : activeGame.image}
          width={48} height={48} alt="" />
        <div><strong>{runtime.screen === "cover" ? "长安游迹" : activeGame.name}</strong>
          <span>{screenNames[runtime.screen]}{runtime.screen === "playing" ? ` · ${liveStage}/${activeGame.total}` : ""}</span></div>
        <span className="visitor-live-label">实时</span>
      </div>}
      {(notice || unsupported) && <p className="visitor-notice" role="status">{unsupported || notice}</p>}
      </div>
    </section></>}
    {tab === "explore" && <section className="display-discover"><h2>带走一份长安</h2><p>在游戏里，遇见千年故事</p><div className="visitor-feature-grid">
      <button className="visitor-feature visitor-collection" onClick={() => setTab("collection")}>
        <Image src={rewardImage(shownReward?.id ?? "qin_formation")} width={480} height={640} alt="秦俑珍藏主题插画" />
        <div><h2>我的收藏</h2><span>{rewardCount ? `已收藏 ${rewardCount} / 3` : "通关收集"}</span><ArrowForwardRounded /></div></button>
      <button className="visitor-feature visitor-next" onClick={() => setTab("route")}>
        <Image src="/xks/images/display-v1/gate-card.webp" width={480} height={640} alt="长安城门主题插画" />
        <div><h2>下一站</h2><span>跟随你的兴趣出发</span><ArrowForwardRounded /></div>
      </button>
    </div></section>}
    {tab === "explore" && <button type="button" className="visitor-activity-entry" onClick={() => setTab("activity")}>
      <BarChartRounded fontSize="small" />活动概览<ChevronRightRounded />
    </button>}
    {tab === "activity" && <ActivityOverview />}
    {tab === "collection" && <section className="display-collection-page" aria-label="我的收藏">
      <header className="display-collection-heading"><Image src="/xks/images/display-v1/collection-heading.webp" width={960} height={360} alt="" priority />
        <span>长安游迹</span><h1>我的长安藏册</h1><p>把旅途里的故事，珍藏起来</p></header>
      <article className="display-collection-hero">
        <Image key={featured} src={featured === "qin_formation" ? "/xks/images/display-v1/collection-hero.webp" : rewardImage(featured)}
          width={1080} height={784} alt={`${games[featured].reward}文化主题珍藏插画`} priority />
        <div><h2>{games[featured].reward}</h2><p>{featuredReward.collected ? <CheckCircleRounded /> : <LockOutlined />}{rewardStatus(featuredReward)}</p></div>
      </article>
      <div className="display-collection-section-heading"><h2>三段旅程 · 三份珍藏</h2></div>
      <div className="visitor-rewards">{rewards.map(item => <button key={item.id} onClick={() => setFeatured(item.id)}
        aria-pressed={featured === item.id} aria-label={`查看${games[item.id].reward}`} className={item.collected ? "is-collected" : ""}>
        <Image src={rewardImage(item.id)} width={480} height={640} alt={games[item.id].reward} />
        <div><h3>{games[item.id].reward}</h3><p>{item.collected ? <CheckCircleRounded /> : <LockOutlined />}{rewardStatus(item)}</p></div>
      </button>)}</div>
      <div className="display-collection-connect"><BluetoothRounded /><div><strong>{connected ? "旅途的故事，正在珍藏" : "连接腰牌，点亮你的藏册"}</strong><p>{connected ? `已收藏 ${rewardCount} / 3` : "让每一段旅程，都有可珍藏的印记"}</p></div>
        <button className="display-start" onClick={openConnection}>{connected ? "查看进度" : "连接腰牌"}<ChevronRightRounded /></button></div>
    </section>}
    {tab === "route" && <VisitorRouteGuide disabled={!online} />}
    <nav className="visitor-nav" aria-label="页面导航">{([{value: "explore", name: "探索", Icon: ExploreRounded}, {value: "collection", name: "收藏", Icon: CollectionsBookmarkRounded}, {value: "route", name: "路线", Icon: RouteRounded}] as const)
      .map(({value, name, Icon}) => <button key={value} aria-current={tab === value ? "page" : undefined} onClick={() => setTab(value)}><Icon fontSize="small" />{name}</button>)}</nav>
  </main>;
}
