"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "../lib/api";
import { badgeSchema, type Badge, type Command, type Visit } from "../lib/contracts";

const siteNames = { A: "秦俑工坊", B: "丝路驿站", C: "碑林书院" };
const commandNames = { pending: "待发送", sent: "已发送，执行未确认", confirmed: "设备已确认执行", unknown: "结果未确认", failed: "请求失败" };
const buttonStyle = "rounded-xl bg-stone-800 px-4 py-3 text-white disabled:opacity-40";
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
  const [registration, setRegistration] = useState<Badge>({ badge_id: "badge-001", display_number: "001", device_id: "" });
  const selected = visits.find(visit => visit.event_id === selection);
  const selectedBadge = badges.find(badge => badge.badge_id === selected?.badge_id);
  const selectedCommand = commands.find(command => command.event_id === selection);

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
    void refresh().then(() => { if (active) setNotice("演示免登录；请选择一条到访记录"); })
      .catch(() => { if (active) { setOnline(false); setNotice("后台暂不可达，当前没有在线记录"); } });
    return () => { active = false; };
  }, [refresh]);

  return <main className="mx-auto max-w-5xl px-4 py-8 sm:px-8">
    <header className="mb-6 flex flex-wrap items-start justify-between gap-4">
      <div><p className="text-sm tracking-widest text-stone-600">实物腰牌 · 文化探索</p>
        <h1 className="mt-2 text-3xl font-semibold">长安游迹</h1><p className="mt-2 text-stone-600">工作人员演示 · 无需登录</p></div>
      <button className={buttonStyle} disabled={busy} onClick={() => void operate(async () => { await refresh(); setNotice("记录已刷新"); })}>刷新记录</button>
    </header>
    <section className="mb-6 rounded-2xl border border-stone-200 bg-white p-5" aria-label="链路状态">
      <p>后台：{online ? "最近查询成功" : "未连接／记录可能过时"}　设备：未连接　执行：未核验</p>
      <p className="mt-3 text-sm leading-6 text-stone-600" role="status">{notice}</p>
    </section>
    <div className="grid gap-5 md:grid-cols-2">
      <section className="rounded-2xl bg-white p-5"><h2 className="text-xl font-semibold">到访记录</h2>
        <p className="my-3 text-sm text-stone-600">实物扫码与模拟记录分别标注；只有 A 点实物到访可以解锁。</p>
        {!visits.length && <p className="py-8 text-stone-500">暂无到访。等待景区终端按接口上报。</p>}
        <ul className="space-y-3">{visits.map(visit => {
          const badge = badges.find(item => item.badge_id === visit.badge_id);
          const command = commands.find(item => item.event_id === visit.event_id);
          return <li key={visit.event_id}><button disabled={busy} aria-pressed={selection === visit.event_id}
            onClick={() => { if (!locked.current) setSelection(visit.event_id); }}
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
          <p className="text-sm text-stone-600">蓝牙连接、授权与认证回执正在接入，当前页面不发送设备指令。</p>
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
