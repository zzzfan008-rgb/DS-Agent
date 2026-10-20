'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import type { FormEvent } from 'react';
import type { ApiFailure } from '@/lib/api';
import { createProduct } from '@/lib/products-client';
import { isApiFailure, redirectToLogin } from '@/lib/m3-api';
import { defaultEffectiveFrom, FIBERS, isHalfStep, isKnownFiber, MEASUREMENT_COLUMNS, normalizeColorId, normalizeSizeCode } from '@/lib/garment-ui';
import { parseYuanToCents } from '@/lib/m3-format';
import type { ProductCreateInput, ProductCreateSkuInput } from '@/lib/m3-types';
import { Field, InlineAlert, SectionCard, Spinner, ValidationList, type IssueLike } from '@/components/m3/M3Ui';
import { Icon } from '@/components/common/Icon';
import styles from './products.module.css';
import m3 from '@/components/m3/m3.module.css';

interface SkuDraft {
  color_id: string;
  color_name: string;
  size_code: string;
  price_yuan: string;
  list_price_yuan: string;
  sale_price_yuan: string;
  stock_qty: string;
  min_order_qty: string;
  fabric_code: string;
}

interface MaterialDraft {
  material: string;
  percent: string;
  note: string;
}

interface SizeDraft {
  size_code: string;
  measurements: Record<string, string>;
  height_min: string;
  height_max: string;
  weight_min: string;
  weight_max: string;
}

const EMPTY_SKU: SkuDraft = {
  color_id: '',
  color_name: '',
  size_code: '',
  price_yuan: '',
  list_price_yuan: '',
  sale_price_yuan: '',
  stock_qty: '0',
  min_order_qty: '1',
  fabric_code: 'MAIN',
};

const EMPTY_SIZE: SizeDraft = {
  size_code: '',
  measurements: {},
  height_min: '',
  height_max: '',
  weight_min: '',
  weight_max: '',
};

const NOTE_OPTIONS = ['主料', '辅料', '里料', '填充', '装饰'] as const;
const SIZE_SYSTEMS = [
  ['alpha', '字母码'],
  ['numeric', '数字码'],
  ['height_weight', '身高体重'],
  ['one_size', '均码'],
] as const;

function issuesFromFailure(failure: ApiFailure): IssueLike[] {
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
    if (typeof detail.field === 'string') {
      return [{ field: detail.field, message: failure.message }];
    }
  }
  return [{ message: failure.message }];
}

function buildPayload(input: {
  spu_code: string;
  name: string;
  category_code: string;
  fit: string;
  brand: string;
  season: string;
  description: string;
  skus: SkuDraft[];
  materials: MaterialDraft[];
  fabric_code: string;
  fabric_name: string;
  fabric_role: string;
  effective_from: string;
  size_system: string;
  size_rows: SizeDraft[];
}): { payload?: ProductCreateInput; issues: IssueLike[] } {
  const issues: IssueLike[] = [];
  const spu = input.spu_code.trim().toUpperCase();
  if (!/^[A-Z0-9][A-Z0-9-]{3,39}$/.test(spu)) {
    issues.push({ field: 'spu_code', message: 'SPU 必须形如 SPU-2026-001（大写字母/数字/连字符）' });
  }
  if (input.name.trim().length < 1 || input.name.trim().length > 120) {
    issues.push({ field: 'name', message: '名称长度必须 1–120 字' });
  }
  const category = input.category_code.trim().toUpperCase();
  if (!/^[A-Z][0-9]{4}(\.[0-9]{1,3})?$/.test(category)) {
    issues.push({ field: 'category_code', message: '类目格式如 A0101 或 A0101.001' });
  }

  const skuPayload: ProductCreateSkuInput[] = [];
  const seen = new Set<string>();
  const skuSizes = new Set<string>();
  input.skus.forEach((sku, index) => {
    const color = normalizeColorId(sku.color_id);
    if (!color.ok) {
      issues.push({ field: `skus[${index}].color_id`, message: color.reason });
    }
    const size = normalizeSizeCode(sku.size_code);
    if (!size.ok) {
      issues.push({ field: `skus[${index}].size_code`, message: size.reason });
    }
    const price = parseYuanToCents(sku.price_yuan);
    if (price === null || price <= 0) {
      issues.push({ field: `skus[${index}].price_cents`, message: '售价必须是大于 0 的金额（最多两位小数）' });
    }
    const listPrice = sku.list_price_yuan.trim() ? parseYuanToCents(sku.list_price_yuan) : undefined;
    if (listPrice === null) {
      issues.push({ field: `skus[${index}].list_price_cents`, message: '划线价格式非法' });
    }
    const salePrice = sku.sale_price_yuan.trim() ? parseYuanToCents(sku.sale_price_yuan) : undefined;
    if (salePrice === null) {
      issues.push({ field: `skus[${index}].sale_price_cents`, message: '促销价格式非法' });
    }
    if (price !== null && salePrice !== null && salePrice !== undefined && salePrice > price) {
      issues.push({ field: `skus[${index}].sale_price_cents`, message: '促销价不得大于售价' });
    }
    if (color.ok && size.ok) {
      const key = `${color.colorId}|${size.sizeCode}`;
      if (seen.has(key)) issues.push({ field: `skus[${index}]`, message: `SKU 重复：${key}` });
      seen.add(key);
      skuSizes.add(size.sizeCode);
    }
    const stock = sku.stock_qty.trim() === '' ? 0 : Number(sku.stock_qty);
    if (!Number.isInteger(stock) || stock < 0) {
      issues.push({ field: `skus[${index}].stock_qty`, message: '库存必须是非负整数' });
    }
    const moq = sku.min_order_qty.trim() === '' ? 1 : Number(sku.min_order_qty);
    if (!Number.isInteger(moq) || moq < 1) {
      issues.push({ field: `skus[${index}].min_order_qty`, message: '起批量必须是正整数' });
    }
    if (color.ok && size.ok && price !== null && price > 0 && Number.isInteger(stock) && Number.isInteger(moq)) {
      skuPayload.push({
        color_id: color.colorId,
        ...(sku.color_name.trim() ? { color_name: sku.color_name.trim() } : {}),
        size_code: size.sizeCode,
        price_cents: price,
        ...(listPrice !== null && listPrice !== undefined ? { list_price_cents: listPrice } : {}),
        ...(salePrice !== null && salePrice !== undefined ? { sale_price_cents: salePrice } : {}),
        stock_qty: stock,
        min_order_qty: moq,
      });
    }
  });
  if (input.skus.length === 0) issues.push({ field: 'skus', message: '至少需要 1 个 SKU' });

  const materials = input.materials
    .filter((material) => material.material || material.percent)
    .map((material, index) => {
      if (!isKnownFiber(material.material)) {
        issues.push({ field: `fabric[${index}].material`, message: `纤维「${material.material || '空'}」不在标准词表` });
      }
      const percent = Number(material.percent);
      if (!Number.isInteger(percent) || percent < 1 || percent > 100) {
        issues.push({ field: `fabric[${index}].percent`, message: '占比必须是 1–100 的整数' });
      }
      return {
        material: material.material,
        percent: Number.isInteger(percent) ? percent : 0,
        ...(material.note ? { note: material.note } : {}),
      };
    });
  if (materials.length === 0) issues.push({ field: 'fabric.materials', message: '至少需要 1 条面料成分' });
  if (materials.length > 8) issues.push({ field: 'fabric.materials', message: '面料成分最多 8 条' });
  for (let index = 1; index < materials.length; index += 1) {
    if ((materials[index - 1]?.percent ?? 0) < (materials[index]?.percent ?? 0)) {
      issues.push({ field: `fabric[${index}].percent`, message: '成分需按占比降序排列' });
    }
  }
  const totalPercent = materials.reduce((sum, material) => sum + material.percent, 0);
  if (materials.length > 0 && totalPercent !== 100) {
    issues.push({ field: 'fabric.materials', message: `成分合计必须为 100，当前为 ${totalPercent}` });
  }

  const chartItems: NonNullable<ProductCreateInput['size_chart']>['items'] = [];
  const chartSizes = new Set<string>();
  input.size_rows.forEach((row, index) => {
    const size = normalizeSizeCode(row.size_code);
    if (!size.ok) {
      issues.push({ field: `size_chart.items[${index}].sku_size_code`, message: size.reason });
      return;
    }
    if (chartSizes.has(size.sizeCode)) {
      issues.push({ field: `size_chart.items[${index}].sku_size_code`, message: `尺码重复：${size.sizeCode}` });
    }
    chartSizes.add(size.sizeCode);
    const measurements: Record<string, number> = {};
    let count = 0;
    for (const column of MEASUREMENT_COLUMNS) {
      const raw = row.measurements[column];
      if (raw === undefined || raw.trim() === '') continue;
      const value = Number(raw);
      if (!isHalfStep(value)) {
        issues.push({
          field: `size_chart.items[${index}].measurements.${column}`,
          message: `${column} 必须是 0.5 的倍数且 ≤250`,
        });
        continue;
      }
      measurements[column] = value;
      count += 1;
    }
    if (count < 2) {
      issues.push({ field: `size_chart.items[${index}].measurements`, message: '每个尺码至少填写 2 个测量值' });
    }
    const heightMin = row.height_min.trim() ? Number(row.height_min) : undefined;
    const heightMax = row.height_max.trim() ? Number(row.height_max) : undefined;
    const weightMin = row.weight_min.trim() ? Number(row.weight_min) : undefined;
    const weightMax = row.weight_max.trim() ? Number(row.weight_max) : undefined;
    if ((heightMin === undefined) !== (heightMax === undefined)) {
      issues.push({ field: `size_chart.items[${index}].recommend_height`, message: '建议身高必须成对填写' });
    }
    if ((weightMin === undefined) !== (weightMax === undefined)) {
      issues.push({ field: `size_chart.items[${index}].recommend_weight`, message: '建议体重必须成对填写' });
    }
    if (heightMin !== undefined && heightMax !== undefined && heightMax <= heightMin) {
      issues.push({ field: `size_chart.items[${index}].recommend_height`, message: '建议身高上限必须大于下限' });
    }
    if (weightMin !== undefined && weightMax !== undefined && weightMax <= weightMin) {
      issues.push({ field: `size_chart.items[${index}].recommend_weight`, message: '建议体重上限必须大于下限' });
    }
    chartItems.push({
      sku_size_code: size.sizeCode,
      measurements,
      ...(heightMin !== undefined && heightMax !== undefined
        ? { recommend_height_min: heightMin, recommend_height_max: heightMax }
        : {}),
      ...(weightMin !== undefined && weightMax !== undefined
        ? { recommend_weight_min: weightMin, recommend_weight_max: weightMax }
        : {}),
    });
  });
  if (input.size_rows.length === 0) issues.push({ field: 'size_chart', message: '必须提供尺码表（后端要求 SKU 尺码已生效）' });
  for (const size of skuSizes) {
    if (!chartSizes.has(size)) {
      issues.push({ field: 'size_chart', message: `SKU 尺码「${size}」缺少尺码表数据` });
    }
  }
  if (!/^\d{4}-\d{2}-\d{2}/.test(input.effective_from)) {
    issues.push({ field: 'size_chart.effective_from', message: '生效日期格式如 2026-10-20' });
  }

  if (issues.length > 0) return { issues };

  return {
    issues,
    payload: {
      spu_code: spu,
      name: input.name.trim(),
      category_code: category,
      ...(input.fit ? { fit: input.fit as ProductCreateInput['fit'] } : {}),
      ...(input.brand.trim() ? { brand: input.brand.trim() } : {}),
      ...(input.season ? { season: input.season as ProductCreateInput['season'] } : {}),
      ...(input.description.trim() ? { description: input.description.trim() } : {}),
      skus: skuPayload,
      fabric: {
        materials,
        fabric_code: input.fabric_code.trim() || 'MAIN',
        fabric_name: input.fabric_name.trim() || '主料',
        role: input.fabric_role as 'main' | 'lining' | 'trim' | 'accessory',
        source: 'manual',
      },
      size_chart: {
        version_no: 1,
        size_system: input.size_system as 'alpha' | 'numeric' | 'height_weight' | 'one_size',
        effective_from: input.effective_from,
        source: 'manual',
        items: chartItems,
      },
    },
  };
}

export function ProductCreateView() {
  const router = useRouter();
  const [spu, setSpu] = useState('');
  const [name, setName] = useState('');
  const [category, setCategory] = useState('');
  const [fit, setFit] = useState('');
  const [brand, setBrand] = useState('');
  const [season, setSeason] = useState('');
  const [description, setDescription] = useState('');
  const [skus, setSkus] = useState<SkuDraft[]>([{ ...EMPTY_SKU }]);
  const [materials, setMaterials] = useState<MaterialDraft[]>([
    { material: '棉', percent: '100', note: '主料' },
  ]);
  const [fabricCode, setFabricCode] = useState('MAIN');
  const [fabricName, setFabricName] = useState('主料');
  const [fabricRole, setFabricRole] = useState<'main' | 'lining' | 'trim' | 'accessory'>('main');
  const [effectiveFrom, setEffectiveFrom] = useState(defaultEffectiveFrom());
  const [sizeSystem, setSizeSystem] = useState('alpha');
  const [sizeRows, setSizeRows] = useState<SizeDraft[]>([{ ...EMPTY_SIZE }]);
  const [issues, setIssues] = useState<IssueLike[]>([]);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const updateSku = (index: number, patch: Partial<SkuDraft>) => {
    setSkus((previous) => previous.map((sku, i) => (i === index ? { ...sku, ...patch } : sku)));
  };
  const updateMaterial = (index: number, patch: Partial<MaterialDraft>) => {
    setMaterials((previous) =>
      previous.map((material, i) => (i === index ? { ...material, ...patch } : material)),
    );
  };
  const updateSize = (index: number, patch: Partial<SizeDraft>) => {
    setSizeRows((previous) => previous.map((row, i) => (i === index ? { ...row, ...patch } : row)));
  };
  const updateMeasurement = (index: number, column: string, value: string) => {
    setSizeRows((previous) =>
      previous.map((row, i) =>
        i === index ? { ...row, measurements: { ...row.measurements, [column]: value } } : row,
      ),
    );
  };

  const syncSizesFromSkus = () => {
    const sizes: string[] = [];
    for (const sku of skus) {
      const normalized = normalizeSizeCode(sku.size_code);
      if (normalized.ok && !sizes.includes(normalized.sizeCode)) sizes.push(normalized.sizeCode);
    }
    if (sizes.length === 0) return;
    setSizeRows((previous) => {
      const existing = new Set(previous.map((row) => row.size_code.trim().toUpperCase()));
      const additions = sizes
        .filter((size) => !existing.has(size))
        .map((size) => ({ ...EMPTY_SIZE, size_code: size, measurements: {} }));
      return [...previous.filter((row) => row.size_code.trim() || Object.keys(row.measurements).length > 0), ...additions];
    });
  };

  const totalPercent = materials.reduce((sum, material) => sum + (Number(material.percent) || 0), 0);

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setSubmitError(null);
    const built = buildPayload({
      spu_code: spu,
      name,
      category_code: category,
      fit,
      brand,
      season,
      description,
      skus,
      materials,
      fabric_code: fabricCode,
      fabric_name: fabricName,
      fabric_role: fabricRole,
      effective_from: effectiveFrom,
      size_system: sizeSystem,
      size_rows: sizeRows,
    });
    setIssues(built.issues);
    if (!built.payload) {
      window.scrollTo({ top: 0, behavior: 'smooth' });
      return;
    }
    setSubmitting(true);
    try {
      const created = await createProduct(built.payload);
      router.push(`/products/${created.id}`);
    } catch (caught: unknown) {
      if (isApiFailure(caught)) {
        if (caught.status === 401) {
          redirectToLogin();
          return;
        }
        if (caught.code === 'conflict') {
          setSubmitError('SPU 已存在（409 conflict）。请更换 SPU 编码后重试。');
          return;
        }
        setIssues(issuesFromFailure(caught));
        setSubmitError(caught.status === 422 ? null : caught.message);
        window.scrollTo({ top: 0, behavior: 'smooth' });
        return;
      }
      setSubmitError('无法创建商品：网络错误');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <form className={m3.pageStack} onSubmit={(event) => void submit(event)} noValidate>
      <div className={styles.backRow}>
        <Link className={styles.backLink} href="/products">
          <Icon name="arrowLeft" size={15} />
          返回商品库
        </Link>
        <span className="badge badgeM1">M3 · 新建</span>
      </div>

      <div>
        <h1 className={styles.detailTitle}>新建商品</h1>
        <p className={styles.detailMeta}>
          创建后不可在此页编辑基本信息（后端暂无 PATCH）；尺码表为必填，SKU 尺码必须先在尺码表中存在。
        </p>
      </div>

      {submitError ? <InlineAlert tone="error">{submitError}</InlineAlert> : null}
      {issues.length > 0 ? <ValidationList issues={issues} /> : null}

      <SectionCard title="基本信息" description="编码规则与后端一致；灰色提示不替代服务端校验。">
        <div className={styles.formGrid}>
          <Field label="SPU 编码" htmlFor="spu" required hint="形如 SPU-2026-001；^[A-Z0-9][A-Z0-9-]{3,39}$">
            <input
              id="spu"
              className={m3.input}
              value={spu}
              onChange={(event) => setSpu(event.target.value.toUpperCase())}
              placeholder="SPU-2026-001"
              required
            />
          </Field>
          <Field label="商品名称" htmlFor="name" required hint="1–120 字">
            <input
              id="name"
              className={m3.input}
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder="双面穿风衣"
              required
            />
          </Field>
          <Field label="类目编码" htmlFor="category" required hint="形如 A0101 或 A0101.001">
            <input
              id="category"
              className={m3.input}
              value={category}
              onChange={(event) => setCategory(event.target.value.toUpperCase())}
              placeholder="A0101"
              required
            />
          </Field>
          <Field label="版型 fit" htmlFor="fit">
            <select id="fit" className={m3.select} value={fit} onChange={(event) => setFit(event.target.value)}>
              <option value="">未填</option>
              <option value="slim">slim</option>
              <option value="regular">regular</option>
              <option value="loose">loose</option>
              <option value="oversize">oversize</option>
            </select>
          </Field>
          <Field label="品牌" htmlFor="brand">
            <input id="brand" className={m3.input} value={brand} onChange={(event) => setBrand(event.target.value)} />
          </Field>
          <Field label="季节" htmlFor="season">
            <select
              id="season"
              className={m3.select}
              value={season}
              onChange={(event) => setSeason(event.target.value)}
            >
              <option value="">未填</option>
              <option value="spring">春</option>
              <option value="summer">夏</option>
              <option value="autumn">秋</option>
              <option value="winter">冬</option>
              <option value="all">四季</option>
            </select>
          </Field>
        </div>
        <div style={{ marginTop: 12 }}>
          <Field label="描述" htmlFor="description" hint="最多 2000 字">
            <textarea
              id="description"
              className={`${m3.textarea}`}
              value={description}
              onChange={(event) => setDescription(event.target.value)}
            />
          </Field>
        </div>
      </SectionCard>

      <SectionCard
        title={`SKU（${skus.length}）`}
        description="色卡编码会归一（bk0101 → BK-0101）；价格以元输入，提交时转整数分。"
        extra={
          <div className={m3.inlineActions}>
            <button type="button" className="buttonSecondary" onClick={syncSizesFromSkus}>
              从 SKU 同步尺码
            </button>
            <button
              type="button"
              className="buttonSecondary"
              onClick={() => setSkus((previous) => [...previous, { ...EMPTY_SKU }])}
            >
              <Icon name="product" size={14} /> 添加 SKU
            </button>
          </div>
        }
      >
        <div className={styles.skuEditor}>
          <div className={styles.skuHead}>
            <span>色卡 ID*</span>
            <span>色名</span>
            <span>尺码*</span>
            <span>售价(元)*</span>
            <span>划线价(元)</span>
            <span>促销价(元)</span>
            <span>库存</span>
            <span>起批</span>
            <span>面料编码</span>
            <span />
          </div>
          {skus.map((sku, index) => (
            <div className={styles.skuRow} key={`sku-${index}`}>
              <input
                aria-label={`SKU ${index + 1} 色卡 ID`}
                value={sku.color_id}
                onChange={(event) => updateSku(index, { color_id: event.target.value.toUpperCase() })}
                placeholder="BK0101"
              />
              <input
                aria-label={`SKU ${index + 1} 色名`}
                value={sku.color_name}
                onChange={(event) => updateSku(index, { color_name: event.target.value })}
                placeholder="黑"
              />
              <input
                aria-label={`SKU ${index + 1} 尺码`}
                value={sku.size_code}
                onChange={(event) => updateSku(index, { size_code: event.target.value.toUpperCase() })}
                placeholder="M"
              />
              <input
                aria-label={`SKU ${index + 1} 售价`}
                value={sku.price_yuan}
                onChange={(event) => updateSku(index, { price_yuan: event.target.value })}
                placeholder="399.00"
                inputMode="decimal"
              />
              <input
                aria-label={`SKU ${index + 1} 划线价`}
                value={sku.list_price_yuan}
                onChange={(event) => updateSku(index, { list_price_yuan: event.target.value })}
                placeholder="499.00"
                inputMode="decimal"
              />
              <input
                aria-label={`SKU ${index + 1} 促销价`}
                value={sku.sale_price_yuan}
                onChange={(event) => updateSku(index, { sale_price_yuan: event.target.value })}
                placeholder="—"
                inputMode="decimal"
              />
              <input
                aria-label={`SKU ${index + 1} 库存`}
                value={sku.stock_qty}
                onChange={(event) => updateSku(index, { stock_qty: event.target.value })}
                inputMode="numeric"
              />
              <input
                aria-label={`SKU ${index + 1} 起批量`}
                value={sku.min_order_qty}
                onChange={(event) => updateSku(index, { min_order_qty: event.target.value })}
                inputMode="numeric"
              />
              <input
                aria-label={`SKU ${index + 1} 面料编码`}
                value={sku.fabric_code}
                onChange={(event) => updateSku(index, { fabric_code: event.target.value.toUpperCase() })}
              />
              <button
                type="button"
                className={styles.rowDelete}
                aria-label={`删除 SKU ${index + 1}`}
                onClick={() => setSkus((previous) => previous.filter((_, i) => i !== index))}
                disabled={skus.length <= 1}
              >
                <Icon name="close" size={15} />
              </button>
            </div>
          ))}
        </div>
      </SectionCard>

      <SectionCard
        title="面料成分"
        description="1–8 条，纤维必须在标准词表；占比为 1–100 整数、按降序、合计必须 100。"
        extra={
          <div className={styles.totalMeter}>
            <span>合计</span>
            <span className={totalPercent === 100 ? styles.totalOk : styles.totalBad}>{totalPercent}%</span>
            <button
              type="button"
              className="buttonSecondary"
              onClick={() =>
                setMaterials((previous) => [...previous, { material: '棉', percent: '', note: '主料' }])
              }
            >
              添加成分
            </button>
          </div>
        }
      >
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          <div className={styles.materialRow}>
            <span className={m3.muted}>纤维</span>
            <span className={m3.muted}>占比 %</span>
            <span className={m3.muted}>部位/备注</span>
            <span className={m3.muted}>fabric_code / fabric_name / role 见下方</span>
            <span />
          </div>
          {materials.map((material, index) => (
            <div className={styles.materialRow} key={`material-${index}`}>
              <select
                aria-label={`成分 ${index + 1} 纤维`}
                value={material.material}
                onChange={(event) => updateMaterial(index, { material: event.target.value })}
              >
                {FIBERS.map((fiber) => (
                  <option key={fiber} value={fiber}>
                    {fiber}
                  </option>
                ))}
              </select>
              <input
                aria-label={`成分 ${index + 1} 占比`}
                value={material.percent}
                onChange={(event) => updateMaterial(index, { percent: event.target.value })}
                inputMode="numeric"
                placeholder="80"
              />
              <select
                aria-label={`成分 ${index + 1} 备注`}
                value={material.note}
                onChange={(event) => updateMaterial(index, { note: event.target.value })}
              >
                {NOTE_OPTIONS.map((note) => (
                  <option key={note} value={note}>
                    {note}
                  </option>
                ))}
              </select>
              <span className={m3.muted}>主料 MAIN / 主料</span>
              <button
                type="button"
                className={styles.rowDelete}
                aria-label={`删除成分 ${index + 1}`}
                onClick={() => setMaterials((previous) => previous.filter((_, i) => i !== index))}
                disabled={materials.length <= 1}
              >
                <Icon name="close" size={15} />
              </button>
            </div>
          ))}
        </div>
        <div className={styles.formGrid3} style={{ marginTop: 12 }}>
          <Field label="fabric_code" htmlFor="fabric-code" hint="2–16 位大写字母/数字/连字符">
            <input
              id="fabric-code"
              className={m3.input}
              value={fabricCode}
              onChange={(event) => setFabricCode(event.target.value.toUpperCase())}
            />
          </Field>
          <Field label="fabric_name" htmlFor="fabric-name">
            <input
              id="fabric-name"
              className={m3.input}
              value={fabricName}
              onChange={(event) => setFabricName(event.target.value)}
            />
          </Field>
          <Field label="role" htmlFor="fabric-role">
            <select
              id="fabric-role"
              className={m3.select}
              value={fabricRole}
              onChange={(event) => setFabricRole(event.target.value as typeof fabricRole)}
            >
              <option value="main">main 主料</option>
              <option value="lining">lining 里料</option>
              <option value="trim">trim 辅料</option>
              <option value="accessory">accessory 装饰</option>
            </select>
          </Field>
        </div>
      </SectionCard>

      <SectionCard
        title={`尺码表（${sizeRows.length} 个尺码）`}
        description="一个商品一个生效版本；每行一个尺码，至少 2 个测量值，0.5 步进且 ≤250cm。必测部位由类目决定，服务端最终校验。"
        extra={
          <div className={m3.inlineActions}>
            <button type="button" className="buttonSecondary" onClick={syncSizesFromSkus}>
              从 SKU 同步
            </button>
            <button
              type="button"
              className="buttonSecondary"
              onClick={() => setSizeRows((previous) => [...previous, { ...EMPTY_SIZE, measurements: {} }])}
            >
              添加尺码
            </button>
          </div>
        }
      >
        <div className={styles.formGrid3} style={{ marginBottom: 12 }}>
          <Field label="生效日期" htmlFor="effective-from" required>
            <input
              id="effective-from"
              className={m3.input}
              type="date"
              value={effectiveFrom}
              onChange={(event) => setEffectiveFrom(event.target.value)}
            />
          </Field>
          <Field label="尺码体系" htmlFor="size-system">
            <select
              id="size-system"
              className={m3.select}
              value={sizeSystem}
              onChange={(event) => setSizeSystem(event.target.value)}
            >
              {SIZE_SYSTEMS.map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </select>
          </Field>
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          {sizeRows.map((row, index) => (
            <div className={styles.sizeRow} key={`size-${index}`}>
              <div className={styles.sizeRowHead}>
                <Field label="尺码" htmlFor={`size-code-${index}`}>
                  <input
                    id={`size-code-${index}`}
                    className={m3.input}
                    style={{ width: 110 }}
                    value={row.size_code}
                    onChange={(event) => updateSize(index, { size_code: event.target.value.toUpperCase() })}
                    placeholder="M"
                  />
                </Field>
                <span className={m3.muted}>测量值（cm，可空）</span>
                <button
                  type="button"
                  className={`${styles.rowDelete} ${m3.right}`}
                  aria-label={`删除尺码 ${index + 1}`}
                  onClick={() => setSizeRows((previous) => previous.filter((_, i) => i !== index))}
                  disabled={sizeRows.length <= 1}
                >
                  <Icon name="close" size={15} />
                </button>
              </div>
              <div className={styles.sizeMeasureGrid}>
                {MEASUREMENT_COLUMNS.map((column) => (
                  <label key={column}>
                    {column}
                    <input
                      aria-label={`${row.size_code || index} ${column}`}
                      value={row.measurements[column] ?? ''}
                      onChange={(event) => updateMeasurement(index, column, event.target.value)}
                      inputMode="decimal"
                      placeholder="—"
                    />
                  </label>
                ))}
              </div>
              <div className={styles.sizeMeasureGrid} style={{ marginTop: 8 }}>
                <label>
                  建议身高 min
                  <input
                    value={row.height_min}
                    onChange={(event) => updateSize(index, { height_min: event.target.value })}
                    inputMode="numeric"
                  />
                </label>
                <label>
                  建议身高 max
                  <input
                    value={row.height_max}
                    onChange={(event) => updateSize(index, { height_max: event.target.value })}
                    inputMode="numeric"
                  />
                </label>
                <label>
                  建议体重 min
                  <input
                    value={row.weight_min}
                    onChange={(event) => updateSize(index, { weight_min: event.target.value })}
                    inputMode="numeric"
                  />
                </label>
                <label>
                  建议体重 max
                  <input
                    value={row.weight_max}
                    onChange={(event) => updateSize(index, { weight_max: event.target.value })}
                    inputMode="numeric"
                  />
                </label>
              </div>
            </div>
          ))}
        </div>
      </SectionCard>

      <div className={styles.stickyFoot}>
        <span className={styles.helperNote}>
          提交前仅做前端提示；最终以服务端强校验为准。创建成功后跳转详情。
        </span>
        <div className={m3.inlineActions}>
          <Link className="buttonSecondary" href="/products">
            取消
          </Link>
          <button type="submit" className="buttonPrimary" disabled={submitting}>
            {submitting ? <Spinner label="创建中" /> : '创建商品'}
          </button>
        </div>
      </div>
    </form>
  );
}
