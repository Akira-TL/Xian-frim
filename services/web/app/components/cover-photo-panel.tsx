"use client";
import {useEffect, useRef, useState, type PointerEvent} from "react";
import AddPhotoAlternateRounded from "@mui/icons-material/AddPhotoAlternateRounded";
import RestoreRounded from "@mui/icons-material/RestoreRounded";
import CheckCircleRounded from "@mui/icons-material/CheckCircleRounded";
import CloseRounded from "@mui/icons-material/CloseRounded";
import {restoreDefaultCover, uploadCover, type CoverChannel, type CoverProgress} from "../../lib/cover-transfer";
import {INITIAL_PHOTO_POSITION, compressCoverPhoto, coverPhotoUrl, drawCoverPhoto, photoCrop,
  readCoverPhoto, type PhotoPosition} from "../../lib/cover-photo";

interface Props {
  connected: boolean;
  busy: boolean;
  unsupported?: string;
  connect(): void;
  run(action: (channel: CoverChannel) => Promise<void>): Promise<void>;
  onSaved(preview: string | undefined): void;
}
export default function CoverPhotoPanel({connected, busy, unsupported, connect, run, onSaved}: Props) {
  const [image, setImage] = useState<ImageBitmap>();
  const [position, setPosition] = useState<PhotoPosition>(INITIAL_PHOTO_POSITION);
  const [bytes, setBytes] = useState<Uint8Array>();
  const [preparing, setPreparing] = useState(false);
  const [working, setWorking] = useState(false);
  const [progress, setProgress] = useState<CoverProgress>();
  const [notice, setNotice] = useState("");
  const [saved, setSaved] = useState(false);
  const [restoreOpen, setRestoreOpen] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const serial = useRef(0);
  const active = useRef(false);
  const abort = useRef<AbortController>(undefined);
  const drag = useRef<{x: number; y: number; position: PhotoPosition}>(undefined);
  useEffect(() => () => { ++serial.current; abort.current?.abort(); }, []);
  useEffect(() => () => image?.close(), [image]);
  useEffect(() => {
    if (!connected) abort.current?.abort();
  }, [connected]);
  useEffect(() => {
    if (!image || !canvas.current) return;
    const surface = canvas.current;
    let current = true;
    setBytes(undefined); setPreparing(true); setSaved(false); setNotice("");
    try { drawCoverPhoto(surface, image, position); }
    catch (error) { setNotice(error instanceof Error ? error.message : "图片预览失败"); setPreparing(false); return; }
    const timer = setTimeout(() => {
      void compressCoverPhoto(surface).then(value => { if (current) setBytes(value); })
        .catch(error => { if (current) setNotice(error instanceof Error ? error.message : "图片压缩失败"); })
        .finally(() => { if (current) setPreparing(false); });
    }, 150);
    return () => { current = false; clearTimeout(timer); };
  }, [image, position]);
  async function select(file?: File) {
    if (!file || active.current) return;
    const request = ++serial.current;
    setNotice(""); setSaved(false); setPreparing(true); setBytes(undefined);
    try {
      const photo = await readCoverPhoto(file);
      if (request !== serial.current) { photo.close(); return; }
      setPosition(INITIAL_PHOTO_POSITION); setImage(photo); setRestoreOpen(false);
    } catch (error) {
      if (request === serial.current) {
        setNotice(error instanceof Error ? error.message : "图片无法打开");
        setPreparing(false); setImage(undefined);
      }
    }
  }
  function close() {
    if (active.current) return;
    ++serial.current; setImage(undefined); setBytes(undefined); setNotice("");
    setSaved(false); setPreparing(false); setRestoreOpen(false);
  }
  async function send(restore = false) {
    if (active.current || (!restore && !bytes)) return;
    if (!connected) { connect(); return; }
    active.current = true; setWorking(true); setNotice(""); setSaved(false);
    abort.current = new AbortController();
    const selected = bytes;
    try {
      await run(async channel => {
        if (restore) {
          await restoreDefaultCover(channel); onSaved(undefined);
          setImage(undefined); setBytes(undefined); setRestoreOpen(false);
        } else {
          await uploadCover(channel, selected!, {signal: abort.current?.signal, onProgress: setProgress});
          onSaved(coverPhotoUrl(selected!));
        }
      });
      setSaved(true); setNotice(restore ? "已恢复默认封面" : "已设为腰牌封面");
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "上传未完成，请重试");
    } finally { active.current = false; setWorking(false); setProgress(undefined); abort.current = undefined; }
  }
  function pointer(event: PointerEvent<HTMLCanvasElement>) {
    if (!image || working) return;
    if (event.type === "pointerdown") {
      event.currentTarget.setPointerCapture(event.pointerId);
      drag.current = {x: event.clientX, y: event.clientY, position};
    } else if (event.type === "pointermove" && drag.current) {
      const start = drag.current, crop = photoCrop(image.width, image.height, start.position);
      const size = event.currentTarget.getBoundingClientRect().width;
      const clamp = (value: number) => Math.max(-1, Math.min(1, value));
      setPosition({...start.position,
        x: clamp(start.position.x - (event.clientX - start.x) / size * crop.side * 2 / Math.max(1, image.width - crop.side)),
        y: clamp(start.position.y - (event.clientY - start.y) / size * crop.side * 2 / Math.max(1, image.height - crop.side))});
    } else if (event.type === "pointerup" || event.type === "pointercancel") drag.current = undefined;
  }
  const percent = progress ? Math.floor(progress.received / Math.max(1, progress.total) * 100) : 0;
  return <div className="cover-photo-panel">
    <div className="cover-photo-entry"><AddPhotoAlternateRounded />
      <div><strong>换张封面</strong><span>把喜欢的照片带在身边</span></div>
      <button type="button" disabled={busy || working || preparing} onClick={() => input.current?.click()}>传图</button>
      <input ref={input} type="file" accept="image/*" aria-label="选择腰牌封面图片" hidden
        onChange={event => {const file = event.currentTarget.files?.[0]; event.currentTarget.value = ""; void select(file);}} />
    </div>
    {image && <div className="cover-photo-editor">
      <div className="cover-photo-editor-heading"><strong>圆屏预览</strong><button type="button" aria-label="关闭封面预览"
        disabled={working} onClick={close}><CloseRounded fontSize="small" /></button></div>
      <canvas ref={canvas} width={360} height={360} role="img" aria-label="腰牌圆形封面裁剪预览"
        onPointerDown={pointer} onPointerMove={pointer} onPointerUp={pointer} onPointerCancel={pointer} />
      <p className="cover-photo-hint">拖动调整位置 · 滑条调整大小</p>
      <label className="cover-photo-zoom">缩放<input type="range" min={1} max={3} step={0.01} value={position.zoom}
        aria-label="调整封面缩放" disabled={working} onChange={event => setPosition(value => ({...value, zoom: Number(event.target.value)}))} /></label>
      <p className="cover-photo-size">{preparing ? "正在压缩图片…" : bytes ? `已压缩至 ${Math.ceil(bytes.length / 1024)}KB · 适配圆屏` : "请选择可用的图片"}</p>
      {working && progress ? <div className="cover-photo-progress" role="status">
        <progress max={100} value={percent} aria-label="封面上传进度" /><span>{progress.phase === "saving" ? "正在保存封面…" : `正在上传 ${percent}%`}</span>
      </div> : null}
      <div className="cover-photo-actions">
        <button type="button" className="visitor-primary" disabled={busy || working || preparing || !bytes || !!unsupported}
          onClick={() => void send()}>{connected ? saved ? "再次设为封面" : "设为腰牌封面" : "先连接腰牌"}</button>
        {working && progress?.phase !== "saving" && <button type="button" onClick={() => abort.current?.abort()}>取消上传</button>}
      </div>
      <p className="cover-photo-hint">只更换封面，不影响游戏和收藏</p>
      {unsupported && <p className="cover-photo-notice" role="status">{unsupported}</p>}
    </div>}
    <div className="cover-photo-footer"><button type="button" disabled={busy || working || !connected}
      onClick={() => setRestoreOpen(value => !value)}><RestoreRounded fontSize="small" />恢复默认封面</button></div>
    {restoreOpen && <div className="cover-photo-restore"><span>换回长安游迹默认封面？</span>
      <button type="button" disabled={busy || working} onClick={() => void send(true)}>恢复</button>
      <button type="button" disabled={working} onClick={() => setRestoreOpen(false)}>取消</button></div>}
    {notice && <p className={`cover-photo-notice${saved ? " is-saved" : ""}`} role="status">{saved && <CheckCircleRounded fontSize="small" />}{notice}</p>}
  </div>;
}
