import { z } from "zod";
import { badgeSchema, commandSchema, visitSchema, type Badge } from "./contracts";

type RequestBody = Badge;
async function request<T>(path: string, schema: z.ZodType<T>, body?: RequestBody): Promise<T> {
  const response = await fetch(`/api/v1/${path}`, {
    method: body === undefined ? "GET" : "POST", cache: "no-store",
    headers: body === undefined ? undefined : { "Content-Type": "application/json" },
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

export const api = {
  badges: () => request("badges", z.array(badgeSchema)),
  visits: () => request("visits", z.array(visitSchema)),
  commands: () => request("unlock-commands", z.array(commandSchema)),
  register: (badge: Badge) => request("badges", badgeSchema, badge),
};
