import type { NextRequest } from "next/server";

export const dynamic = "force-dynamic";
type RouteContext = { params: Promise<{ path: string[] }> };
const identifier = "[A-Za-z0-9_-]+";
const readable = [
  /^badges$/, /^visits$/, /^unlock-commands$/, /^map$/, /^activity$/, /^sites$/,
  new RegExp(`^badges/${identifier}/progress$`),
  new RegExp(`^recommendations/${identifier}$`),
];
const writable = [
  /^badges$/, /^unlock-commands$/, /^device-reports$/, /^demo\/visits$/, /^simulation$/, /^recommendations$/,
  new RegExp(`^unlock-commands/${identifier}/sent$`),
  new RegExp(`^badges/${identifier}/state-challenges$`),
  new RegExp(`^badges/${identifier}/unlock-commands/${identifier}/authorize$`),
];

function error(detail: string, status: number): Response {
  return Response.json({ detail }, { status, headers: { "Cache-Control": "no-store" } });
}

async function forward(request: NextRequest, context: RouteContext): Promise<Response> {
  const { path } = await context.params;
  const resource = path.join("/");
  const allowed = request.method === "GET" ? readable : request.method === "POST" ? writable : [];
  if (!allowed.some(pattern => pattern.test(resource))) return error("演示接口不存在", 404);
  // 无登录演示仍拒绝其他网页诱导浏览器跨站写入；命令行联调不受登录限制。
  if (request.method !== "GET") {
    const origin = request.headers.get("origin");
    // Next.js 会把内部 URL 的回环地址归一化为 localhost；浏览器 Origin 保留真实主机。
    const expectedOrigin = process.env.CHANGAN_PUBLIC_ORIGIN
      ?? `${request.nextUrl.protocol}//${request.headers.get("host") ?? request.nextUrl.host}`;
    if ((origin && origin !== expectedOrigin) || request.headers.get("sec-fetch-site") === "cross-site") {
      return error("请在演示网页内发起操作", 403);
    }
    if (!request.headers.get("content-type")?.startsWith("application/json")) {
      return error("请求必须使用 JSON", 415);
    }
  }
  const token = process.env.CHANGAN_OPERATOR_TOKEN;
  if (!token || !/^[\x20-\x7e]+$/.test(token)) return error("演示后台通信尚未配置", 503);
  try {
    const backend = new URL(process.env.CHANGAN_BACKEND_ORIGIN ?? "http://127.0.0.1:8000");
    if (!["http:", "https:"].includes(backend.protocol) || backend.username || backend.password
        || backend.pathname !== "/" || backend.search || backend.hash) {
      return error("演示后台地址配置无效", 503);
    }
    let body: string | undefined;
    if (request.method !== "GET") {
      const reader = request.body?.getReader();
      const chunks: Uint8Array[] = [];
      let size = 0;
      if (reader) {
        while (true) {
          const chunk = await reader.read();
          if (chunk.done) break;
          size += chunk.value.byteLength;
          if (size > 16_384) { await reader.cancel(); return error("请求超过演示接口大小限制", 413); }
          chunks.push(chunk.value);
        }
      }
      const bytes = new Uint8Array(size);
      let offset = 0;
      for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
      try { body = new TextDecoder("utf-8", { fatal: true }).decode(bytes); }
      catch { return error("请求不是有效 UTF-8 文本", 400); }
    }
    const response = await fetch(new URL(`/api/v1/${resource}${request.nextUrl.search}`, backend), {
      method: request.method,
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body,
      cache: "no-store",
      redirect: "error",
      signal: AbortSignal.any([request.signal, AbortSignal.timeout(10_000)]),
    });
    return new Response(response.body, { status: response.status, headers: {
      "Content-Type": response.headers.get("content-type") ?? "application/json",
      "Cache-Control": "no-store",
    } });
  } catch {
    return error("后台暂不可达，结果未确认；恢复连接后重新查询", 502);
  }
}

export const GET = forward;
export const POST = forward;
