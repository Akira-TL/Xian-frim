import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "长安游迹 · 工作人员",
  description: "核对腰牌身份，发送授权并验证设备执行回执。",
  robots: { index: false, follow: false },
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="zh-CN"><body>{children}</body></html>;
}
