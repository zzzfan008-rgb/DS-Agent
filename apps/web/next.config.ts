import type { NextConfig } from 'next';

/**
 * M1 前端骨架配置。
 *
 * 同源策略：浏览器只访问 `/api/*`（同源 Cookie + CSRF 双提交的前提），
 * 开发期由 Next rewrite 转发到 Fastify；生产由 Caddy 的 `/api/*` 反代（infra/Caddyfile）。
 * 服务端组件取 `/me` 走 `API_INTERNAL_URL`，不依赖 rewrite。
 */
const apiInternalUrl = process.env.API_INTERNAL_URL ?? 'http://127.0.0.1:3001';

const nextConfig: NextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  /** 开发期允许通过 127.0.0.1 / localhost 访问 HMR 与客户端资源。 */
  allowedDevOrigins: ['127.0.0.1', 'localhost'],
  /** 截图/走查时不显示 Next 开发工具浮标，避免遮挡侧栏底部信息。 */
  devIndicators: false,
  async rewrites() {
    return [
      {
        source: '/api/:path*',
        destination: `${apiInternalUrl}/api/:path*`,
      },
    ];
  },
  async headers() {
    return [
      {
        source: '/:path*',
        headers: [
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'X-Frame-Options', value: 'DENY' },
          { key: 'Referrer-Policy', value: 'same-origin' },
          { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=()' },
        ],
      },
    ];
  },
};

export default nextConfig;
