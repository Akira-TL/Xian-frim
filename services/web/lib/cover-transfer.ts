export const COVER_MAX_BYTES = 48 * 1024;
export interface CoverChannel {
  read(): Promise<Uint8Array>;
  write(packet: Uint8Array): Promise<void>;
  close(): void;
}
export interface CoverStatus {
  code: number;
  custom: boolean;
  pending: boolean;
  id: number;
  received: number;
  total: number;
  revision: number;
  maximum: number;
}
export interface CoverProgress {phase: "sending" | "saving"; received: number; total: number}
const messages = ["", "", "", "图片传输顺序有误，请重试", "吧唧存储不可用，请检查固件版本",
  "吧唧正在接收另一张图片，请稍后再试", "已取消上传", "传图超时，请重试",
  "图片传输不完整，请重试", "吧唧无法显示这张图片，请重新选择"];

export function coverCrc32(data: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of data) {
    crc ^= byte;
    for (let i = 0; i < 8; ++i) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  }
  return (~crc) >>> 0;
}
export function parseCoverStatus(data: Uint8Array): CoverStatus {
  if (data.length !== 24 || data[0] !== 1 || data[1] > 9 || data[2] > 3 || data[3] !== 0)
    throw new Error("吧唧返回的图片状态无效，请更新固件后重试");
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const value: CoverStatus = {
    code: data[1], custom: Boolean(data[2] & 1), pending: Boolean(data[2] & 2),
    id: view.getUint32(4, true), received: view.getUint32(8, true), total: view.getUint32(12, true),
    revision: view.getUint32(16, true), maximum: view.getUint32(20, true),
  };
  if (value.maximum > COVER_MAX_BYTES || value.received > value.total || value.total > COVER_MAX_BYTES)
    throw new Error("吧唧返回的图片容量或进度无效");
  return value;
}
function packet(op: number, id: number, words: number[] = [], payload?: Uint8Array): Uint8Array {
  const bytes = new Uint8Array(7 + words.length * 4 + (payload?.length ?? 0));
  bytes.set([0x50, 1, op]);
  const view = new DataView(bytes.buffer); view.setUint32(3, id, true);
  words.forEach((word, index) => view.setUint32(7 + index * 4, word, true));
  if (payload) bytes.set(payload, 7 + words.length * 4);
  return bytes;
}
function cancelled(signal?: AbortSignal): void {
  if (signal?.aborted) throw new DOMException("已取消上传", "AbortError");
}
async function step<T>(channel: CoverChannel, operation: () => Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([operation(), new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        channel.close();
        reject(new Error("蓝牙传图超时，请重新连接；旧封面不会被未完成的传输覆盖"));
      }, 10_000);
    })]);
  } finally { if (timer) clearTimeout(timer); }
}
async function status(channel: CoverChannel): Promise<CoverStatus> {
  return parseCoverStatus(await step(channel, () => channel.read()));
}
function check(value: CoverStatus, id: number, code: number): void {
  if (value.id !== id) throw new Error("吧唧返回了其他传输的结果，请重试");
  if (value.code !== code) throw new Error(messages[value.code] || "吧唧尚未确认图片保存");
}
function transferId(): number {
  return crypto.getRandomValues(new Uint32Array(1))[0] || 1;
}

export async function uploadCover(channel: CoverChannel, image: Uint8Array,
  options: {signal?: AbortSignal; onProgress?: (progress: CoverProgress) => void} = {}): Promise<CoverStatus> {
  cancelled(options.signal);
  if (!image.length || image.length > COVER_MAX_BYTES) throw new Error("图片过大，请重新压缩后上传");
  const before = await status(channel);
  if (!before.maximum || image.length > before.maximum) throw new Error("吧唧没有足够的封面存储空间，请更新固件");
  if (before.pending) throw new Error(messages[5]);
  const id = transferId();
  let started = false;
  let committing = false;
  try {
    cancelled(options.signal);
    started = true;
    await step(channel, () => channel.write(packet(1, id, [image.length, coverCrc32(image)])));
    check(await status(channel), id, 1);
    options.onProgress?.({phase: "sending", received: 0, total: image.length});
    for (let offset = 0, count = 0; offset < image.length; ++count) {
      cancelled(options.signal);
      const part = image.subarray(offset, offset + 180);
      await step(channel, () => channel.write(packet(2, id, [offset], part)));
      offset += part.length;
      if (count % 8 === 7 || offset === image.length) {
        const confirmed = await status(channel); check(confirmed, id, 1);
        if (confirmed.received !== offset || confirmed.total !== image.length)
          throw new Error("吧唧接收的图片不完整，请重试");
        options.onProgress?.({phase: "sending", received: confirmed.received, total: image.length});
      }
    }
    cancelled(options.signal);
    committing = true;
    options.onProgress?.({phase: "saving", received: image.length, total: image.length});
    await step(channel, () => channel.write(packet(3, id)));
    const saved = await status(channel); check(saved, id, 2);
    if (!saved.custom || saved.pending || saved.received !== image.length || saved.total !== image.length ||
        saved.revision !== ((before.revision + 1) >>> 0))
      throw new Error("吧唧尚未确认新封面，请重连查看保存结果");
    return saved;
  } catch (error) {
    // 等待当前带响应写入结束后再取消，避免并发 GATT 操作；超时会主动断开连接。
    if (started && !committing) {
      try { await step(channel, () => channel.write(packet(4, id))); } catch { /* 断线由设备丢弃待保存数据 */ }
    }
    throw error;
  }
}

export async function restoreDefaultCover(channel: CoverChannel): Promise<CoverStatus> {
  const before = await status(channel);
  if (!before.maximum) throw new Error(messages[4]);
  if (before.pending) throw new Error(messages[5]);
  const id = transferId();
  await step(channel, () => channel.write(packet(5, id)));
  const saved = await status(channel); check(saved, id, 2);
  if (saved.custom || saved.pending || saved.revision !== ((before.revision + 1) >>> 0))
    throw new Error("吧唧尚未确认恢复默认封面");
  return saved;
}
