import assert from "node:assert/strict";
import test from "node:test";
import { visitSchema } from "../lib/contracts.ts";

const generated = {
  event_id: "demo-batch-A-1", session_id: "demo-001", badge_id: "demo-map-A-1",
  terminal_id: "demo-generator-001", site_id: "A", config_version: 1,
  captured_at: "2026-10-03T09:19:42.822316Z", received_at: "2026-10-03T09:19:42.822316Z",
  time_quality: "synced", source: "generated_simulation",
};

test("专用生成终端记录可被网页读取", () => {
  assert.equal(visitSchema.safeParse(generated).success, true);
  assert.equal(visitSchema.safeParse({ ...generated, terminal_id: "k230-001" }).success, true);
});

test("生成终端不能冒充实物扫码或接口测试", () => {
  for (const source of ["physical_scan_simulated_site", "interface_test"]) {
    assert.equal(visitSchema.safeParse({ ...generated, source }).success, false);
  }
  assert.equal(visitSchema.safeParse({ ...generated, terminal_id: "unknown" }).success, false);
  assert.equal(visitSchema.safeParse({ ...generated, terminal_id: "interface-test-001" }).success, false);
});
