import { z } from "zod";

const id = z.string().min(1).max(47).regex(/^[A-Za-z0-9_-]+$/);
const commandId = z.string().min(1).max(63).regex(/^[A-Za-z0-9_-]+$/);
const date = z.iso.datetime({ offset: true });
export const badgeSchema = z.strictObject({ badge_id: id, display_number: z.string().min(1).max(12), device_id: id });
export const visitSchema = z.strictObject({
  event_id: commandId, session_id: z.literal("demo-001"), badge_id: id,
  terminal_id: z.literal("k230-001"), site_id: z.enum(["A", "B", "C"]),
  config_version: z.number().int().positive(), captured_at: date, received_at: date,
  time_quality: z.enum(["synced", "untrusted"]),
  source: z.enum(["physical_scan_simulated_site", "generated_simulation"]),
});
export const commandSchema = z.strictObject({
  command_id: commandId, event_id: commandId, session_id: z.literal("demo-001"),
  badge_id: id, device_id: id, game_id: z.literal("qin_formation"),
  created_at: date, expires_at: date, status: z.enum(["pending", "sent", "confirmed", "unknown", "failed"]),
});
export const stateSchema = z.strictObject({
  badge_id: id, device_id: id, session_id: z.literal("demo-001"), game_id: z.literal("qin_formation"),
  unlocked: z.boolean(), completed: z.boolean(), collected: z.boolean(), exhibiting: z.boolean(), verified_at: date,
}).refine(value => value.completed === value.collected && (!value.completed || value.unlocked)
  && (!value.exhibiting || value.collected), "进度不满足收藏约束");
export const envelopeSchema = z.strictObject({
  challenge: z.string().regex(/^[0-9a-f]{32}$/), payload_hex: z.string().regex(/^[0-9a-f]+$/), expires_at: date,
});
export type Badge = z.infer<typeof badgeSchema>;
export type Visit = z.infer<typeof visitSchema>;
export type Command = z.infer<typeof commandSchema>;
export type DeviceState = z.infer<typeof stateSchema>;
export type Envelope = z.infer<typeof envelopeSchema>;

export const sourceSchema = z.enum(["physical_scan_simulated_site", "generated_simulation"]);
const siteId = z.enum(["A", "B", "C"]);
const count = z.number().int().nonnegative();
const heatThresholdsSchema = z.strictObject({
  medium_min: z.number().int().min(1).max(2147483647),
  high_min: z.number().int().min(2).max(2147483647),
}).refine(value => value.high_min > value.medium_min, "高热度起点必须大于中热度起点");
const siteStatisticsSchema = z.strictObject({
  site_id: siteId, recent_unique_badges: count, previous_unique_badges: count,
  change: z.number().int(), excluded_untrusted_events: count, updated_at: date.nullable(),
  data_status: z.enum(["fresh", "stale", "missing", "untrusted"]),
  heat: z.enum(["low", "medium", "high", "insufficient"]),
});
const mapSchema = z.strictObject({
  session_id: z.literal("demo-001"), source: sourceSchema, generated_at: date,
  window_seconds: z.literal(300), stale_after_seconds: z.literal(90), demo_thresholds: z.literal(true),
  heat_thresholds: heatThresholdsSchema.default({ medium_min: 3, high_min: 6 }),
  metric_label: z.literal("参与腰牌打卡数据；非实时在场人数"), sites: z.array(siteStatisticsSchema),
  trend: z.array(z.strictObject({ site_id: siteId, window_start: date, window_end: date, unique_badges: count })),
  transitions: z.array(z.strictObject({ from_site: siteId, to_site: siteId, count })),
});
const progressSummarySchema = z.strictObject({
  game_id: z.literal("qin_formation"), eligible_badges: count, verified_badges: count,
  unlocked_badges: count, completed_badges: count, collected_badges: count,
  exhibiting_badges: count, last_verified_at: date.nullable(),
}).refine(value => value.verified_badges <= value.eligible_badges
  && value.unlocked_badges <= value.verified_badges && value.completed_badges <= value.unlocked_badges
  && value.collected_badges === value.completed_badges && value.exhibiting_badges <= value.collected_badges,
"认证计数不满足游戏进度约束");
export const activitySchema = z.strictObject({ map: mapSchema, progress: progressSummarySchema.nullable() })
  .refine(value => (value.map.source === "generated_simulation") === (value.progress === null),
    "模拟来源不能包含实物游戏进度");
export type ActivitySnapshot = z.infer<typeof activitySchema>;
export type DataSource = z.infer<typeof sourceSchema>;

export const scenarioRequestSchema = z.strictObject({
  nodes: z.array(z.strictObject({
    site_id: siteId, initial_people: z.number().min(0).max(10000),
    arrivals_per_minute: z.number().min(0).max(1000), stay_minutes: z.number().min(1).max(240),
  })).length(3),
  from_site: siteId, to_site: siteId, adoption_ratio: z.number().min(0).max(1),
  duration_minutes: z.number().int().min(1).max(120),
}).refine(value => new Set(value.nodes.map(node => node.site_id)).size === 3
  && value.from_site !== value.to_site, "节点必须各提供一次，且分流目标不同");
const populationSchema = z.array(z.strictObject({ site_id: siteId, people: z.number().nonnegative() }))
  .length(3).refine(value => new Set(value.map(node => node.site_id)).size === 3, "推演节点不完整");
export const scenarioSchema = z.strictObject({
  source: z.literal("scenario_simulation"), generated_at: date, step_minutes: z.literal(1),
  departure_rule: z.literal("previous_people / stay_minutes"),
  metric_label: z.literal("假设估计人数；情景推演；非现场观测"), parameters: scenarioRequestSchema,
  series: z.array(z.strictObject({ minute: count, baseline: populationSchema, guided: populationSchema,
    diverted_arrivals: z.number().nonnegative() })).min(2).max(121),
}).refine(value => value.series.length === value.parameters.duration_minutes + 1
  && value.series.every((point, index) => point.minute === index), "推演时间步不连续");
export type ScenarioRequest = z.infer<typeof scenarioRequestSchema>;
export type ScenarioResult = z.infer<typeof scenarioSchema>;

export const siteDefinitionSchema = z.strictObject({
  site_id: siteId, name: z.string().min(1).max(32), x: z.number().min(0).max(1), y: z.number().min(0).max(1),
  is_open: z.boolean(), reachable_sites: z.array(siteId).max(2),
  task_name: z.string().min(1).max(32), task_prompt: z.string().min(1).max(120),
  game_id: z.enum(["qin_formation", "gate_search", "poem_completion"]), game_available: z.boolean(),
}).refine(value => !value.reachable_sites.includes(value.site_id)
  && new Set(value.reachable_sites).size === value.reachable_sites.length
  && (!value.game_available || value.game_id === "qin_formation"), "节点配置不满足首版可用性约束");
export const siteCatalogSchema = z.strictObject({
  version: z.number().int().positive(), source: z.literal("demo_site_configuration"), geographic_map: z.literal(false),
  heat_thresholds: heatThresholdsSchema.default({ medium_min: 3, high_min: 6 }),
  sites: z.array(siteDefinitionSchema).length(3),
}).refine(value => new Set(value.sites.map(site => site.site_id)).size === 3, "节点配置不完整");
export type SiteCatalog = z.infer<typeof siteCatalogSchema>;

export const recommendationRequestSchema = z.strictObject({ badge_id: id, event_id: commandId });
const recommendationInputSchema = z.strictObject({
  snapshot_id: id, session_id: z.literal("demo-001"), data_source: sourceSchema,
  generated_at: date, expires_at: date, catalog_version: z.number().int().positive(), selected_visit_site: siteId,
  heat_thresholds: heatThresholdsSchema.default({ medium_min: 3, high_min: 6 }),
  visited_sites: z.array(siteId).max(3), completed_games: z.array(z.literal("qin_formation")).max(1),
  progress_verified_at: date.nullable(), candidates: z.array(z.strictObject({
    site: siteDefinitionSchema, statistics: siteStatisticsSchema, visited: z.boolean(),
  })).max(2),
}).refine(value => new Set(value.visited_sites).size === value.visited_sites.length
  && new Set(value.candidates.map(candidate => candidate.site.site_id)).size === value.candidates.length
  && Date.parse(value.generated_at) < Date.parse(value.expires_at)
  && (value.data_source !== "generated_simulation" || (value.completed_games.length === 0 && value.progress_verified_at === null))
  && value.candidates.every(candidate => candidate.site.is_open && candidate.site.site_id !== value.selected_visit_site
    && candidate.statistics.site_id === candidate.site.site_id && candidate.statistics.data_status === "fresh"
    && !value.completed_games.some(game => candidate.site.game_id === game)), "推荐输入违反来源或候选约束");
export const recommendationSchema = z.strictObject({
  snapshot_id: id, source: z.enum(["model", "rule_fallback", "none"]),
  fallback_reason: z.enum(["not_configured", "no_candidates", "invalid_output", "timeout", "unavailable"]).nullable(),
  selected_site: siteId.nullable(), child_text: z.string().max(200), operator_reason: z.string().max(500),
  input: recommendationInputSchema,
}).refine(value => value.snapshot_id === value.input.snapshot_id && (
  value.source === "none"
    ? value.fallback_reason === "no_candidates" && value.selected_site === null && value.child_text === "" && value.input.candidates.length === 0
    : (value.source === "model" ? value.fallback_reason === null
        : value.fallback_reason === "not_configured" || value.fallback_reason === "invalid_output"
          || value.fallback_reason === "timeout" || value.fallback_reason === "unavailable")
      && value.child_text.trim().length > 0 && value.operator_reason.trim().length > 0
      && value.input.candidates.some(candidate => candidate.site.site_id === value.selected_site)
), "推荐结果不属于输入候选或来源标记错误");
export const recommendationRecordSchema = z.strictObject({
  delivery: z.literal("historical"), retrieved_at: date, expired: z.boolean(), result: recommendationSchema,
});
export type RecommendationRequest = z.infer<typeof recommendationRequestSchema>;
export type RecommendationResult = z.infer<typeof recommendationSchema>;
export type RecommendationRecord = z.infer<typeof recommendationRecordSchema>;
