"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "../lib/api";
import { badgeSchema, type Badge, type Command, type DeviceState, type Visit } from "../lib/contracts";
import { BadgeControl, type ControlPhase } from "../lib/badge-control";
import { bluetoothSupport, connectBadge } from "../lib/web-bluetooth";
import RecommendationPanel from "./recommendation-panel";

const siteNames = { A: "秦俑工坊", B: "长安城门", C: "诗意庭院" };
const commandNames = { pending: "待发送", sent: "已发送，执行未确认", confirmed: "设备已确认执行", unknown: "结果未确认", failed: "请求失败" };
const buttonStyle = "rounded-xl bg-stone-800 px-4 py-3 text-white disabled:opacity-40";
const phaseNames: Record<ControlPhase, string> = {
  checking: "核对实物身份", authorizing: "取得后台授权", sending: "向设备写入请求",
  sent: "已发送，尚未确认执行", verifying: "正在认证设备回执", confirmed: "设备进度已认证",
};
function time(value: string) { return new Date(value).toLocaleString("zh-CN", { hour12: false }); }

export default function OperatorPanel() {
  const [badges, setBadges] = useState<Badge[]>([]);
  const [visits, setVisits] = useState<Visit[]>([]);
  const [commands, setCommands] = useState<Command[]>([]);
  const [online, setOnline] = useState(false);
  const [notice, setNotice] = useState("正在读取后台记录");
  const [busy, setBusy] = useState(false);
  const locked = useRef(false);
  const [selection, setSelection] = useState<string>();
  const control = useRef<BadgeControl | undefined>(undefined);
  const generation = useRef(0);
  const [connection, setConnection] = useState<{ badgeId: string; deviceId: string }>();
  const [progress, setProgress] = useState<DeviceState>();
  const [phase, setPhase] = useState<ControlPhase>();
  const [unsupported, setUnsupported] = useState<string>();
  const [registration, setRegistration] = useState<Badge>({ badge_id: "badge-001", display_number: "001", device_id: "" });
  const selected = visits.find(visit => visit.event_id === selection);
  const selectedBadge = badges.find(badge => badge.badge_id === selected?.badge_id);
  const selectedCommand = commands.find(command => command.event_id === selection);

  function disconnect() {
    generation.current += 1; control.current?.close(); control.current = undefined;
    setConnection(undefined); setProgress(undefined); setPhase(undefined);
  }

  async function connect() {
    if (!selectedBadge) throw new Error("请先选择已登记腰牌的到访");
    const badge = selectedBadge;
    disconnect();
    const current = generation.current;
    const link = await connectBadge(() => {
      if (generation.current !== current) return;
      disconnect(); setNotice("蓝牙已断开，结果未确认；请重连并先同步进度");
    });
    if (generation.current !== current) { link.close(); throw new Error("目标已变化，请重新连接"); }
    const session = new BadgeControl(badge, link, api, { onPhase: value => {
      if (generation.current === current) setPhase(value);
    } });
    control.current = session;
    try {
      const state = await session.sync();
      if (generation.current !== current) throw new Error("连接已失效，请重新连接");
      setConnection({ badgeId: badge.badge_id, deviceId: state.device_id }); setProgress(state);
      setNotice("实物身份匹配，进度已认证同步；不会自动解锁游戏");
    } catch (error) { disconnect(); throw error; }
  }

  async function deviceOperation(unlock: boolean) {
    const session = control.current;
    if (!session || !selected || connection?.badgeId !== selected.badge_id) throw new Error("请先连接对应腰牌");
    const current = generation.current;
    try {
      const state = await (unlock ? session.unlock(selected) : session.sync());
      if (generation.current !== current) throw new Error("连接已失效，结果未确认");
      setProgress(state);
      setNotice(unlock ? "设备已确认解锁；请在腰牌上点击开始游戏" : "设备进度已通过认证并同步后台");
    } catch (error) { disconnect(); throw error; }
    // 列表刷新失败不能推翻已认证的设备回执，单独显示后台查询异常。
    try { await refresh(); }
    catch { setNotice("设备回执已认证，但列表刷新失败；请稍后刷新记录"); }
  }

  const refresh = useCallback(async () => {
    try {
      const [registered, arrived, requested] = await Promise.all([api.badges(), api.visits(), api.commands()]);
      setBadges(registered); setVisits(arrived); setCommands(requested); setOnline(true);
    } catch (error) { setOnline(false); throw error; }
  }, []);

  async function operate(action: () => Promise<void>) {
    if (locked.current) return;
    locked.current = true; setBusy(true);
    try { await action(); }
    catch (error) { setNotice(error instanceof Error ? error.message : "操作失败，结果未确认"); }
    finally { locked.current = false; setBusy(false); }
  }

  useEffect(() => {
    let active = true;
    setUnsupported(bluetoothSupport());
    void refresh().then(() => { if (active) setNotice("演示免登录；请选择一条到访记录"); })
      .catch(() => { if (active) { setOnline(false); setNotice("后台暂不可达，当前没有在线记录"); } });
    return () => { active = false; generation.current += 1; control.current?.close(); control.current = undefined; };
  }, [refresh]);

  return <main className="mx-auto max-w-5xl px-4 py-8 sm:px-8">
    <header className="mb-6 flex flex-wrap items-start justify-between gap-4">
      <div><p className="text-sm tracking-widest text-stone-600">实物腰牌 · 文化探索</p>
        <h1 className="mt-2 text-3xl font-semibold">长安游迹</h1><p className="mt-2 text-stone-600">工作人员演示 · 无需登录</p></div>
      <button className={buttonStyle} disabled={busy} onClick={() => void operate(async () => { await refresh(); setNotice("记录已刷新"); })}>刷新记录</button>
    </header>
    <section className="mb-6 rounded-2xl border border-stone-200 bg-white p-5" aria-label="链路状态">
      <p>后台：{online ? "最近查询成功" : "未连接／记录可能过时"}</p>
      <p className="mt-2 break-words">设备：{connection ? `已连接并匹配 ${connection.deviceId}` : "未连接／尚未匹配"}</p>
      <p className="mt-2">执行：{phase ? phaseNames[phase] : "未核验"}</p>
      <p className="mt-3 text-sm leading-6 text-stone-600" role="status">{notice}</p>
      {unsupported && <p className="mt-3 text-sm text-amber-800">{unsupported}</p>}
    </section>
    <div className="grid gap-5 md:grid-cols-2">
      <section className="rounded-2xl bg-white p-5"><h2 className="text-xl font-semibold">到访记录</h2>
        <p className="my-3 text-sm text-stone-600">实物扫码与模拟记录分别标注；只有 A 点实物到访可以解锁。</p>
        {!visits.length && <p className="py-8 text-stone-500">暂无到访。等待景区终端按接口上报。</p>}
        <ul className="space-y-3">{visits.map(visit => {
          const badge = badges.find(item => item.badge_id === visit.badge_id);
          const command = commands.find(item => item.event_id === visit.event_id);
          return <li key={visit.event_id}><button disabled={busy} aria-pressed={selection === visit.event_id}
            onClick={() => { if (!locked.current && selection !== visit.event_id) { disconnect(); setSelection(visit.event_id); } }}
            className={`w-full rounded-xl border p-4 text-left ${selection === visit.event_id ? "border-stone-800 bg-stone-100" : "border-stone-200"}`}>
            <span className="font-semibold">{badge?.display_number ?? visit.badge_id} 号 · {siteNames[visit.site_id]}</span>
            <span className="mt-2 block text-sm">{visit.source === "physical_scan_simulated_site" ? "实物扫码 · 模拟地点" : "生成模拟 · 不可控制实物"}</span>
            <span className="mt-1 block text-sm text-stone-600">{time(visit.captured_at)}{visit.time_quality === "untrusted" ? " · 时间未校准" : ""}</span>
            <span className="mt-1 block text-sm">{command ? commandNames[command.status] : "尚未创建解锁请求"}</span>
          </button></li>;
        })}</ul>
      </section>
      <section className="rounded-2xl bg-white p-5"><h2 className="text-xl font-semibold">单次到访</h2>
        {selected ? <div className="mt-4 space-y-3 break-words">
          <p>{selectedBadge?.display_number ?? selected.badge_id} 号 · {siteNames[selected.site_id]}</p>
          <p className="text-sm">登记身份：{selectedBadge?.device_id ?? "未找到登记"}</p>
          <p className="text-sm">事件：{selected.event_id}</p>
          <p>{selectedCommand ? commandNames[selectedCommand.status] : "待核对实物设备"}</p>
          {selectedCommand && <p className="text-sm">请求有效期至 {time(selectedCommand.expires_at)}；过期后先查询状态，未解锁则需新的实物到访。</p>}
          <div className="flex flex-wrap gap-3 pt-2">
            <button className={buttonStyle} disabled={busy || !!unsupported || !selectedBadge || !online}
              onClick={() => void operate(connect)}>连接并核对身份</button>
            <button className={buttonStyle} disabled={busy || !connection}
              onClick={() => void operate(() => deviceOperation(false))}>认证同步进度</button>
            <button className={buttonStyle} disabled={busy || !online || !control.current?.ready
              || connection?.badgeId !== selected.badge_id || selected.source !== "physical_scan_simulated_site"
              || selected.site_id !== "A" || !!progress?.unlocked
              || !!(selectedCommand && Date.parse(selectedCommand.expires_at) <= Date.now())}
              onClick={() => void operate(() => deviceOperation(true))}>解锁本点游戏</button>
            <button className="rounded-xl border border-stone-300 px-4 py-3" disabled={busy || !connection}
              onClick={() => { disconnect(); setNotice("已主动断开；下次连接会先查询设备状态"); }}>断开设备</button>
          </div>
          {selected.source !== "physical_scan_simulated_site" && <p className="text-sm text-amber-800">生成模拟只供查看，禁止控制实物腰牌。</p>}
          {selected.site_id !== "A" && <p className="text-sm text-stone-600">当前仅实现 A 点《秦俑归阵》。</p>}
          {progress && <div className="rounded-xl bg-stone-100 p-4 text-sm leading-7">
            <p>认证进度：{progress.unlocked ? "已解锁" : "未解锁"} · {progress.completed ? "已通关" : "未通关"}</p>
            <p>收藏：{progress.collected ? "已获得秦俑收藏" : "尚未获得"} · 展示：{progress.exhibiting ? "已设置" : "未设置"}</p>
            <p>最近认证时间：{time(progress.verified_at)}</p>
            <p>孩子离开手机通信范围后，已解锁游戏仍可在腰牌本地游玩。</p>
          </div>}
          <RecommendationPanel key={selected.event_id} visit={selected} disabled={busy || !online} />
        </div> : <p className="mt-8 text-stone-500">选择左侧一条记录以核对腰牌。</p>}
      </section>
    </div>
    <details className="mt-6 rounded-2xl bg-white p-5"><summary className="cursor-pointer font-semibold">登记演示腰牌</summary>
      <p className="my-4 text-sm leading-6 text-stone-600">登记绑定不可覆盖。请使用现场读取的出厂身份，不以广播名称替代。登记不产生到访或解锁。</p>
      <form className="grid gap-4 sm:grid-cols-3" onSubmit={event => { event.preventDefault(); void operate(async () => {
        const result = badgeSchema.safeParse(registration);
        if (!result.success || !/^esp32s3-[0-9a-f]{12}$/.test(registration.device_id)) throw new Error("请填写有效腰牌编号及 ESP32-S3 出厂身份");
        await api.register(result.data); await refresh(); setNotice("登记完成；仍需真实到访及现场身份核对");
      }); }}>
        <label className="text-sm">腰牌标识<input className="mt-2 w-full rounded-lg border p-3" value={registration.badge_id} disabled={busy}
          onChange={event => setRegistration({ ...registration, badge_id: event.target.value })} required /></label>
        <label className="text-sm">显示编号<input className="mt-2 w-full rounded-lg border p-3" value={registration.display_number} disabled={busy}
          onChange={event => setRegistration({ ...registration, display_number: event.target.value })} required /></label>
        <label className="text-sm">实物出厂身份<input className="mt-2 w-full rounded-lg border p-3" placeholder="esp32s3-十二位小写十六进制" value={registration.device_id} disabled={busy}
          onChange={event => setRegistration({ ...registration, device_id: event.target.value })} required /></label>
        <button className={buttonStyle} disabled={busy} type="submit">登记绑定</button>
      </form>
    </details>
    <footer className="mt-6 text-sm leading-6 text-stone-600">会话 demo-001 · 一次操作一枚腰牌。记录数不代表实时在场人数。手机蓝牙需要可信 HTTPS 与支持 Web Bluetooth 的安卓浏览器。</footer>
  </main>;
}
