import { NextResponse, type NextRequest } from 'next/server';

/**
 * 轻量路由守卫（Next 16 的 proxy 约定；等价于旧 middleware）。
 *
 * 只判断「有没有会话 Cookie」，用于把匿名用户尽早送到登录页并保留 return_url；
 * 真正的会话有效性由 `(app)/layout.tsx` 调 `GET /api/me` 校验（Cookie 存在但失效时再跳登录）。
 * 不拦截 /api、静态资源、图片。
 */
export default function proxy(request: NextRequest): NextResponse {
  const { pathname, search } = request.nextUrl;
  if (pathname === '/login') return NextResponse.next();

  const hasSession =
    request.cookies.has('dssaas_sid') || request.cookies.has('__Host-dssaas_sid');
  if (hasSession) {
    const headers = new Headers(request.headers);
    headers.set('x-dssaas-path', `${pathname}${search}`);
    return NextResponse.next({ request: { headers } });
  }

  const loginUrl = new URL('/login', request.url);
  const returnUrl = `${pathname}${search}`;
  if (returnUrl && returnUrl !== '/') loginUrl.searchParams.set('return_url', returnUrl);
  return NextResponse.redirect(loginUrl);
}

export const config = {
  matcher: ['/((?!api|_next/static|_next/image|favicon.ico|assets).*)'],
};
