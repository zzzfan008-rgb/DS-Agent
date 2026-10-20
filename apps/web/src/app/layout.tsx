import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import './globals.css';

export const metadata: Metadata = {
  title: {
    default: 'DSSAAS · 服装电商双平台运营台',
    template: '%s · DSSAAS',
  },
  description: '拼多多 + 1688 双平台运营系统：内容、客服、上架、素材、经营与治理的唯一业务入口。',
  robots: { index: false, follow: false },
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="zh-CN">
      <body>{children}</body>
    </html>
  );
}
