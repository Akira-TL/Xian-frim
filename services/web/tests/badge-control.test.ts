import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { test } from "node:test";
import { createApi } from "../lib/api.ts";
import { BadgeControl, type BadgeLink } from "../lib/badge-control.ts";
import { visitSchema, type Badge, type Visit } from "../lib/contracts.ts";

const web = process.env.CHANGAN_TEST_WEB_ORIGIN;
const backend = process.env.CHANGAN_BACKEND_ORIGIN;
assert.ok(web && backend, "通过 scripts/web/test-gateway.sh 启动隔离服务后执行");
const api = createApi(`${web}/api/v1`);
let sequence = 0;

// 只模拟外部设备边界；后台、公开网页代理和认证校验均为真实隔离服务。
class TestBadge implements BadgeLink {
  deviceId: string;
  writes: Uint8Array[] = [];
  flags = 0;
  packet: Uint8Array = new Uint8Array();
  onReply?: () => Promise<void>;
  corruptReply = false;
  constructor(deviceId: string) { this.deviceId = deviceId; }
  async identity() { return this.deviceId; }
  async nonce() { return new Uint8Array(16).fill(0x22); }
  async write(packet: Uint8Array) {
    this.writes.push(packet.slice());
    this.packet = packet;
    if (packet.byteLength === 137) this.flags = 1;
  }
  async reply() {
    await this.onReply?.();
    const query = this.packet.byteLength === 19;
    const body = Buffer.concat([
      Buffer.from([0x43, 0x53, 1]), Buffer.from(this.deviceId.slice(8), "hex"),
      Buffer.from(this.packet.slice(query ? 3 : 89, query ? 19 : 105)), Buffer.from([this.flags]),
      query ? Buffer.alloc(64) : Buffer.from(this.packet.slice(25, 89)),
    ]);
    const packet = new Uint8Array(Buffer.concat([body, createHmac("sha256", Buffer.alloc(32, 0x11)).update(body).digest()]));
    if (this.corruptReply) packet[121] ^= 1;
    return packet;
  }
  close() {}
}

async function fixture(): Promise<{ badge: Badge; link: TestBadge; visit: Visit }> {
  sequence += 1;
  const badge: Badge = { badge_id: `badge-control-${sequence}`, display_number: `${sequence}`,
    device_id: `esp32s3-aabbccddee${sequence.toString(16).padStart(2, "0")}` };
  await api.register(badge);
  const response = await fetch(`${backend}/api/v1/visits`, {
    method: "POST", headers: { "Content-Type": "application/json", Authorization: "Bearer gateway-test-terminal" },
    body: JSON.stringify({ event_id: `control-visit-${sequence}`, session_id: "demo-001", badge_id: badge.badge_id,
      terminal_id: "k230-001", site_id: "A", config_version: 1, captured_at: new Date().toISOString(), time_quality: "synced" }),
  });
  assert.equal(response.status, 200);
  const visits = await api.visits();
  const visit = visits.find(item => item.badge_id === badge.badge_id);
  assert.ok(visit);
  return { badge, visit: visitSchema.parse(visit), link: new TestBadge(badge.device_id) };
}

test("免登录流程只在后台验证实际设备回执后确认解锁", async () => {
  const { badge, link, visit } = await fixture();
  const control = new BadgeControl(badge, link, api);
  const initial = await control.sync();
  assert.equal(initial.unlocked, false);
  const result = await control.unlock(visit);
  assert.equal(result.unlocked, true);
  const commands = await api.commands();
  assert.equal(commands.find(command => command.event_id === visit.event_id)?.status, "confirmed");
});

test("公开网页的专用接口测试记录沿用身份核对和真实回执认证流程", async () => {
  const { badge, link } = await fixture();
  const response = await fetch(`${web}/api/v1/interface-test/visits`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ event_id: `interface-web-${sequence}`, session_id: "demo-001", badge_id: badge.badge_id,
      terminal_id: "interface-test-001", site_id: "A", config_version: 1,
      captured_at: new Date().toISOString(), time_quality: "untrusted" }),
  });
  assert.equal(response.status, 200);
  const visits = await api.visits();
  const visit = visits.find(item => item.event_id === `interface-web-${sequence}`);
  assert.ok(visit);
  assert.equal(visit.source, "interface_test");
  const control = new BadgeControl(badge, link, api);
  await control.sync();
  assert.equal((await control.unlock(visit)).unlocked, true);
  assert.equal((await api.commands()).find(item => item.event_id === visit.event_id)?.status, "confirmed");
});

test("连接身份不匹配时不会向该设备写入任何消息", async () => {
  const { badge, link } = await fixture();
  link.deviceId = "esp32s3-aabbccddeeff";
  const control = new BadgeControl(badge, link, api);
  await assert.rejects(control.sync(), /身份/);
  assert.equal(link.writes.length, 0);
});

test("模拟记录不能因同名真实事件存在而控制实物", async () => {
  const { badge, link, visit } = await fixture();
  const control = new BadgeControl(badge, link, api);
  await control.sync();
  await assert.rejects(control.unlock({ ...visit, source: "generated_simulation" }), /实物到访/);
  assert.equal(link.writes.filter(packet => packet.length === 137).length, 0);
});

test("新连接必须先认证同步进度，不能直接解锁", async () => {
  const { badge, link, visit } = await fixture();
  const control = new BadgeControl(badge, link, api);
  await assert.rejects(control.unlock(visit), /先.*同步/);
  assert.equal(link.writes.length, 0);
});

test("写入已接受但回执认证失败时只能保留已发送，不能确认执行", async () => {
  const { badge, link, visit } = await fixture();
  const control = new BadgeControl(badge, link, api);
  await control.sync();
  link.onReply = async () => {
    const command = (await api.commands()).find(item => item.event_id === visit.event_id);
    assert.equal(command?.status, "sent");
  };
  link.corruptReply = true;
  await assert.rejects(control.unlock(visit), /认证失败/);
  assert.equal((await api.commands()).find(item => item.event_id === visit.event_id)?.status, "sent");
  assert.equal((await api.progress(badge.badge_id)).unlocked, false);
});

test("写入超时后晚到结果不能继续确认，新的操作也必须重连", async () => {
  const { badge, link, visit } = await fixture();
  const control = new BadgeControl(badge, link, api, { timeoutMs: 1_000 });
  await control.sync();
  const write = link.write.bind(link);
  link.write = async packet => {
    await new Promise(resolve => setTimeout(resolve, 1_500));
    await write(packet);
  };
  await assert.rejects(control.unlock(visit), /超时/);
  await new Promise(resolve => setTimeout(resolve, 1_600));
  assert.equal((await api.commands()).find(item => item.event_id === visit.event_id)?.status, "pending");
  assert.equal((await api.progress(badge.badge_id)).unlocked, false);
  await assert.rejects(control.sync(), /重连/);
});

test("同一连接不能并发同步与解锁，拒绝并发不会破坏正在进行的操作", async () => {
  const { badge, link, visit } = await fixture();
  const control = new BadgeControl(badge, link, api);
  await control.sync();
  link.onReply = async () => { await assert.rejects(control.sync(), /并发/); };
  assert.equal((await control.unlock(visit)).unlocked, true);
  assert.deepEqual(link.writes.map(packet => packet.length), [19, 137]);
});
