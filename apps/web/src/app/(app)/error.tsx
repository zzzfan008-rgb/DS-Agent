'use client';

export default function AppError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <div
      style={{
        maxWidth: 640,
        margin: '8vh auto',
        padding: 24,
        background: '#fff',
        border: '1px solid #fecaca',
        borderLeft: '4px solid #b91c1c',
        borderRadius: 10,
      }}
      role="alert"
    >
      <h1 style={{ fontSize: 18, marginBottom: 8 }}>页面渲染失败</h1>
      <p style={{ color: '#334155', fontSize: 13, marginBottom: 6 }}>
        {error.message || '发生了未预期的错误'}
      </p>
      <p style={{ color: '#64748b', fontSize: 12, fontFamily: 'monospace', marginBottom: 14 }}>
        digest: {error.digest ?? '—'}
      </p>
      <button type="button" className="buttonPrimary" onClick={reset}>
        重试
      </button>
    </div>
  );
}
