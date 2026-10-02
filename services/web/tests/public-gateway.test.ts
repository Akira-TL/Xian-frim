import assert from "node:assert/strict";
import { test } from "node:test";

const web = process.env.CHANGAN_TEST_WEB_ORIGIN;
assert.ok(web, "通过 scripts/web/test-gateway.sh 启动隔离服务后执行");

test("演示网页无需登录即可读取登记列表", async () => {
  const response = await fetch(`${web}/api/v1/badges`);
  assert.equal(response.status, 200);
  assert.equal(await response.text(), "[]");
  assert.equal(response.headers.get("cache-control"), "no-store");
});

test("演示参与者能登记腰牌，但不能冒充终端制造实物到访", async () => {
  const registration = { badge_id: "badge-001", display_number: "001", device_id: "esp32s3-001122334455" };
  const registered = await fetch(`${web}/api/v1/badges`, {
    method: "POST", headers: { "Content-Type": "application/json", Origin: web }, body: JSON.stringify(registration),
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
