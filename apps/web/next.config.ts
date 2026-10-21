import type { NextConfig } from 'next';
import path from 'node:path';

/**
 * M1 前端骨架配置。
 *
 * 同源策略：浏览器只访问 `/api/*`（同源 Cookie + CSRF 双提交的前提），
 * 开发期由 Next rewrite 转发到 Fastify；生产由 Caddy 的 `/api/*` 反代（infra/Caddyfile）。
 * 服务端组件取 `/me` 走 `API_INTERNAL_URL`，不依赖 rewrite。
 */

/**
 * 解析后端地址（D2 修复）：优先 `API_INTERNAL_URL`，否则从仓库根 `.env`
 * 读 `API_PORT` 拼出地址。
 *
 * 之前这里硬编码 fallback `:3001`，而 `.env` 里 `API_PORT=3010`——不带环境
 * 变量起 `next dev` 时，同源 `/api/*` 会打到 3001 上的**别的服务**，页面表现
 * 为"接口不存在"，极难排查。现在以 `.env` 为准，端口只有一处真相。
 */
function resolveApiInternalUrl(): string {
  if (process.env.API_INTERNAL_URL) return process.env.API_INTERNAL_URL;
  try {
    // 仓库根 .env（Next 只自动加载 apps/web/.env*，根目录的需手动读）
    const rootEnv = path.resolve(process.cwd(), '../../.env');
    process.loadEnvFile(rootEnv);
  } catch {
    /* 文件不存在时静默；下面的默认值兜底 */
  }
  const port = process.env.API_PORT ?? '3001';
  return `http://127.0.0.1:${port}`;
}

const apiInternalUrl = resolveApiInternalUrl();

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
