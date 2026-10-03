import {test} from "node:test";
import assert from "node:assert/strict";
import {COVER_MAX_BYTES, coverCrc32, parseCoverStatus, restoreDefaultCover, uploadCover,
  type CoverChannel, type CoverProgress} from "../lib/cover-transfer.ts";

// 只替代蓝牙边界；记录实际发送的字节，独立核对包长度、偏移与保存确认。
class Badge implements CoverChannel {
  packets: Uint8Array[] = [];
  bytes: number[] = [];
  id = 0;
  code = 0;
  revision = 7;
  total = 0;
  crc = 0;
  pending = false;
  custom = true;
  maximum = COVER_MAX_BYTES;
  saveError = 0;
  falseReceipt = false;
  disconnectAt = -1;
  closed = false;
  async read(): Promise<Uint8Array> {
    assert.equal(this.closed, false);
    const data = new Uint8Array(24); data.set([1, this.code, Number(this.custom) | Number(this.pending) * 2, 0]);
    const view = new DataView(data.buffer);
    [this.id, this.bytes.length, this.total, this.revision, this.maximum].forEach((value, i) => view.setUint32(4 + i * 4, value, true));
    return data;
  }
  async write(data: Uint8Array): Promise<void> {
    if (this.closed || this.packets.length === this.disconnectAt) throw new Error("蓝牙已断开");
    this.packets.push(data.slice());
    assert.equal(data[0], 0x50); assert.equal(data[1], 1);
    const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
    const id = view.getUint32(3, true); assert.notEqual(id, 0);
    if (data[2] === 1) {
      assert.equal(data.length, 15); assert.equal(this.pending, false);
      this.id = id; this.total = view.getUint32(7, true); this.crc = view.getUint32(11, true);
      this.bytes = []; this.pending = true; this.code = 1;
    } else if (data[2] === 2) {
      assert.equal(id, this.id); assert.equal(this.pending, true);
      assert.ok(data.length >= 12 && data.length <= 191);
      assert.equal(view.getUint32(7, true), this.bytes.length);
      this.bytes.push(...data.subarray(11)); assert.ok(this.bytes.length <= this.total);
    } else if (data[2] === 3) {
      assert.equal(data.length, 7); assert.equal(id, this.id);
      assert.equal(this.bytes.length, this.total);
      assert.equal(coverCrc32(Uint8Array.from(this.bytes)), this.crc);
      this.pending = false;
      this.code = this.saveError || 2;
      if (!this.saveError && !this.falseReceipt) ++this.revision;
    } else if (data[2] === 4) {
      assert.equal(id, this.id); this.pending = false; this.code = 6;
    } else if (data[2] === 5) {
      assert.equal(data.length, 7); this.id = id;
      this.total = 0; this.bytes = []; this.code = this.saveError || 2;
      if (!this.saveError) { this.custom = false; ++this.revision; }
    } else assert.fail("未知操作码");
  }
  close(): void { this.closed = true; }
}

test("CRC-32 使用标准检验值，状态读取拒绝坏长度、未知版本与容量", () => {
  assert.equal(coverCrc32(new TextEncoder().encode("123456789")), 0xcbf43926);
  assert.throws(() => parseCoverStatus(new Uint8Array(23)), /状态无效/);
  const bad = new Uint8Array(24); bad[0] = 2;
  assert.throws(() => parseCoverStatus(bad), /状态无效/);
  bad[0] = 1; new DataView(bad.buffer).setUint32(20, COVER_MAX_BYTES + 1, true);
  assert.throws(() => parseCoverStatus(bad), /容量/);
});
test("分片连续发送并按设备确认进度，保存版本确认后才成功", async () => {
  const badge = new Badge();
  const image = Uint8Array.from({length: 2049}, (_, i) => i & 255);
  const progress: CoverProgress[] = [];
  const saved = await uploadCover(badge, image, {onProgress: value => progress.push(value)});
  assert.deepEqual(Uint8Array.from(badge.bytes), image);
  assert.equal(saved.code, 2); assert.equal(saved.revision, 8);
  assert.equal(badge.packets.filter(p => p[2] === 2).length, 12);
  assert.deepEqual(progress.map(p => p.received), [0, 1440, 2049, 2049]);
  assert.equal(progress.at(-1)?.phase, "saving");
});
test("保存失败与假成功回执都不能成为成功", async () => {
  const fail = new Badge(); fail.saveError = 4;
  await assert.rejects(uploadCover(fail, new Uint8Array(100)), /存储不可用/);
  assert.equal(fail.revision, 7);
  const fake = new Badge(); fake.falseReceipt = true;
  await assert.rejects(uploadCover(fake, new Uint8Array(100)), /尚未确认/);
});
test("取消只发取消请求，不保存；选图超限、无空间和忙均不开始传输", async () => {
  const badge = new Badge(), abort = new AbortController();
  await assert.rejects(uploadCover(badge, new Uint8Array(3000), {
    signal: abort.signal, onProgress: p => { if (p.received > 0) abort.abort(); },
  }), error => error instanceof DOMException && error.name === "AbortError");
  assert.equal(badge.pending, false); assert.equal(badge.revision, 7);
  assert.equal(badge.packets.at(-1)?.[2], 4);
  assert.ok(!badge.packets.some(p => p[2] === 3));
  const large = new Badge();
  await assert.rejects(uploadCover(large, new Uint8Array(COVER_MAX_BYTES + 1)), /过大/);
  assert.equal(large.packets.length, 0);
  const full = new Badge(); full.maximum = 0;
  await assert.rejects(uploadCover(full, new Uint8Array(10)), /存储空间/);
  assert.equal(full.packets.length, 0);
  const busy = new Badge(); busy.pending = true;
  await assert.rejects(uploadCover(busy, new Uint8Array(10)), /另一张/);
  assert.equal(busy.packets.length, 0);
});
test("断线不发送保存，也不把收到部分数据标为成功", async () => {
  const badge = new Badge(); badge.disconnectAt = 3;
  await assert.rejects(uploadCover(badge, new Uint8Array(1000)), /断开/);
  assert.equal(badge.revision, 7);
  assert.ok(!badge.packets.some(p => p[2] === 3));
});
test("蓝牙调用停滞时有超时退出，不继续写入或提示成功", async context => {
  context.mock.timers.enable({apis: ["setTimeout"]});
  let closed = false, writes = 0;
  const channel: CoverChannel = {
    read: () => new Promise<Uint8Array>(() => {}),
    write: async () => { ++writes; }, close: () => { closed = true; },
  };
  const pending = assert.rejects(uploadCover(channel, new Uint8Array(10)), /传图超时/);
  context.mock.timers.tick(10_001);
  await pending;
  assert.equal(closed, true); assert.equal(writes, 0);
});
test("恢复默认等待设备保存确认，忙时不可覆盖正在接收的照片", async () => {
  const badge = new Badge(); const saved = await restoreDefaultCover(badge);
  assert.equal(saved.custom, false); assert.equal(saved.revision, 8);
  assert.equal(badge.packets.length, 1);
  const busy = new Badge(); busy.pending = true;
  await assert.rejects(restoreDefaultCover(busy), /另一张/);
  assert.equal(busy.packets.length, 0);
});
