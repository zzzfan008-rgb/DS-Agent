import Link from 'next/link';

export default function NotFound() {
  return (
    <main
      style={{
        minHeight: '100vh',
        display: 'grid',
        placeItems: 'center',
        padding: 24,
      }}
    >
      <div style={{ textAlign: 'center' }}>
        <p style={{ color: '#64748b', fontSize: 12, letterSpacing: '0.08em' }}>404</p>
        <h1 style={{ fontSize: 20, margin: '6px 0 8px' }}>页面不存在</h1>
        <p style={{ color: '#64748b', fontSize: 13, marginBottom: 16 }}>
          你访问的地址不在 12 个业务页面之内。
        </p>
        <Link className="buttonPrimary" href="/">
          回到工作台
        </Link>
      </div>
    </main>
  );
}
