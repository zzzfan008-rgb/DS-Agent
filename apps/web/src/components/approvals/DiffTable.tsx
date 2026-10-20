import styles from './approvals.module.css';

export interface DiffTableProps {
  rows: Array<{ field: string; label: string; before: string; after: string; risk: string | null }>;
}

/** 平台现值 vs 变更：字段级左右对比，变更值高亮。 */
export function DiffTable({ rows }: DiffTableProps) {
  if (rows.length === 0) {
    return <p className={styles.mutedText}>未提供字段级 diff（服务端形状待 M4 固化）。</p>;
  }
  return (
    <div className={styles.tableWrap}>
      <table className={styles.table}>
        <thead>
          <tr>
            <th scope="col">字段</th>
            <th scope="col">平台现值</th>
            <th scope="col">变更后</th>
            <th scope="col">风险</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.field}>
              <th scope="row">{row.label}</th>
              <td className={styles.beforeValue}>{row.before}</td>
              <td className={styles.afterValue}>{row.after}</td>
              <td>{row.risk ? <span className={styles.diffRisk}>{row.risk}</span> : '—'}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
