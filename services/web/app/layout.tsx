import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "长安游迹",
  description: "连接你的腰牌，探索长安，收藏秦俑守护。",
  robots: { index: false, follow: false },
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="zh-CN"><body>{children}</body></html>;
}
