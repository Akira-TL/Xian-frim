import assert from "node:assert/strict";
import test from "node:test";
import {readDemoSnapshot} from "../lib/demo-badge.ts";
import {connectBadge} from "../lib/web-bluetooth.ts";

const snapshot = {v:2 as const, device_id:"esp32s3-abcdef123456",session_id:"demo-001" as const,
 game_id:"qin_formation" as const,unlocked:true,completed:false,collected:false,exhibiting:false,
 screen:"playing" as const,placed_mask:1,mistakes:0,stage:0,bonus_collected:0,exhibit_game:3};
test("无登记、无后台、无认证接口也能读取任意设备进度",async()=>{
 assert.deepEqual(await readDemoSnapshot({snapshot:async()=>snapshot}),snapshot);
 await assert.rejects(readDemoSnapshot({}),/读取接口/);
 await assert.rejects(readDemoSnapshot({snapshot:async()=>undefined}),/更新固件/);
});
test("直接同步只读取快照特征，不获取身份、随机数和授权特征",async()=>{
 const calls:string[]=[];
 const bytes=new TextEncoder().encode(JSON.stringify(snapshot));
 const device={gatt:{connected:true,connect:async()=>{},disconnect:()=>{},
  getPrimaryService:async()=>({getCharacteristic:async(uuid:string)=>{
   calls.push(uuid);return {readValue:async()=>new DataView(bytes.buffer)};
  }})},addEventListener:()=>{},removeEventListener:()=>{}};
 const oldWindow=Object.getOwnPropertyDescriptor(globalThis,"window");
 const oldNavigator=Object.getOwnPropertyDescriptor(globalThis,"navigator");
 Object.defineProperty(globalThis,"window",{value:{isSecureContext:true},configurable:true});
 Object.defineProperty(globalThis,"navigator",{value:{bluetooth:{requestDevice:async()=>device}},configurable:true});
 try{
  const link=await connectBadge(()=>{}, {snapshotOnly:true});
  assert.deepEqual(await readDemoSnapshot(link),snapshot);
  assert.deepEqual(calls,["5e994003-64aa-4a10-b1f1-78ce02b3974f"]);
  link.close();
 }finally{
  if(oldWindow)Object.defineProperty(globalThis,"window",oldWindow);else Reflect.deleteProperty(globalThis,"window");
  if(oldNavigator)Object.defineProperty(globalThis,"navigator",oldNavigator);else Reflect.deleteProperty(globalThis,"navigator");
 }
});
