import {z} from "zod";
import {recommendationSchema, type RecommendationResult} from "./contracts.ts";

export const guideHistoryKey = "changan.guide-history.v1";
const historySchema = z.array(z.strictObject({
  result: recommendationSchema,
  decision: z.enum(["accepted", "rejected"]).optional(),
})).max(8);
export type GuideHistoryItem = z.infer<typeof historySchema>[number];

export function readGuideHistory(raw: string | null): GuideHistoryItem[] {
  if (!raw) return [];
  try {
    const parsed = historySchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : [];
  } catch { return []; }
}

export function addGuideHistory(history: GuideHistoryItem[], result: RecommendationResult): GuideHistoryItem[] {
  return [{result}, ...history.filter(item => item.result.snapshot_id !== result.snapshot_id)].slice(0, 8);
}
