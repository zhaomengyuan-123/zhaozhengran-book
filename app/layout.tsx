import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "赵铮然的人生建议书 · 个人书房",
  description: "阅读、批注、修订并实践属于赵铮然的一本人生建议书。",
  icons: { icon: "/favicon.svg", shortcut: "/favicon.svg" },
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="zh-CN">
      <body>{children}</body>
    </html>
  );
}
