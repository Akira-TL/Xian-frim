import type { BadgeLink } from "./badge-control.ts";

const advertisedService = "6e400001-b5a3-f393-e0a9-e50e24dcca9e";
const activityService = "5e994001-64aa-4a10-b1f1-78ce02b3974f";
const characteristic = (suffix: string) => `5e99400${suffix}-64aa-4a10-b1f1-78ce02b3974f`;

export function bluetoothSupport(): string | undefined {
  if (typeof window === "undefined") return "等待浏览器加载";
  if (!window.isSecureContext) return "蓝牙需要可信 HTTPS；电脑 localhost 仅可用于本地调试";
  if (!navigator.bluetooth) return "此浏览器不支持 Web Bluetooth，请使用支持该能力的安卓浏览器";
  return undefined;
}

export async function connectBadge(onDisconnect: () => void): Promise<BadgeLink> {
  const unavailable = bluetoothSupport();
  if (unavailable) throw new Error(unavailable);
  // 必须在用户点击事件中直接调用；不能放在后台轮询或先等待网络后调用。
  const device = await navigator.bluetooth.requestDevice({
    filters: [{ services: [advertisedService] }], optionalServices: [activityService],
  });
  if (!device.gatt) throw new Error("所选设备没有可用 GATT 服务");
  let closed = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const disconnect = () => { closed = true; device.removeEventListener("gattserverdisconnected", lost); device.gatt?.disconnect(); };
  const lost = () => { if (!closed) { closed = true; onDisconnect(); } };
  const live = () => { if (closed || !device.gatt?.connected) throw new Error("蓝牙连接已失效，请重新连接"); };
  device.addEventListener("gattserverdisconnected", lost);
  const setup = async (): Promise<BadgeLink> => {
    await device.gatt!.connect(); live();
    const service = await device.gatt!.getPrimaryService(activityService); live();
    const identity = await service.getCharacteristic(characteristic("2")); live();
    const nonce = await service.getCharacteristic(characteristic("4")); live();
    const control = await service.getCharacteristic(characteristic("5")); live();
    const reply = await service.getCharacteristic(characteristic("6")); live();
    if (!control.properties.write) throw new Error("设备不支持带响应写入，不能发送完整授权");
    const read = async (item: BluetoothRemoteGATTCharacteristic) => {
      live(); const value = await item.readValue(); live();
      return new Uint8Array(value.buffer, value.byteOffset, value.byteLength).slice();
    };
    return {
      async identity() {
        const value = new TextDecoder("utf-8", { fatal: true }).decode(await read(identity));
        if (!/^esp32s3-[0-9a-f]{12}$/.test(value)) throw new Error("设备出厂身份格式错误");
        return value;
      },
      async nonce() {
        const value = await read(nonce);
        if (value.length !== 16) throw new Error("设备随机数长度错误");
        return value;
      },
      async write(packet) {
        live();
        if (![19, 137].includes(packet.byteLength)) throw new Error("设备消息长度错误");
        await control.writeValueWithResponse(Uint8Array.from(packet).buffer); live();
      },
      async reply() {
        const value = await read(reply);
        if (value.length !== 122 || value[0] !== 0x43 || value[1] !== 0x53 || value[2] !== 1) {
          throw new Error("设备认证回执长度或版本错误");
        }
        return value;
      },
      close: disconnect,
    };
  };
  try {
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => { disconnect(); reject(new Error("蓝牙连接超时，请重新选择设备")); }, 15_000);
    });
    const connection = setup().catch(error => { disconnect(); throw error; });
    return await Promise.race([connection, timeout]);
  } catch (error) { disconnect(); throw error; }
  finally { if (timer) clearTimeout(timer); }
}
