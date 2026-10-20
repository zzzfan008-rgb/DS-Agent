'use client';

import Link from 'next/link';
import { useRef, useState } from 'react';
import { importProductCsv } from '@/lib/products-client';
import { isApiFailure, redirectToLogin } from '@/lib/m3-api';
import type { ImportResult } from '@/lib/m3-types';
import { InlineAlert, SectionCard, Spinner, ValidationList, type IssueLike } from '@/components/m3/M3Ui';
import { Icon } from '@/components/common/Icon';
import styles from './products.module.css';
import m3 from '@/components/m3/m3.module.css';

const TEMPLATE_HEADERS = [
  'spu_code',
  'name',
  'category_code',
  'color_id',
  'color_name',
  'size_code',
  'price_cents',
  'list_price_cents',
  'sale_price_cents',
  'stock_qty',
  'min_order_qty',
  'fabric_code',
  'fabric_name',
  'fabric_role',
  'fabric_materials',
  'measurements',
  'effective_from',
  'size_system',
] as const;

function buildTemplate(): string {
  const header = TEMPLATE_HEADERS.join(',');
  const example = [
    'SPU-2026-001',
    '示例风衣',
    'A0101',
    'BK0101',
    '黑',
    'M',
    '39900',
    '49900',
    '',
    '120',
    '1',
    'MAIN',
    '主料',
    'main',
    '"[{""material"":""棉"",""percent"":80},{""material"":""聚酯纤维"",""percent"":20}]"',
    '"{""衣长"":70,""胸围"":108}"',
    '2026-10-20',
    'alpha',
  ].join(',');
  return `${header}\n${example}\n`;
}

function downloadTemplate(): void {
  const blob = new Blob([`\uFEFF${buildTemplate()}`], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = 'dssaas-products-template.csv';
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

function issuesFromFailure(failure: { message: string; detail: Record<string, unknown> | null }): IssueLike[] {
  const detail = failure.detail;
  if (detail) {
    const issues = detail.issues;
    if (Array.isArray(issues) && issues.length > 0) {
      return issues.map((issue) => {
        const record = issue as { field?: unknown; message?: unknown; code?: unknown };
        return {
          ...(typeof record.field === 'string' ? { field: record.field } : {}),
          ...(typeof record.code === 'string' ? { code: record.code } : {}),
          message: typeof record.message === 'string' ? record.message : String(issue),
        };
      });
    }
  }
  return [{ message: failure.message }];
}

export function ProductImportView() {
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [file, setFile] = useState<File | null>(null);
  const [dragging, setDragging] = useState(false);
  const [preview, setPreview] = useState<ImportResult | null>(null);
  const [result, setResult] = useState<ImportResult | null>(null);
  const [issues, setIssues] = useState<IssueLike[]>([]);
  const [serverFailedRows, setServerFailedRows] = useState<ImportResult['rows_failed']>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<'preview' | 'import' | null>(null);

  const selectFile = (next: File | null) => {
    setFile(next);
    setPreview(null);
    setResult(null);
    setIssues([]);
    setServerFailedRows([]);
    setError(null);
  };

  const previewFile = async () => {
    if (!file) return;
    setBusy('preview');
    setError(null);
    setIssues([]);
    setResult(null);
    try {
      const data = await importProductCsv(file, { dryRun: true, platformScope: 'both' });
      setPreview(data);
    } catch (caught: unknown) {
      if (isApiFailure(caught)) {
        if (caught.status === 401) {
          redirectToLogin();
          return;
        }
        setIssues(issuesFromFailure(caught));
        const rows = caught.detail?.rows_failed;
        setServerFailedRows(Array.isArray(rows) ? (rows as ImportResult['rows_failed']) : []);
        setError(caught.message);
        return;
      }
      setError('预览失败：网络错误');
    } finally {
      setBusy(null);
    }
  };

  const confirmImport = async () => {
    if (!file) return;
    setBusy('import');
    setError(null);
    try {
      const data = await importProductCsv(file, { dryRun: false, platformScope: 'both' });
      setResult(data);
      setPreview(null);
    } catch (caught: unknown) {
      if (isApiFailure(caught)) {
        if (caught.status === 401) {
          redirectToLogin();
          return;
        }
        setIssues(issuesFromFailure(caught));
        const rows = caught.detail?.rows_failed;
        setServerFailedRows(Array.isArray(rows) ? (rows as ImportResult['rows_failed']) : []);
        setError(caught.message);
        return;
      }
      setError('导入失败：网络错误');
    } finally {
      setBusy(null);
    }
  };

  const failedRows = preview?.rows_failed ?? [];

  return (
    <div className={m3.pageStack}>
      <div className={styles.backRow}>
        <Link className={styles.backLink} href="/products">
          <Icon name="arrowLeft" size={15} />
          返回商品库
        </Link>
        <span className="badge badgeM1">M3 · CSV 导入</span>
      </div>

      <div>
        <h1 className={styles.detailTitle}>导入商品 CSV</h1>
        <p className={styles.detailMeta}>
          先 dry-run 预览（不写库），确认后才整批导入；任一行非法则整批零写入。
        </p>
      </div>

      {error ? <InlineAlert tone="error">{error}</InlineAlert> : null}
      {issues.length > 0 ? <ValidationList issues={issues} /> : null}

      <SectionCard
        title="1. 选择文件"
        description="仅支持 UTF-8 CSV；下载模板后按列填写。fabric_materials 与 measurements 是 JSON 字符串，必须用双引号包裹。"
        extra={
          <button type="button" className="buttonSecondary" onClick={downloadTemplate}>
            <Icon name="database" size={14} />
            下载模板 CSV
          </button>
        }
      >
        <label
          className={styles.dropzone}
          onDragOver={(event) => {
            event.preventDefault();
            setDragging(true);
          }}
          onDragLeave={() => setDragging(false)}
          onDrop={(event) => {
            event.preventDefault();
            setDragging(false);
            const dropped = event.dataTransfer.files[0];
            if (dropped) selectFile(dropped);
          }}
          style={dragging ? { borderColor: 'var(--brand-600)', background: 'var(--brand-50)' } : undefined}
        >
          <input
            ref={inputRef}
            className={styles.fileInput}
            type="file"
            accept=".csv,text/csv"
            onChange={(event) => selectFile(event.target.files?.[0] ?? null)}
          />
          <Icon name="database" size={22} />
          <span className={styles.dropzoneTitle}>拖拽 CSV 到此处，或点击选择文件</span>
          <span className={styles.dropzoneHint}>
            必填列：spu_code, name, category_code, color_id, size_code, price_cents, fabric_materials,
            measurements。同 SPU 多行会按 SPU 聚合成一个商品。
          </span>
          {file ? <span className={styles.fileName}>{file.name}</span> : null}
        </label>

        <div className={m3.inlineActions} style={{ marginTop: 12 }}>
          <button
            type="button"
            className="buttonSecondary"
            onClick={() => inputRef.current?.click()}
            disabled={Boolean(busy)}
          >
            选择文件
          </button>
          <button
            type="button"
            className="buttonPrimary"
            onClick={() => void previewFile()}
            disabled={!file || Boolean(busy)}
          >
            {busy === 'preview' ? <Spinner label="校验中" /> : '预览校验（dry-run）'}
          </button>
          {file ? (
            <button type="button" className="buttonQuiet" onClick={() => selectFile(null)} disabled={Boolean(busy)}>
              清除文件
            </button>
          ) : null}
        </div>
      </SectionCard>

      {preview ? (
        <SectionCard
          title="2. 预览结果（未写库）"
          description="dry_run=true；以下统计来自服务端实际校验结果。"
          extra={<span className="badge">dry_run</span>}
        >
          <div className={styles.summaryGrid}>
            <div className={styles.summaryCard}>
              <p className={styles.summaryValue}>{preview.rows_total}</p>
              <p className={styles.summaryLabel}>总行数</p>
            </div>
            <div className={styles.summaryCard}>
              <p className={styles.summaryValue}>{preview.rows_ok}</p>
              <p className={styles.summaryLabel}>可导入行</p>
            </div>
            <div className={styles.summaryCard}>
              <p className={styles.summaryValue} style={{ color: preview.rows_failed.length > 0 ? 'var(--danger)' : undefined }}>
                {preview.rows_failed.length}
              </p>
              <p className={styles.summaryLabel}>失败行</p>
            </div>
            <div className={styles.summaryCard}>
              <p className={styles.summaryValue}>{preview.warnings.length}</p>
              <p className={styles.summaryLabel}>警告</p>
            </div>
          </div>

          {failedRows.length > 0 ? (
            <div style={{ marginTop: 12 }}>
              <p className={m3.sectionTitle}>逐行错误</p>
              <div className={m3.tableWrap} style={{ marginTop: 6 }}>
                <table className={styles.failedTable}>
                  <caption>导入失败行</caption>
                  <thead>
                    <tr>
                      <th scope="col">行</th>
                      <th scope="col">字段</th>
                      <th scope="col">原因</th>
                    </tr>
                  </thead>
                  <tbody>
                    {failedRows.map((row, index) => (
                      <tr key={`${row.row}-${row.field}-${index}`}>
                        <td>{row.row === 0 ? '整组' : row.row}</td>
                        <td className={m3.mono}>{row.field}</td>
                        <td>{row.reason}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          ) : (
            <InlineAlert tone="success">预览通过，可以确认导入。</InlineAlert>
          )}

          <div className={m3.inlineActions} style={{ marginTop: 12 }}>
            <button
              type="button"
              className="buttonPrimary"
              onClick={() => void confirmImport()}
              disabled={Boolean(busy) || failedRows.length > 0}
            >
              {busy === 'import' ? <Spinner label="导入中" /> : `确认导入（${preview.rows_ok} 行）`}
            </button>
            <span className={m3.muted}>
              {failedRows.length > 0 ? '存在失败行时禁止确认；整批失败不会写入任何数据。' : '确认后整批事务写入。'}
            </span>
          </div>
        </SectionCard>
      ) : null}

      {result ? (
        <SectionCard title="导入完成" extra={<span className="badge badgeM1">已写入</span>}>
          <InlineAlert tone="success" title={`导入成功（import_id: ${result.import_id}）`}>
            共 {result.rows_total} 行，成功 {result.rows_ok} 行；本次写入的 SPU 已按行聚合。
          </InlineAlert>
          <div className={m3.inlineActions} style={{ marginTop: 12 }}>
            <Link className="buttonPrimary" href="/products">
              查看商品列表
            </Link>
            <button type="button" className="buttonSecondary" onClick={() => selectFile(null)}>
              再导入一个文件
            </button>
          </div>
        </SectionCard>
      ) : null}

      {serverFailedRows.length > 0 ? (
        <SectionCard title="服务端拒绝明细">
          <div className={m3.tableWrap}>
            <table className={styles.failedTable}>
              <thead>
                <tr>
                  <th scope="col">行</th>
                  <th scope="col">字段</th>
                  <th scope="col">原因</th>
                </tr>
              </thead>
              <tbody>
                {serverFailedRows.map((row, index) => (
                  <tr key={`detail-${row.row}-${index}`}>
                    <td>{row.row === 0 ? '整组' : row.row}</td>
                    <td className={m3.mono}>{row.field}</td>
                    <td>{row.reason}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </SectionCard>
      ) : null}
    </div>
  );
}
