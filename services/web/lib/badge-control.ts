import type { createApi } from "./api.ts";
import { stateSchema, type Badge, type DeviceState, type Envelope, type Visit } from "./contracts.ts";

export interface BadgeLink {
  identity(): Promise<string>;
  nonce(): Promise<Uint8Array>;
  write(packet: Uint8Array): Promise<void>;
  reply(): Promise<Uint8Array>;
  close(): void;
}
export type ControlPhase = "checking" | "authorizing" | "sending" | "sent" | "verifying" | "confirmed";
export type ControlApi = ReturnType<typeof createApi>;

function hex(bytes: Uint8Array): string { return Array.from(bytes, value => value.toString(16).padStart(2, "0")).join(""); }
function bytes(value: string): Uint8Array {
  if (!/^(?:[0-9a-f]{2})+$/.test(value)) throw new Error("后台消息字节格式错误");
  return Uint8Array.from(value.match(/../g)!, pair => Number.parseInt(pair, 16));
}

export class BadgeControl {
  private badge: Badge;
  private link: BadgeLink;
  private api: ControlApi;
  private onPhase: (phase: ControlPhase) => void;
  private synced = false;
  private closed = false;
  private busy = false;
  private timeoutMs: number;
  constructor(badge: Badge, link: BadgeLink, api: ControlApi,
              options: { timeoutMs?: number; onPhase?: (phase: ControlPhase) => void } = {}) {
    this.badge = badge; this.link = link; this.api = api; this.onPhase = options.onPhase ?? (() => {});
    this.timeoutMs = options.timeoutMs ?? 15_000;
  }

  get ready(): boolean { return this.synced && !this.closed; }
  close(): void { this.closed = true; this.synced = false; this.link.close(); }
  private live(): void { if (this.closed) throw new Error("连接已失效，请重连并先同步进度"); }
  private async step<T>(operation: () => Promise<T>): Promise<T> {
    this.live(); const value = await operation(); this.live(); return value;
  }
  private async run(operation: () => Promise<DeviceState>): Promise<DeviceState> {
    this.live();
    if (this.busy) throw new Error("上一项操作尚未结束，请勿并发发送");
    this.busy = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error("操作超时，结果未确认；请重连后查询")), this.timeoutMs);
    });
    try { return await Promise.race([operation(), timeout]); }
    catch (error) { this.close(); throw error; }
    finally { if (timer) clearTimeout(timer); this.busy = false; }
  }

  private async exchange(envelope: Envelope, commandId?: string): Promise<DeviceState> {
    if (Date.parse(envelope.expires_at) <= Date.now()) throw new Error("授权已过期，请重新查询");
    this.onPhase("sending");
    await this.step(() => this.link.write(bytes(envelope.payload_hex)));
    if (commandId) {
      this.onPhase("sent");
      await this.step(() => this.api.markSent(commandId, this.badge.device_id));
    }
    this.onPhase("verifying");
    const reply = await this.step(() => this.link.reply());
    const state = stateSchema.parse(await this.step(() => this.api.report(envelope.challenge, hex(reply))));
    if (state.badge_id !== this.badge.badge_id || state.device_id !== this.badge.device_id) {
      throw new Error("后台认证状态与当前腰牌身份不一致");
    }
    if (commandId && !state.unlocked) throw new Error("设备尚未确认解锁");
    this.onPhase("confirmed");
    return state;
  }

  async sync(): Promise<DeviceState> {
    return this.run(async () => {
      this.synced = false;
      this.onPhase("checking");
      if (await this.step(() => this.link.identity()) !== this.badge.device_id) throw new Error("实物身份与登记不一致，禁止发送");
      const envelope = await this.step(() => this.api.stateChallenge(this.badge.badge_id));
      const state = await this.exchange(envelope);
      this.synced = true;
      return state;
    });
  }

  async unlock(visit: Visit): Promise<DeviceState> {
    return this.run(async () => {
      if (!this.synced) throw new Error("请先认证同步当前设备进度");
      if (visit.source !== "physical_scan_simulated_site" || visit.site_id !== "A"
          || visit.session_id !== "demo-001" || visit.badge_id !== this.badge.badge_id) {
        throw new Error("必须选择当前腰牌在 A 点的实物到访");
      }
      if (await this.step(() => this.link.identity()) !== this.badge.device_id) throw new Error("实物身份与登记不一致，禁止发送");
      this.onPhase("authorizing");
      const command = await this.step(() => this.api.createUnlock({ command_id: crypto.randomUUID(), event_id: visit.event_id,
        badge_id: this.badge.badge_id, device_id: this.badge.device_id }));
      if (command.event_id !== visit.event_id || command.badge_id !== this.badge.badge_id || command.device_id !== this.badge.device_id) {
        throw new Error("后台请求与当前到访身份不一致");
      }
      const random = await this.step(() => this.link.nonce());
      if (random.length !== 16) throw new Error("设备随机数长度错误");
      const envelope = await this.step(() => this.api.authorize(this.badge.badge_id, command.command_id, hex(random)));
      return this.exchange(envelope, command.command_id);
    });
  }
}
