/**
 * 渲染器：
 * - renderImageVariants：三种必需变体（缩略图 / 详情大图 / 平台主图），webp；
 *   AIGC 素材在**每个变体的最后一步**合成"AI 生成"标识（docs/10 §7.4）。
 * - renderSizeChart：结构化 size_chart → 750/1200 宽 PNG（docs/10 §8、docs/19 §8），
 *   data_version 与 render_spec_hash 同时产出，供幂等复用。
 *
 * sharp 为原生依赖（libvips，约 30MB 预编译包），随镜像打包；window/linux 均有预编译。
 */
import { createHash } from 'node:crypto';
import sharp from 'sharp';

export interface RenderedVariant {
  key: string;
  mime: string;
  width: number;
  height: number;
  bytes: number;
  sha256: string;
  aigcLabeled: boolean;
  buffer: Buffer;
}

const VARIANTS = [
  { key: 'thumb_320', width: 320, height: 320 },
  { key: 'detail_1200', width: 1200, height: 1200 },
  { key: 'main_800', width: 800, height: 800 },
] as const;

export const VARIANT_KEYS = VARIANTS.map((variant) => variant.key);

function sha256Hex(body: Buffer): string {
  return createHash('sha256').update(body).digest('hex');
}

/** AIGC 可见标识：右下角，白字 + 40% 黑描边，字号 = 短边×2.2%，距边 2.5%。 */
export function aigcLabelSvg(width: number, height: number, text = 'AI 生成'): string {
  const fontSize = Math.max(12, Math.round(Math.min(width, height) * 0.022));
  const margin = Math.round(Math.min(width, height) * 0.025);
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">
    <text x="${width - margin}" y="${height - margin}" text-anchor="end"
      font-family="Microsoft YaHei, Noto Sans CJK SC, sans-serif"
      font-size="${fontSize}" fill="#ffffff" stroke="rgba(0,0,0,0.4)" stroke-width="2">${text}</text>
  </svg>`;
}

export async function renderImageVariants(
  source: Buffer,
  options: { aigc: boolean },
): Promise<RenderedVariant[]> {
  const rendered: RenderedVariant[] = [];
  for (const spec of VARIANTS) {
    let pipeline = sharp(source).resize(spec.width, spec.height, {
      fit: 'cover',
      position: 'centre',
    });
    if (options.aigc) {
      pipeline = pipeline.composite([
        { input: Buffer.from(aigcLabelSvg(spec.width, spec.height)), top: 0, left: 0 },
      ]);
    }
    const buffer = await pipeline.webp({ quality: 82 }).toBuffer();
    rendered.push({
      key: spec.key,
      mime: 'image/webp',
      width: spec.width,
      height: spec.height,
      bytes: buffer.length,
      sha256: sha256Hex(buffer),
      aigcLabeled: options.aigc,
      buffer,
    });
  }
  return rendered;
}

export interface SizeChartRow {
  sizeCode: string;
  sizeOrder: number;
  measurements: Record<string, number | string>;
}

export interface SizeChartInput {
  productName: string;
  fit: string;
  rows: SizeChartRow[];
  versionNo: number;
  effectiveFrom: Date;
  templateVersion?: string;
}

export interface RenderedChart {
  key: string;
  width: number;
  height: number;
  mime: string;
  bytes: number;
  sha256: string;
  buffer: Buffer;
}

export interface SizeChartRenderResult {
  dataVersion: string;
  specHash: string;
  columns: string[];
  charts: RenderedChart[];
}

/** 版式固定（docs/19 §8）：列序按必测部位顺序，只渲染实际存在的列。 */
const MEASURE_COLUMNS = ['衣长', '胸围', '肩宽', '袖长', '腰围', '臀围', '裤长', '大腿围'] as const;
const FIT_LABEL: Record<string, string> = {
  slim: '修身',
  regular: '常规',
  loose: '宽松',
  oversize: '宽松版',
};

export function xmlEscape(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function formatNumber(value: number | string): string {
  if (typeof value === 'string') return value;
  return Number.isInteger(value) ? String(value) : String(value);
}

function dataVersionOf(effectiveFrom: Date): string {
  const compact = effectiveFrom.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
  return `v${compact}`;
}

function buildSvg(input: SizeChartInput, width: number, columns: string[], dataVersion: string): {
  svg: string;
  height: number;
} {
  const scale = width / 750;
  const margin = Math.round(40 * scale);
  const titleSize = Math.round(34 * scale);
  const headSize = Math.round(24 * scale);
  const cellSize = Math.round(24 * scale);
  const footSize = Math.round(20 * scale);
  const rowHeight = Math.round(44 * scale);
  const headerY = Math.round(170 * scale);
  const rows = [...input.rows].sort((a, b) => a.sizeOrder - b.sizeOrder);
  const tableHeight = rowHeight * (rows.length + 1);
  const height = Math.round(headerY + tableHeight + 100 * scale);
  const firstCol = Math.round(150 * scale);
  const colWidth = Math.round((width - margin * 2 - firstCol) / Math.max(1, columns.length));

  const cells: string[] = [];
  const xForCol = (index: number): number => margin + firstCol + colWidth * index + colWidth / 2;

  // 表头背景
  cells.push(
    `<rect x="${margin}" y="${headerY}" width="${width - margin * 2}" height="${rowHeight}" fill="#f0f3f5"/>`,
  );
  cells.push(
    `<text x="${margin + firstCol / 2}" y="${headerY + rowHeight * 0.68}" text-anchor="middle" font-family="Microsoft YaHei, Noto Sans CJK SC, sans-serif" font-size="${headSize}" font-weight="bold" fill="#1f2329">尺码</text>`,
  );
  columns.forEach((column, index) => {
    cells.push(
      `<text x="${xForCol(index)}" y="${headerY + rowHeight * 0.68}" text-anchor="middle" font-family="Microsoft YaHei, Noto Sans CJK SC, sans-serif" font-size="${headSize}" font-weight="bold" fill="#1f2329">${xmlEscape(column)}(cm)</text>`,
    );
  });

  rows.forEach((row, rowIndex) => {
    const y = headerY + rowHeight * (rowIndex + 1);
    if (rowIndex % 2 === 1) {
      cells.push(`<rect x="${margin}" y="${y}" width="${width - margin * 2}" height="${rowHeight}" fill="#f7f7f7"/>`);
    }
    cells.push(
      `<text x="${margin + firstCol / 2}" y="${y + rowHeight * 0.68}" text-anchor="middle" font-family="Microsoft YaHei, Noto Sans CJK SC, sans-serif" font-size="${cellSize}" font-weight="bold" fill="#1f2329">${xmlEscape(row.sizeCode)}</text>`,
    );
    columns.forEach((column, index) => {
      const value = row.measurements[column];
      const text = value === undefined ? '' : formatNumber(value);
      cells.push(
        `<text x="${xForCol(index)}" y="${y + rowHeight * 0.68}" text-anchor="middle" font-family="Microsoft YaHei, Noto Sans CJK SC, sans-serif" font-size="${cellSize}" fill="#1f2329">${xmlEscape(text)}</text>`,
      );
    });
  });

  const footerY = headerY + tableHeight + 60 * scale;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">
    <rect width="${width}" height="${height}" fill="#ffffff"/>
    <text x="${width / 2}" y="${60 * scale}" text-anchor="middle" font-family="Microsoft YaHei, Noto Sans CJK SC, sans-serif" font-size="${titleSize}" font-weight="bold" fill="#1f2329">${xmlEscape(input.productName)} · 尺码表</text>
    <text x="${width / 2}" y="${105 * scale}" text-anchor="middle" font-family="Microsoft YaHei, Noto Sans CJK SC, sans-serif" font-size="${Math.round(22 * scale)}" fill="#66707a">版型：${xmlEscape(FIT_LABEL[input.fit] ?? input.fit)}｜单位 cm｜数据版本 ${xmlEscape(dataVersion)}</text>
    ${cells.join('\n    ')}
    <text x="${width / 2}" y="${footerY}" text-anchor="middle" font-family="Microsoft YaHei, Noto Sans CJK SC, sans-serif" font-size="${footSize}" fill="#8a939c">手工测量存在 1–3cm 误差，建议结合自身尺寸选择</text>
  </svg>`;
  return { svg, height };
}

export async function renderSizeChart(input: SizeChartInput): Promise<SizeChartRenderResult> {
  if (input.rows.length < 2) throw new Error('尺码表至少需要 2 行才能渲染（docs/10 §8.2）');
  const columns = MEASURE_COLUMNS.filter((column) =>
    input.rows.some((row) => row.measurements[column] !== undefined),
  );
  if (columns.length === 0) throw new Error('尺码表缺少可渲染的测量列（docs/10 §8.2）');

  const dataVersion = dataVersionOf(input.effectiveFrom);
  const templateVersion = input.templateVersion ?? 'size-chart@v1';
  const sortedRows = [...input.rows].sort((a, b) => a.sizeOrder - b.sizeOrder);
  const specHash = createHash('sha256')
    .update(
      JSON.stringify({
        templateVersion,
        dataVersion,
        columns,
        rows: sortedRows,
        widths: [750, 1200],
      }),
    )
    .digest('hex');

  const charts: RenderedChart[] = [];
  for (const width of [750, 1200] as const) {
    const { svg, height } = buildSvg({ ...input, rows: sortedRows }, width, columns, dataVersion);
    const buffer = await sharp(Buffer.from(svg)).png().toBuffer();
    charts.push({
      key: `chart_${width}`,
      width,
      height,
      mime: 'image/png',
      bytes: buffer.length,
      sha256: sha256Hex(buffer),
      buffer,
    });
  }
  return { dataVersion, specHash, columns, charts };
}
