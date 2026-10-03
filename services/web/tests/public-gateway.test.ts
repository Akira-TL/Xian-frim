import assert from "node:assert/strict";
import { test } from "node:test";
import { createApi } from "../lib/api.ts";
import { scenarioSchema, recommendationSchema, type GuideRequest } from "../lib/contracts.ts";

const web = process.env.CHANGAN_TEST_WEB_ORIGIN;
assert.ok(web, "通过 scripts/web/test-gateway.sh 启动隔离服务后执行");

test("演示网页无需登录即可读取登记列表", async () => {
  const response = await fetch(`${web}/api/v1/badges`);
  assert.equal(response.status, 200);
  assert.equal(await response.text(), "[]");
  assert.equal(response.headers.get("cache-control"), "no-store");
});

test("免登录活动查询保留空数据与模拟来源边界", async () => {
  const physical = await fetch(`${web}/api/v1/activity`);
  assert.equal(physical.status, 200);
  const snapshot = await createApi(`${web}/api/v1`).activity("physical_scan_simulated_site");
  assert.ok(snapshot.progress);
  assert.equal(snapshot.progress.verified_badges, 0);
  assert.equal(snapshot.visits.total_visits, 0);
  assert.equal(snapshot.visits.participating_badges, 0);
  assert.equal(snapshot.visits.average_scan_interval_seconds, null);
  assert.deepEqual(snapshot.map.sites.map(site => site.data_status),
    ["missing", "missing", "missing"]);
  const generated = await fetch(`${web}/api/v1/activity?source=generated_simulation`);
  assert.equal(generated.status, 200);
  assert.equal((await createApi(`${web}/api/v1`).activity("generated_simulation")).progress, null);
  assert.equal(physical.headers.get("cache-control"), "no-store");
});

test("所有演示参与者均可推演，但推演不制造到访事实", async () => {
  const response = await fetch(`${web}/api/v1/simulation`, {
    method: "POST", headers: { "Content-Type": "application/json", Origin: new URL(web).origin },
    body: JSON.stringify({ nodes: [
      { site_id: "A", initial_people: 100, arrivals_per_minute: 10, stay_minutes: 10 },
      { site_id: "B", initial_people: 0, arrivals_per_minute: 0, stay_minutes: 10 },
      { site_id: "C", initial_people: 0, arrivals_per_minute: 0, stay_minutes: 10 },
    ], from_site: "A", to_site: "B", adoption_ratio: 1, duration_minutes: 2 }),
  });
  assert.equal(response.status, 200);
  const result = scenarioSchema.parse(await response.json() as unknown);
  assert.deepEqual(result.series[2].guided.map(node => node.people), [81, 19, 0]);
  assert.equal(await (await fetch(`${web}/api/v1/visits`)).text(), "[]");
});

test("演示参与者能登记腰牌，但不能冒充终端制造实物到访", async () => {
  const registration = { badge_id: "badge-001", display_number: "001", device_id: "esp32s3-001122334455" };
  const registered = await fetch(`${web}/api/v1/badges`, {
    method: "POST", headers: { "Content-Type": "application/json", Origin: new URL(web).origin }, body: JSON.stringify(registration),
  });
  assert.equal(registered.status, 200);
  assert.equal(await registered.text(), JSON.stringify(registration));
  const physical = await fetch(`${web}/api/v1/visits`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: "{}",
  });
  assert.equal(physical.status, 404);
  assert.equal((await fetch(`${web}/api/v1/terminal/configuration`)).status, 404);
});

test("公开查询不产生游戏进度，缺少密钥时也不伪造同步成功", async () => {
  assert.equal(await (await fetch(`${web}/api/v1/visits`)).text(), "[]");
  assert.equal(await (await fetch(`${web}/api/v1/unlock-commands`)).text(), "[]");
  assert.equal((await fetch(`${web}/api/v1/badges/badge-001/progress`)).status, 404);
  const challenge = await fetch(`${web}/api/v1/badges/badge-001/state-challenges`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: "{}",
  });
  assert.equal(challenge.status, 503);
  const forged = await fetch(`${web}/api/v1/device-reports`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ unlocked: true, collected: true }),
  });
  assert.equal(forged.status, 422);
});

test("跨站写入和超大请求被拒绝，不泄露内部通信令牌", async () => {
  const foreign = await fetch(`${web}/api/v1/badges`, {
    method: "POST", headers: { "Content-Type": "application/json", Origin: "https://foreign.invalid" }, body: "{}",
  });
  assert.equal(foreign.status, 403);
  const oversized = await fetch(`${web}/api/v1/badges`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: "x".repeat(16_385),
  });
  assert.equal(oversized.status, 413);
  const registry = await fetch(`${web}/api/v1/badges`);
  assert.equal(registry.headers.get("authorization"), null);
  assert.ok(!(await registry.text()).includes("gateway-test-operator"));
});

test("免登录节点配置仍明确未实现小游戏与示意地图", async () => {
  const response = await fetch(`${web}/api/v1/sites`);
  assert.equal(response.status, 200);
  const text = await response.text();
  assert.ok(text.includes("长安城门") && text.includes("诗意庭院"));
  assert.ok(text.includes('"geographic_map":false'));
  const catalog = await createApi(`${web}/api/v1`).sites();
  assert.deepEqual(catalog.sites.map(site => site.game_available), [true, true, true]);
});

test("免登录推荐及历史查询不冒充实时模型或制造实物进度", async () => {
  const registered = await fetch(`${web}/api/v1/badges`, {
    method: "POST", headers: { "Content-Type": "application/json", Origin: new URL(web).origin },
    body: JSON.stringify({ badge_id: "recommend-test", display_number: "R01", device_id: "esp32s3-010203040506" }),
  });
  assert.equal(registered.status, 200);
  const visit = await fetch(`${web}/api/v1/demo/visits`, {
    method: "POST", headers: { "Content-Type": "application/json", Origin: new URL(web).origin },
    body: JSON.stringify({ event_id: "recommend-A", session_id: "demo-001", badge_id: "recommend-test",
      terminal_id: "k230-001", site_id: "A", config_version: 1,
      captured_at: new Date().toISOString(), time_quality: "synced" }),
  });
  assert.equal(visit.status, 200);
  const recommended = await fetch(`${web}/api/v1/recommendations`, {
    method: "POST", headers: { "Content-Type": "application/json", Origin: new URL(web).origin },
    body: JSON.stringify({ badge_id: "recommend-test", event_id: "recommend-A" }),
  });
  assert.equal(recommended.status, 200);
  const result = recommendationSchema.parse(await recommended.json() as unknown);
  assert.equal(result.source, "none");
  assert.equal(result.selected_site, null);
  assert.equal(result.input.data_source, "generated_simulation");
  const history = await createApi(`${web}/api/v1`).recommendationRecord(result.snapshot_id);
  assert.equal(history.delivery, "historical");
  assert.deepEqual(history.result, result);
  assert.equal((await fetch(`${web}/api/v1/recommendations/${result.snapshot_id}/audit`)).status, 404);
  assert.equal((await fetch(`${web}/api/v1/recommendation-rejections`)).status, 404);
  assert.equal((await fetch(`${web}/api/v1/badges/recommend-test/progress`)).status, 404);
  const foreign = await fetch(`${web}/api/v1/recommendations`, {
    method: "POST", headers: { "Content-Type": "application/json", Origin: "https://foreign.invalid" }, body: "{}",
  });
  assert.equal(foreign.status, 403);
});

test("无需腰牌或到访也能按游客偏好和演示热度获取指引，不改写到访", async () => {
  const api = createApi(`${web}/api/v1`);
  const before = await api.visits();
  const input: GuideRequest = {start_site: "A", visitor_profile: {party: "friends", interest: "photography", pace: "normal"},
    data_source: "generated_simulation", crowd_scenario: "balanced"};
  const first = await api.guide(input);
  assert.equal(first.selected_site, "B");
  assert.equal(first.input.visitor_profile?.interest, "photography");
  input.crowd_scenario = "gate_busy";
  assert.equal((await api.guide(input)).selected_site, "C");
  assert.deepEqual(await api.visits(), before);
  assert.equal((await api.recommendationRecord(first.snapshot_id)).result.selected_site, "B");
  const foreign = await fetch(`${web}/api/v1/guide-recommendations`, {method: "POST",
    headers: {"Content-Type": "application/json", Origin: "https://foreign.invalid"}, body: JSON.stringify(input)});
  assert.equal(foreign.status, 403);
});
