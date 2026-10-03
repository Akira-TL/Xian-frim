import type {BadgeLink} from "./badge-control.ts";
import {badgeRuntimeSchema, type BadgeRuntime} from "./contracts.ts";

// 比赛演示只读实物快照；不登记、不核对身份、不调用后台授权。
export async function readDemoSnapshot(link: Pick<BadgeLink,"snapshot">): Promise<BadgeRuntime> {
  if (!link.snapshot) throw new Error("设备没有提供游戏进度读取接口");
  const value = await link.snapshot();
  if (!value) throw new Error("设备没有返回游戏进度，请更新固件");
  return badgeRuntimeSchema.parse(value);
}
