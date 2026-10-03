import test from "node:test";
import assert from "node:assert/strict";
import {compressCoverPhoto, photoCrop, readCoverPhoto} from "../lib/cover-photo.ts";
import {COVER_MAX_BYTES} from "../lib/cover-transfer.ts";

test("裁剪保持正方形，横图纵图居中与缩放平移结果可独立核对", () => {
  assert.deepEqual(photoCrop(1200, 800, {zoom: 1, x: 0, y: 0}), {side: 800, x: 200, y: 0});
  assert.deepEqual(photoCrop(800, 1200, {zoom: 2, x: -1, y: 1}), {side: 400, x: 0, y: 800});
  assert.deepEqual(photoCrop(360, 360, {zoom: 1, x: 9, y: -9}), {side: 360, x: 0, y: 0});
  assert.throws(() => photoCrop(0, 20, {zoom: 1, x: 0, y: 0}), /无效/);
  assert.throws(() => photoCrop(20, 20, {zoom: NaN, x: 0, y: 0}), /无效/);
});
test("压缩递减质量，严格保留 360×360，绝不发送超限或 PNG 替代结果", async () => {
  const qualities: number[] = [];
  const fakeCanvas = {width: 360, height: 360,
    toBlob(callback: BlobCallback, type: string, quality: number) {
      assert.equal(type, "image/jpeg"); qualities.push(quality);
      callback(new Blob([new Uint8Array(qualities.length < 3 ? COVER_MAX_BYTES + 1 : COVER_MAX_BYTES)], {type}));
    }} as unknown as HTMLCanvasElement;
  const bytes = await compressCoverPhoto(fakeCanvas);
  assert.equal(bytes.length, COVER_MAX_BYTES); assert.deepEqual(qualities, [0.86, 0.76, 0.64]);
  await assert.rejects(compressCoverPhoto({...fakeCanvas, width: 359}), /尺寸/);
  const png = {...fakeCanvas, toBlob(callback: BlobCallback) { callback(new Blob(["bad"], {type: "image/png"})); }};
  await assert.rejects(compressCoverPhoto(png), /JPEG/);
  const large = {...fakeCanvas, toBlob(callback: BlobCallback) { callback(new Blob([new Uint8Array(COVER_MAX_BYTES + 1)], {type: "image/jpeg"})); }};
  await assert.rejects(compressCoverPhoto(large), /仍然过大/);
});
test("非图片、空文件或超大源图在解码前拒绝", async () => {
  await assert.rejects(readCoverPhoto(new File(["text"], "a.txt", {type: "text/plain"})), /请选择照片/);
  await assert.rejects(readCoverPhoto(new File([], "a.jpg", {type: "image/jpeg"})), /25MB/);
  await assert.rejects(readCoverPhoto(new File([new Uint8Array(25 * 1024 * 1024 + 1)], "a.jpg", {type: "image/jpeg"})), /25MB/);
});
