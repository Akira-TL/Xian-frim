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
