import assert from "node:assert/strict";
import {test} from "node:test";
import {addGuideHistory, readGuideHistory} from "../lib/guide-history.ts";
import {recommendationSchema} from "../lib/contracts.ts";

function result(id: string) {
  return recommendationSchema.parse({snapshot_id: id, source: "none", fallback_reason: "no_candidates",
    selected_site: null, child_text: "", operator_reason: "暂无候选",
    input: {snapshot_id: id, session_id: "demo-001", data_source: "generated_simulation",
      generated_at: "2026-10-03T10:00:00Z", expires_at: "2026-10-03T10:00:30Z", catalog_version: 1,
      selected_visit_site: "A", visited_sites: [], completed_games: [], progress_verified_at: null,
      candidates: [], visitor_profile: {party: "family", interest: "history", pace: "normal"}}});
}

test("损坏或非推荐记录的浏览器存储不会进入界面", () => {
  for (const raw of [null, "{", "{}", '[{"result":{}}]', JSON.stringify([{result: result("one"), decision: "visited"}])]) {
    assert.deepEqual(readGuideHistory(raw), []);
  }
});
test("最近八条去重保留，旧建议过期仍可恢复", () => {
  let history = addGuideHistory([], result("first"));
  for (let i = 0; i < 10; i++) history = addGuideHistory(history, result(`record-${i}`));
  assert.equal(history.length, 8);
  history = addGuideHistory(history, result("record-8"));
  assert.equal(history[0].result.snapshot_id, "record-8");
  assert.equal(history.filter(item => item.result.snapshot_id === "record-8").length, 1);
  assert.deepEqual(readGuideHistory(JSON.stringify(history)), history);
});
test("想去和暂不去随对应建议保存，不构造到访", () => {
  const history = [{result: result("one"), decision: "accepted"}, {result: result("two"), decision: "rejected"}];
  const restored = readGuideHistory(JSON.stringify(history));
  assert.equal(restored[0].decision, "accepted");
  assert.equal(restored[1].decision, "rejected");
  assert.deepEqual(restored[0].result.input.visited_sites, []);
});
