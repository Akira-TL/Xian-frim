import {COVER_MAX_BYTES} from "./cover-transfer.ts";

export interface PhotoPosition {zoom: number; x: number; y: number}
export const INITIAL_PHOTO_POSITION: PhotoPosition = {zoom: 1, x: 0, y: 0};
export function photoCrop(width: number, height: number, position: PhotoPosition) {
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0 ||
      ![position.zoom, position.x, position.y].every(Number.isFinite))
    throw new Error("图片尺寸或裁剪位置无效");
  const side = Math.min(width, height) / Math.max(1, Math.min(3, position.zoom));
  return {side, x: (width - side) * (Math.max(-1, Math.min(1, position.x)) + 1) / 2,
    y: (height - side) * (Math.max(-1, Math.min(1, position.y)) + 1) / 2};
}
export async function readCoverPhoto(file: File): Promise<ImageBitmap> {
  if (!file.type.startsWith("image/")) throw new Error("请选择照片或图片文件");
  if (!file.size || file.size > 25 * 1024 * 1024) throw new Error("请选择小于 25MB 的图片");
  let image: ImageBitmap;
  try { image = await createImageBitmap(file, {resizeWidth: 1200, resizeQuality: "high"}); }
  catch { throw new Error("无法打开这张图片，请尝试 JPG、PNG 或 WebP 图片"); }
  if (!image.width || !image.height || image.width * image.height > 10_000_000) {
    image.close(); throw new Error("图片比例过于特殊，请先裁剪再选择");
  }
  return image;
}
export function drawCoverPhoto(canvas: HTMLCanvasElement, image: ImageBitmap, position: PhotoPosition): void {
  canvas.width = 360; canvas.height = 360;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("浏览器无法处理图片，请换用支持图片处理的浏览器");
  const crop = photoCrop(image.width, image.height, position);
  context.fillStyle = "#faf3e3"; context.fillRect(0, 0, 360, 360);
  context.drawImage(image, crop.x, crop.y, crop.side, crop.side, 0, 0, 360, 360);
}
export async function compressCoverPhoto(canvas: HTMLCanvasElement): Promise<Uint8Array> {
  if (canvas.width !== 360 || canvas.height !== 360) throw new Error("封面尺寸必须为 360×360");
  for (const quality of [0.86, 0.76, 0.64, 0.52, 0.4, 0.28, 0.18]) {
    const blob = await new Promise<Blob | null>(resolve => canvas.toBlob(resolve, "image/jpeg", quality));
    if (!blob || blob.type !== "image/jpeg") throw new Error("浏览器无法压缩为 JPEG 图片");
    if (blob.size <= COVER_MAX_BYTES && blob.size > 0) return new Uint8Array(await blob.arrayBuffer());
  }
  throw new Error("这张图片压缩后仍然过大，请换一张较简单的图片");
}
export function coverPhotoUrl(bytes: Uint8Array): string {
  return `data:image/jpeg;base64,${btoa(Array.from(bytes, byte => String.fromCharCode(byte)).join(""))}`;
}
