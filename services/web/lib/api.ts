import { z } from "zod";
import { activitySchema, badgeSchema, commandSchema, envelopeSchema, stateSchema, visitSchema, scenarioSchema, siteCatalogSchema, recommendationSchema, recommendationRecordSchema, type Badge, type DataSource, type ScenarioRequest, type RecommendationRequest } from "./contracts.ts";
import type {GuideRequest} from "./contracts.ts";

type UnlockRequest = { command_id: string; event_id: string; badge_id: string; device_id: string };
type InterfaceTestVisit = { event_id: string; session_id: "demo-001"; badge_id: string; terminal_id: "interface-test-001";
  site_id: "A"; config_version: 1; captured_at: string; time_quality: "untrusted" };
type RequestBody = Badge | UnlockRequest | ScenarioRequest | RecommendationRequest | GuideRequest | InterfaceTestVisit | { batch_id: string } | { nonce: string } | { device_id: string } | { challenge: string; payload_hex: string };

export function createApi(base = "/xks/api/v1") {
  async function request<T>(path: string, schema: z.ZodType<T>, body?: RequestBody, method = body === undefined ? "GET" : "POST"): Promise<T> {
    const response = await fetch(`${base}/${path}`, {
      method, cache: "no-store", headers: { "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(10_000),
    });
    const value: unknown = await response.json();
    if (!response.ok) {
      const error = z.object({ detail: z.string() }).safeParse(value);
      throw new Error(error.success ? error.data.detail : `接口请求失败（HTTP ${response.status}）`);
    }
    const parsed = schema.safeParse(value);
    if (!parsed.success) throw new Error("后台响应与契约不一致，不能继续操作");
    return parsed.data;
  }
  const badgePath = (badge: string) => `badges/${encodeURIComponent(badge)}`;
  return {
    prepareDemo: (batch_id: string) => request("demo/prepare", z.array(visitSchema), { batch_id }),
    recommend: (input: RecommendationRequest) => request("recommendations", recommendationSchema, input),
    guide: (input: GuideRequest) => request("guide-recommendations", recommendationSchema, input),
    recommendationRecord: (snapshot: string) => request(`recommendations/${encodeURIComponent(snapshot)}`, recommendationRecordSchema),
    sites: () => request("sites", siteCatalogSchema),
    simulate: (input: ScenarioRequest) => request("simulation", scenarioSchema, input),
    activity: (source: DataSource) => request(`activity?source=${encodeURIComponent(source)}`, activitySchema),
    badges: () => request("badges", z.array(badgeSchema)),
    visits: () => request("visits", z.array(visitSchema)),
    testVisit: (badge: string) => request("interface-test/visits", z.strictObject({
      visit: visitSchema, duplicate: z.boolean(), can_unlock: z.boolean(),
    }), { event_id: crypto.randomUUID(), session_id: "demo-001", badge_id: badge, terminal_id: "interface-test-001",
      site_id: "A", config_version: 1, captured_at: new Date().toISOString(), time_quality: "untrusted" }),
    commands: () => request("unlock-commands", z.array(commandSchema)),
    register: (badge: Badge) => request("badges", badgeSchema, badge),
    createUnlock: (input: UnlockRequest) => request("unlock-commands", commandSchema, input),
    authorize: (badge: string, command: string, nonce: string) => request(
      `${badgePath(badge)}/unlock-commands/${encodeURIComponent(command)}/authorize`, envelopeSchema, { nonce }),
    markSent: (command: string, device_id: string) => request(
      `unlock-commands/${encodeURIComponent(command)}/sent`, commandSchema, { device_id }),
    stateChallenge: (badge: string) => request(`${badgePath(badge)}/state-challenges`, envelopeSchema, undefined, "POST"),
    report: (challenge: string, payload_hex: string) => request("device-reports", stateSchema, { challenge, payload_hex }),
    progress: (badge: string) => request(`${badgePath(badge)}/progress`, stateSchema),
  };
}
export const api = createApi();
