"use client";

import { useRef, useState, type FormEvent } from "react";
import { api } from "../../lib/api";
import { scenarioRequestSchema, type ScenarioRequest, type ScenarioResult } from "../../lib/contracts";

const defaults: ScenarioRequest = {
  nodes: [
    { site_id: "A", initial_people: 100, arrivals_per_minute: 10, stay_minutes: 10 },
    { site_id: "B", initial_people: 20, arrivals_per_minute: 4, stay_minutes: 8 },
    { site_id: "C", initial_people: 10, arrivals_per_minute: 2, stay_minutes: 12 },
  ], from_site: "A", to_site: "B", adoption_ratio: 0.5, duration_minutes: 30,
};
type Site = ScenarioRequest["from_site"];
type NodeField = "initial_people" | "arrivals_per_minute" | "stay_minutes";
const inputStyle = "mt-1 w-full rounded-lg border border-stone-300 bg-white p-2";

function Curve({ result, site }: { result: ScenarioResult; site: Site }) {
  const points = result.series.map(point => ({ minute: point.minute,
    baseline: point.baseline.find(node => node.site_id === site)!.people,
    guided: point.guided.find(node => node.site_id === site)!.people }));
  const max = Math.max(1, ...points.flatMap(point => [point.baseline, point.guided]));
  const path = (kind: "baseline" | "guided") => points.map((point, index) =>
    `${index === 0 ? "M" : "L"}${44 + 364 * point.minute / result.parameters.duration_minutes},${164 - 144 * point[kind] / max}`).join(" ");
  const last = points[points.length - 1];
  return <article className="rounded-xl border border-stone-200 p-3">
    <h3 className="font-semibold">节点 {site} · 情景推演</h3>
    <svg className="mt-2 w-full" viewBox="0 0 420 200" role="img" aria-label={`节点 ${site} 假设人数推演；两条曲线均非真实观测`}>
      <path d="M44 20V164H408" fill="none" stroke="#78716c" />
      {[0, 0.5, 1].map(fraction => <g key={fraction}>
        <path d={`M44 ${164 - fraction * 144}H408`} stroke="#e7e5e4" />
        <text x="40" y={168 - fraction * 144} textAnchor="end" fontSize="11">{(fraction * max).toFixed(1)}</text>
      </g>)}
      <path d={path("baseline")} fill="none" stroke="#78716c" strokeWidth="2" strokeDasharray="8 4" />
      <path d={path("guided")} fill="none" stroke="#0f766e" strokeWidth="2" strokeDasharray="3 4" />
      <text x="44" y="185" fontSize="11">0 分钟</text>
      <text x="408" y="185" textAnchor="end" fontSize="11">{result.parameters.duration_minutes} 分钟</text>
      <text x="48" y="13" fontSize="11">假设估计人数（人）</text>
    </svg>
    <p className="text-xs text-stone-600">灰色长虚线：未分流；绿色短虚线：采用分流。两者都是假设方案。</p>
    <p className="mt-2 text-sm">末分钟：未分流 {last.baseline.toFixed(1)} 人；采用分流 {last.guided.toFixed(1)} 人</p>
  </article>;
}

export default function ScenarioPanel() {
  const [parameters, setParameters] = useState<ScenarioRequest>(defaults);
  const [result, setResult] = useState<ScenarioResult>();
  const [notice, setNotice] = useState("默认参数仅供演示；修改后点击重新推演");
  const [busy, setBusy] = useState(false);
  const locked = useRef(false);
  function updateNode(site: Site, field: NodeField, value: number) {
    setParameters(prior => ({ ...prior, nodes: prior.nodes.map(node => node.site_id === site ? { ...node, [field]: value } : node) }));
  }
  async function run(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (locked.current) return;
    const parsed = scenarioRequestSchema.safeParse(parameters);
    if (!parsed.success) { setNotice("请检查参数范围，并选择两个不同的分流节点"); return; }
    locked.current = true; setBusy(true); setNotice("正在计算；现有曲线仍是上次参数的结果");
    try {
      const value = await api.simulate(parsed.data);
      setResult(value); setNotice("推演完成；不表示已经产生分流效果，不影响真实进度");
    } catch (error) {
      setResult(undefined);
      setNotice(error instanceof TypeError || error instanceof DOMException ? "网络连接失败或计算超时，未取得推演结果"
        : error instanceof Error ? error.message : "推演失败");
    } finally { locked.current = false; setBusy(false); }
  }
  return <section className="rounded-2xl border border-stone-200 bg-white p-5">
    <h2 className="text-xl font-semibold">人流变化情景推演</h2>
    <p className="mt-2 text-sm text-stone-600">以下人数、到达率与停留时间均为假设，不取自扫码观测。步长一分钟，离开量＝上一步人数÷停留分钟数。只分流新增到达，不瞬间移动已有人员；不用于现场安全决策。</p>
    <form onSubmit={event => { void run(event); }} className="mt-4 space-y-4">
      <fieldset disabled={busy} className="grid gap-4 md:grid-cols-3"><legend className="mb-2 text-sm">各节点假设参数</legend>
        {parameters.nodes.map(node => <div key={node.site_id} className="space-y-2 rounded-xl bg-stone-50 p-3">
          <h3 className="font-semibold">节点 {node.site_id}</h3>
          {([
            ["initial_people", "假设初始人数（人）", 0, 10000],
            ["arrivals_per_minute", "假设到达率（人/分钟）", 0, 1000],
            ["stay_minutes", "假设停留时间（分钟）", 1, 240],
          ] as const).map(([field, label, min, max]) => <label className="block text-sm" key={field}>
            {label}<input className={inputStyle} type="number" required min={min} max={max} step="any"
              name={`${node.site_id}-${field}`} value={node[field]} onChange={event => updateNode(node.site_id, field, Number(event.target.value))} />
          </label>)}
        </div>)}
      </fieldset>
      <fieldset disabled={busy} className="grid gap-3 sm:grid-cols-4"><legend className="mb-2 text-sm">分流与时长</legend>
        {(["from_site", "to_site"] as const).map(field => <label className="text-sm" key={field}>{field === "from_site" ? "原目标" : "新目标"}
          <select className={inputStyle} name={field} value={parameters[field]} onChange={event => {
            const selected = event.target.value as Site; setParameters(prior => ({ ...prior, [field]: selected }));
          }}>{parameters.nodes.map(node => <option key={node.site_id} value={node.site_id}>{node.site_id}</option>)}</select>
        </label>)}
        <label className="text-sm">采纳分流比例（0—1）<input className={inputStyle} type="number" name="adoption_ratio" required min="0" max="1" step="0.01"
          value={parameters.adoption_ratio} onChange={event => setParameters(prior => ({ ...prior, adoption_ratio: Number(event.target.value) }))} /></label>
        <label className="text-sm">推演时长（分钟）<input className={inputStyle} type="number" name="duration_minutes" required min="1" max="120" step="1"
          value={parameters.duration_minutes} onChange={event => setParameters(prior => ({ ...prior, duration_minutes: Number(event.target.value) }))} /></label>
      </fieldset>
      <button disabled={busy} className="rounded-lg bg-stone-800 px-4 py-2 text-white" type="submit">{busy ? "正在计算" : "重新推演"}</button>
    </form>
    <p role="status" aria-live="polite" className="mt-3 text-sm">{notice}</p>
    {result && <div className="mt-5 space-y-4">
      <div className="rounded-xl bg-amber-50 p-3 text-sm">
        <p>情景推演 · {new Date(result.generated_at).toLocaleString("zh-CN", { hour12: false })} · {result.parameters.from_site} → {result.parameters.to_site} · 采纳比例 {result.parameters.adoption_ratio} · {result.parameters.duration_minutes} 分钟</p>
        <p>曲线使用的回传参数：{result.parameters.nodes.map(node => `${node.site_id} 初始${node.initial_people}人 / 到达${node.arrivals_per_minute}人每分钟 / 停留${node.stay_minutes}分钟`).join("；")}</p>
        <p>表单修改不会自动改写已有曲线；下方两组曲线均为假设，不是观测或已证实的拥堵改善。</p>
      </div>
      <div className="grid gap-4 lg:grid-cols-3">{result.parameters.nodes.map(node => <Curve result={result} site={node.site_id} key={node.site_id} />)}</div>
    </div>}
  </section>;
}
