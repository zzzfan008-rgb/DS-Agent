/**
 * 服装强类型 JSON Schema（docs/06 §6；docs/19）。
 * 真源只在这里，api / worker / 前端表单共用；不允许各端另写一份。
 * 注意：金额单位按 docs/21 用「分」，FactEnvelope 的 unit 用 `cent`（不是已废止的微元写法）。
 */

export const SIZE_CHART_V1 = {
  $id: 'https://dssaas.local/schema/size-chart/v1.json',
  type: 'object',
  additionalProperties: false,
  required: ['version_no', 'size_system', 'unit', 'effective_from', 'source', 'sizes'],
  properties: {
    version_no: { type: 'integer', minimum: 1, maximum: 999 },
    size_system: { enum: ['alpha', 'numeric', 'height_weight', 'one_size'] },
    unit: { const: 'cm' },
    effective_from: { type: 'string', minLength: 8 },
    effective_to: { type: ['string', 'null'] },
    source: { enum: ['import', 'erp', 'manual', 'platform_sync', 'supplier'] },
    fit_note: { type: 'string', maxLength: 200 },
    sizes: {
      type: 'array',
      minItems: 1,
      maxItems: 30,
      items: { $ref: '#/$defs/size' },
    },
  },
  allOf: [
    {
      if: {
        properties: { size_system: { const: 'one_size' } },
        required: ['size_system'],
      },
      then: { properties: { sizes: { maxItems: 1 } } },
    },
    {
      if: {
        properties: { size_system: { const: 'height_weight' } },
        required: ['size_system'],
      },
      then: {
        properties: {
          sizes: {
            items: {
              required: [
                'recommend_height_min',
                'recommend_height_max',
                'recommend_weight_min',
                'recommend_weight_max',
              ],
            },
          },
        },
      },
    },
  ],
  $defs: {
    size: {
      type: 'object',
      additionalProperties: false,
      required: ['sku_size_code', 'size_order', 'measurements'],
      properties: {
        sku_size_code: {
          type: 'string',
          pattern: '^(XXXS|XXS|XS|S|M|L|XL|XXL|XXXL|4XL|5XL|[0-9]{2,3}|ONE)$',
        },
        size_order: { type: 'integer', minimum: 0, maximum: 99 },
        measurements: { $ref: '#/$defs/measurements' },
        recommend_height_min: { type: 'integer', minimum: 100, maximum: 230 },
        recommend_height_max: { type: 'integer', minimum: 100, maximum: 230 },
        recommend_weight_min: { type: 'integer', minimum: 25, maximum: 200 },
        recommend_weight_max: { type: 'integer', minimum: 25, maximum: 200 },
        extra_measures: {
          type: 'object',
          maxProperties: 6,
          additionalProperties: { $ref: '#/$defs/cm' },
          propertyNames: { pattern: '^[\\u4e00-\\u9fa5]{2,6}$' },
        },
      },
      dependentSchemas: {
        recommend_height_min: { required: ['recommend_height_max'] },
        recommend_weight_min: { required: ['recommend_weight_max'] },
      },
    },
    measurements: {
      type: 'object',
      additionalProperties: false,
      minProperties: 2,
      properties: {
        衣长: { $ref: '#/$defs/cm' },
        胸围: { $ref: '#/$defs/cm' },
        肩宽: { $ref: '#/$defs/cm' },
        袖长: { $ref: '#/$defs/cm' },
        腰围: { $ref: '#/$defs/cm' },
        臀围: { $ref: '#/$defs/cm' },
        下摆: { $ref: '#/$defs/cm' },
        裙长: { $ref: '#/$defs/cm' },
        裤长: { $ref: '#/$defs/cm' },
        脚口: { $ref: '#/$defs/cm' },
        大腿围: { $ref: '#/$defs/cm' },
        领围: { $ref: '#/$defs/cm' },
      },
    },
    cm: {
      type: 'number',
      exclusiveMinimum: 0,
      maximum: 250,
      multipleOf: 0.5,
    },
  },
} as const;

export const FABRIC_COMPOSITION_V1 = {
  $id: 'https://dssaas.local/schema/fabric-composition/v1.json',
  type: 'array',
  minItems: 1,
  maxItems: 8,
  items: {
    type: 'object',
    additionalProperties: false,
    required: ['material', 'percent'],
    properties: {
      material: {
        enum: [
          '棉', '聚酯纤维', '锦纶', '氨纶', '粘纤', '莫代尔纤维',
          '莱赛尔纤维', '醋酯纤维', '腈纶', '羊毛', '羊绒', '桑蚕丝',
          '亚麻', '苎麻', '真丝', '再生纤维素纤维', '铜氨纤维',
          '芳纶', '弹性纤维', '金属纤维',
        ],
      },
      percent: { type: 'integer', minimum: 1, maximum: 100 },
      note: { enum: ['主料', '辅料', '里料', '填充', '装饰'] },
      fiber_code: { type: 'string', pattern: '^[A-Z]{2,6}$' },
    },
  },
} as const;

export const PLATFORM_ATTRIBUTE_MAPPING_V1 = {
  $id: 'https://dssaas.local/schema/platform-attribute-mapping/v1.json',
  type: 'object',
  additionalProperties: false,
  required: [
    'platform',
    'platform_category_id',
    'attr_path',
    'attr_type',
    'internal_field',
    'internal_value',
    'source',
  ],
  properties: {
    platform: { enum: ['pdd', '1688'] },
    platform_category_id: { type: 'string', minLength: 36, maxLength: 36 },
    product_id: { type: ['string', 'null'] },
    sku_id: { type: ['string', 'null'] },
    attr_path: { type: 'string', pattern: '^[a-z][a-z0-9_.]{1,63}$' },
    attr_type: { enum: ['enum', 'text', 'number', 'bool', 'range', 'multi_enum'] },
    internal_field: {
      type: 'string',
      pattern: '^(product|product_sku|size_chart|fabric_composition)\\.[a-z_]+$',
    },
    internal_value: { type: 'string', minLength: 1, maxLength: 128 },
    platform_value_id: { type: ['string', 'null'], maxLength: 64 },
    platform_value_name: { type: ['string', 'null'], maxLength: 128 },
    extra: {
      type: 'object',
      maxProperties: 20,
      additionalProperties: { type: ['string', 'number', 'boolean'] },
    },
    status: { enum: ['draft', 'verified', 'stale'] },
    source: { enum: ['import', 'erp', 'manual', 'platform_sync', 'supplier'] },
  },
  allOf: [
    {
      anyOf: [
        { properties: { product_id: { type: 'string' } }, required: ['product_id'] },
        { properties: { sku_id: { type: 'string' } }, required: ['sku_id'] },
      ],
    },
    {
      if: { properties: { attr_type: { const: 'range' } }, required: ['attr_type'] },
      then: {
        required: ['extra'],
        properties: {
          extra: {
            required: ['min', 'max'],
            properties: {
              min: { type: 'number' },
              max: { type: 'number' },
              unit: { enum: ['cm', 'kg', 'g', 'day'] },
            },
          },
        },
      },
    },
    {
      if: {
        properties: { attr_type: { enum: ['enum', 'multi_enum'] } },
        required: ['attr_type'],
      },
      then: { required: ['platform_value_id'] },
    },
  ],
} as const;

export const FACT_ENVELOPE_V1 = {
  $id: 'https://dssaas.local/schema/fact-envelope/v1.json',
  type: 'object',
  additionalProperties: false,
  required: ['facts_version', 'captured_at', 'items', 'facts_hash'],
  properties: {
    facts_version: { const: 1 },
    captured_at: { type: 'string', minLength: 20 },
    facts_hash: { type: 'string', pattern: '^[0-9a-f]{64}$' },
    items: {
      type: 'array',
      minItems: 1,
      maxItems: 40,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['key', 'value', 'source', 'source_table', 'source_id', 'source_version'],
        properties: {
          key: {
            enum: [
              'price', 'promo_price', 'stock', 'composition', 'size', 'policy',
              'qualification', 'lead_time', 'moq', 'after_sale', 'care',
            ],
          },
          value: { type: ['string', 'number', 'boolean'] },
          unit: { enum: ['cent', 'piece', 'percent', 'cm', 'day', 'text'] },
          source: { enum: ['import', 'erp', 'manual', 'platform_sync', 'supplier', 'kb'] },
          source_table: {
            enum: [
              'product', 'product_sku', 'size_chart', 'fabric_composition',
              'platform_category', 'kb_document',
            ],
          },
          source_id: { type: 'string', minLength: 36, maxLength: 36 },
          source_version: { type: 'integer', minimum: 1 },
          effective_from: { type: ['string', 'null'] },
          quote: { type: ['string', 'null'], maxLength: 300 },
        },
      },
    },
  },
} as const;

export const PRICE_TIERS_V1 = {
  $id: 'https://dssaas.local/schema/price-tiers/v1.json',
  type: 'array',
  maxItems: 5,
  items: {
    type: 'object',
    additionalProperties: false,
    required: ['min_qty', 'price_cents'],
    properties: {
      min_qty: { type: 'integer', minimum: 1, maximum: 99999 },
      price_cents: { type: 'integer', minimum: 1 },
      max_qty: { type: ['integer', 'null'], minimum: 1 },
    },
  },
} as const;
