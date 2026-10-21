/**
 * L1 确定性规则引擎（docs/08 §3/§4/§6）。
 *
 * 纯函数：不访问 DB/网络；事实由编排层预装为 JudgeFacts。
 * 每条命中必须带 rule_id + severity + field='text' + span（原文偏移）+ matched + suggestion。
 * 规则内部异常记录到 errors；编排层看到 errors 必须 escalate（不允许“规则崩了放行”）。
 */
import type {
  JudgeContentType,
  JudgeFacts,
  JudgeInput,
  L1Hit,
  L1Result,
  Platform,
  Severity,
} from './types.js';
import { LEXICON_VERSION, RULE_SET_VERSION, maxSeverity } from './types.js';
import { normalizeText, spanToOriginal, type NormalizedText } from './normalize.js';
import { DEFAULT_NEGATION_WINDOW, detectNegation } from './negation.js';

interface RuleContext {
  input: JudgeInput;
  normalized: NormalizedText;
  originalLength: number;
}

interface Rule {
  id: string;
  severity: Severity;
  platforms: Platform[] | 'all';
  contentTypes: JudgeContentType[] | 'all';
  suggestion: string;
  evaluate(context: RuleContext): L1Hit[];
}

const ALL: 'all' = 'all';

function applies(rule: Rule, input: JudgeInput): boolean {
  if (rule.platforms !== ALL && !rule.platforms.includes(input.platform)) return false;
  if (rule.contentTypes !== ALL && !rule.contentTypes.includes(input.content_type)) return false;
  return true;
}

/**
 * 否定语境降级（t42）：命中词处于否定语境时 severity → info，保留命中记录与 span。
 *
 * 只对「承诺类」规则开启（POL/REP/STK/LEX-003）：这些规则的违规本质是**做出承诺**，
 * 而「不能承诺当天发货」是正确话术。
 *
 * L0 法定/平台绝对禁词（LEX-001 极限词、LEX-002 医疗功效、LEX-005 联系方式、
 * LEX-006 站外交易、LEX-007 平台敏感词）**不豁免**：平台机审不识别否定语境，
 * 文案里出现该词即被拦截，正确做法是改写为不含该词的表述（docs/08 §5.1）。
 */
const NEGATION_AWARE = new Set([
  'L1-LEX-003',
  'L1-STK-001',
  'L1-POL-001',
  'L1-POL-002',
  'L1-REP-001',
  'L1-REP-002',
]);

function negationWindowFor(ruleId: string): number | null {
  return NEGATION_AWARE.has(ruleId) ? DEFAULT_NEGATION_WINDOW : null;
}

function termHits(
  context: RuleContext,
  terms: string[],
  ruleId: string,
  severity: Severity,
  suggestion: string,
): L1Hit[] {
  const hits: L1Hit[] = [];
  const negationWindow = negationWindowFor(ruleId);
  for (const term of terms) {
    let from = 0;
    for (;;) {
      const index = context.normalized.normalized.indexOf(term, from);
      if (index < 0) break;
      const span = spanToOriginal(
        context.normalized.map,
        index,
        index + term.length,
        context.originalLength,
      );
      const negation =
        negationWindow === null
          ? null
          : detectNegation(context.normalized.normalized, index, negationWindow);
      hits.push({
        rule_id: ruleId,
        severity: negation?.negated ? 'info' : severity,
        field: 'text',
        span,
        matched: context.input.text.slice(span[0], span[1]),
        suggestion,
        ...(negation?.negated ? { negated: true, negation_marker: negation.marker } : {}),
      });
      from = index + term.length;
    }
  }
  return hits;
}

function regexHits(
  context: RuleContext,
  regex: RegExp,
  ruleId: string,
  severity: Severity,
  suggestion: string,
  accept?: (match: RegExpExecArray) => boolean,
): L1Hit[] {
  const hits: L1Hit[] = [];
  const negationWindow = negationWindowFor(ruleId);
  const global = new RegExp(regex.source, regex.flags.includes('g') ? regex.flags : `${regex.flags}g`);
  let match: RegExpExecArray | null;
  while ((match = global.exec(context.normalized.normalized)) !== null) {
    if (accept && !accept(match)) continue;
    const span = spanToOriginal(
      context.normalized.map,
      match.index,
      match.index + match[0].length,
      context.originalLength,
    );
    const negation =
      negationWindow === null
        ? null
        : detectNegation(context.normalized.normalized, match.index, negationWindow);
    hits.push({
      rule_id: ruleId,
      severity: negation?.negated ? 'info' : severity,
      field: 'text',
      span,
      matched: context.input.text.slice(span[0], span[1]) || match[0],
      suggestion,
      ...(negation?.negated ? { negated: true, negation_marker: negation.marker } : {}),
    });
    if (match[0].length === 0) global.lastIndex += 1;
  }
  return hits;
}

function yuanToCents(value: string): number {
  return Math.round(Number(value) * 100);
}

function allowedPrices(facts: JudgeFacts): Set<number> {
  const values = new Set<number>();
  for (const value of [facts.price_cents, facts.promo_price_cents, facts.min_price_cents]) {
    if (typeof value === 'number') values.add(value);
  }
  for (const tier of facts.price_tiers ?? []) {
    if (typeof tier.price_cents === 'number') values.add(tier.price_cents);
  }
  return values;
}

const STANDARD_FIBERS = [
  '棉', '聚酯纤维', '锦纶', '氨纶', '粘纤', '莫代尔纤维', '莱赛尔纤维',
  '醋酯纤维', '腈纶', '羊毛', '羊绒', '桑蚕丝', '亚麻', '苎麻', '真丝',
  '再生纤维素纤维', '铜氨纤维', '芳纶', '弹性纤维', '金属纤维',
];

const FIBER_ALIASES = ['涤纶', '聚酯', '尼龙', '莱卡', '人造棉', '天丝', '莫代尔', '山羊绒', '精梳棉', '有机棉'];

const MEASUREMENT_PARTS = [
  '衣长', '胸围', '肩宽', '袖长', '腰围', '臀围', '下摆',
  '裙长', '裤长', '脚口', '大腿围', '领围',
];

const RULES: Rule[] = [
  {
    id: 'L1-LEX-001',
    severity: 'blocker',
    platforms: ALL,
    contentTypes: ['title', 'selling_points', 'detail', 'faq'],
    suggestion: '删除极限词，改为可验证的客观表述',
    evaluate: (context) =>
      termHits(
        context,
        ['全网最低', '最低价', '史上最低', '绝无仅有', '国家级', '第一品牌', '顶级', '极致', '唯一', '首个', '最好'],
        'L1-LEX-001',
        'blocker',
        '删除极限词，改为可验证的客观表述',
      ),
  },
  {
    id: 'L1-LEX-002',
    severity: 'blocker',
    platforms: ALL,
    contentTypes: ALL,
    suggestion: '删除医疗/功效宣称',
    evaluate: (context) =>
      termHits(
        context,
        ['治疗', '消炎', '抗癌', '降血压', '减肥', '丰胸', '祛痘', '杀菌率99', '杀菌率 99'],
        'L1-LEX-002',
        'blocker',
        '删除医疗/功效宣称；功能性描述改为面料物理指标',
      ),
  },
  {
    id: 'L1-LEX-003',
    severity: 'high',
    platforms: ALL,
    contentTypes: ALL,
    suggestion: '删除无检测报告支撑的绝对承诺',
    evaluate: (context) =>
      termHits(
        context,
        ['100%不掉色', '100%不褪色', '零甲醛', '永不缩水', '绝对不起球', '永不褪色'],
        'L1-LEX-003',
        'high',
        '改为“经检测色牢度 4 级”等可验证表述，或删除',
      ),
  },
  {
    id: 'L1-LEX-005',
    severity: 'blocker',
    platforms: ALL,
    contentTypes: ALL,
    suggestion: '删除联系方式/站外引流',
    evaluate: (context) =>
      termHits(
        context,
        ['微信', '加v', '加V', 'qq', 'QQ', '二维码', '私信我', '手机号'],
        'L1-LEX-005',
        'blocker',
        '删除；客服沟通走平台通道',
      ),
  },
  {
    id: 'L1-LEX-006',
    severity: 'blocker',
    platforms: ALL,
    contentTypes: ALL,
    suggestion: '删除站外交易引导',
    evaluate: (context) =>
      termHits(
        context,
        ['私下转账', '线下付款', '绕过平台', '私下交易'],
        'L1-LEX-006',
        'blocker',
        '删除；报价与成交走平台',
      ),
  },
  {
    id: 'L1-LEX-007',
    severity: 'blocker',
    platforms: ALL,
    contentTypes: ALL,
    suggestion: '删除平台敏感词',
    evaluate: (context) =>
      termHits(
        context,
        ['刷单', '返现', '好评返现', '原单', '尾单', '高仿', '复刻'],
        'L1-LEX-007',
        'blocker',
        '删除平台敏感词',
      ),
  },
  {
    id: 'L1-TXT-001',
    severity: 'medium',
    platforms: ALL,
    contentTypes: ['title'],
    suggestion: '按平台标题规范裁剪，去除表情符号',
    evaluate: (context) => {
      const hits: L1Hit[] = [];
      const limit = context.input.platform === 'pdd' ? 60 : 60;
      if (context.input.text.length > limit) {
        hits.push({
          rule_id: 'L1-TXT-001',
          severity: 'medium',
          field: 'text',
          span: [limit, context.input.text.length],
          matched: context.input.text.slice(limit, limit + 20),
          suggestion: `标题不得超过 ${limit} 字符，请裁剪`,
        });
      }
      const emoji = /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u;
      if (emoji.test(context.input.text)) {
        hits.push({
          rule_id: 'L1-TXT-001',
          severity: 'medium',
          field: 'text',
          span: [0, context.input.text.length],
          matched: 'emoji',
          suggestion: '标题不得含 emoji',
        });
      }
      return hits;
    },
  },
  {
    id: 'L1-TXT-002',
    severity: 'medium',
    platforms: ALL,
    contentTypes: ['title', 'selling_points'],
    suggestion: '改写为自然语句，避免词堆砌',
    evaluate: (context) =>
      regexHits(
        context,
        /([\u4e00-\u9fa5]{2,4})\1{2,}/g,
        'L1-TXT-002',
        'medium',
        '改写为自然语句，保留 1 次核心词',
      ),
  },
  {
    id: 'L1-PRC-001',
    severity: 'blocker',
    platforms: ALL,
    contentTypes: ALL,
    suggestion: '删除价格数字或改为主数据价格',
    evaluate: (context) => {
      const allowed = allowedPrices(context.input.facts);
      if (allowed.size === 0) return [];
      return regexHits(
        context,
        /(\d+(?:\.\d+)?)(?:-(\d+(?:\.\d+)?))?元/g,
        'L1-PRC-001',
        'blocker',
        '删除价格数字或改为主数据价格；价格只在商品库维护',
        (match) => {
          const first = yuanToCents(match[1]!);
          const second = match[2] ? yuanToCents(match[2]) : null;
          return !allowed.has(first) || (second !== null && !allowed.has(second));
        },
      );
    },
  },
  {
    id: 'L1-PRC-003',
    severity: 'blocker',
    platforms: ALL,
    contentTypes: ['title', 'selling_points', 'detail'],
    suggestion: '“X 元起”必须等于最低 SKU 价',
    evaluate: (context) => {
      const minimum = context.input.facts.min_price_cents;
      if (typeof minimum !== 'number') return [];
      return regexHits(
        context,
        /(\d+(?:\.\d+)?)元起/g,
        'L1-PRC-003',
        'blocker',
        '改为实际最低价，或删除“起”',
        (match) => yuanToCents(match[1]!) !== minimum,
      );
    },
  },
  {
    id: 'L1-STK-001',
    severity: 'high',
    platforms: ALL,
    contentTypes: ALL,
    suggestion: '改为不承诺数量，或与库存一致',
    evaluate: (context) => {
      const hits: L1Hit[] = [];
      const stock = context.input.facts.stock;
      if (typeof stock === 'number') {
        hits.push(
          ...regexHits(
            context,
            /(?:现货|库存)(\d+)件/g,
            'L1-STK-001',
            'high',
            '改为不承诺数量，或与库存一致',
            (match) => Number(match[1]) > stock,
          ),
        );
      }
      hits.push(
        ...termHits(context, ['充足', '无限', '管够'], 'L1-STK-001', 'high', '改为不承诺数量'),
      );
      return hits;
    },
  },
  {
    id: 'L1-CMP-001',
    severity: 'blocker',
    platforms: ALL,
    contentTypes: ['selling_points', 'detail', 'faq'],
    suggestion: '按面料成分表改写',
    evaluate: (context) => {
      const composition = context.input.facts.composition;
      if (!composition || composition.length === 0) return [];
      const allowed = new Map(composition.map((item) => [item.material, item.percent]));
      const names = [...STANDARD_FIBERS, ...FIBER_ALIASES, '其他纤维'].join('|');
      const regex = new RegExp(`(${names})(\\d{1,3})%`, 'g');
      return regexHits(
        context,
        regex,
        'L1-CMP-001',
        'blocker',
        '按面料成分表改写，或删除百分比',
        (match) => {
          const material = match[1] === '其他纤维' ? '其他纤维' : match[1]!;
          return allowed.get(material) !== Number(match[2]);
        },
      );
    },
  },
  {
    id: 'L1-CMP-002',
    severity: 'medium',
    platforms: ALL,
    contentTypes: ALL,
    suggestion: '使用标准纤维名称',
    evaluate: (context) =>
      termHits(context, FIBER_ALIASES, 'L1-CMP-002', 'medium', '用标准纤维名称替换（如涤纶→聚酯纤维）'),
  },
  {
    id: 'L1-SIZE-001',
    severity: 'blocker',
    platforms: ALL,
    contentTypes: ['detail', 'faq', 'reply'],
    suggestion: '按尺码表改写建议',
    evaluate: (context) => {
      const ranges = context.input.facts.size_ranges;
      if (!ranges || ranges.length === 0) return [];
      return regexHits(
        context,
        /(\d{2,3})[-~至到](\d{2,3})(cm|kg|斤)/g,
        'L1-SIZE-001',
        'blocker',
        '按尺码表改写身高/体重建议',
        (match) => {
          const min = Number(match[1]);
          const max = Number(match[2]);
          const unit = match[3];
          const covered = ranges.some((range) => {
            if (unit === 'cm') {
              return (
                range.height_min !== undefined &&
                range.height_max !== undefined &&
                min >= range.height_min &&
                max <= range.height_max
              );
            }
            const factor = unit === '斤' ? 2 : 1;
            return (
              range.weight_min !== undefined &&
              range.weight_max !== undefined &&
              min / factor >= range.weight_min &&
              max / factor <= range.weight_max
            );
          });
          return !covered;
        },
      );
    },
  },
  {
    id: 'L1-SIZE-002',
    severity: 'blocker',
    platforms: ALL,
    contentTypes: ['detail'],
    suggestion: '按尺码表 measurements 改写',
    evaluate: (context) => {
      const measurements = context.input.facts.measurements;
      if (!measurements) return [];
      const parts = MEASUREMENT_PARTS.join('|');
      const regex = new RegExp(`(${parts})(\\d+(?:\\.\\d+)?)cm`, 'g');
      return regexHits(
        context,
        regex,
        'L1-SIZE-002',
        'blocker',
        '按尺码表改写；尺码表图由数据渲染',
        (match) => measurements[match[1]!] !== Number(match[2]),
      );
    },
  },
  {
    id: 'L1-SIZE-004',
    severity: 'high',
    platforms: ALL,
    contentTypes: ['detail'],
    suggestion: '补尺码行或下线无尺码数据的 SKU',
    evaluate: (context) => {
      const chart = context.input.facts.size_codes ?? [];
      const sku = context.input.facts.sku_size_codes ?? [];
      if (chart.length === 0 || sku.length === 0) return [];
      const missing = sku.filter((code) => !chart.includes(code));
      if (missing.length === 0) return [];
      return [
        {
          rule_id: 'L1-SIZE-004',
          severity: 'high',
          field: 'text',
          span: [0, context.input.text.length],
          matched: `SKU 尺码 ${missing.join(',')}`,
          suggestion: `尺码表缺少 SKU 码：${missing.join(',')}`,
        },
      ];
    },
  },
  {
    id: 'L1-POL-002',
    severity: 'high',
    platforms: ALL,
    contentTypes: ALL,
    suggestion: '改为政策允许的时效（发货 ≤N 天按事实快照），或说明需人工确认',
    evaluate: (context) => {
      // 时效承诺（docs/08 §4.2 L1-POL-002）：不得优于 facts.lead_time_days。
      // 当天/24 小时/次日 这类「绝对时效」在没有事实支撑时一律算承诺，
      // 但「不能承诺当天发货」这类否定语境会降级为 info（见 negation.ts）。
      const leadTime = context.input.facts.lead_time_days;
      const sameDayPattern = /当天发货|当日发货|当天发出|当日发出|当天发|当日发|24小时内发货|24小时发货|24h内发货|当天送达|当日送达/g;
      const nextDayPattern = /次日达|隔日达|次日送达|保证次日/g;
      const hits: L1Hit[] = [];
      const collect = (pattern: RegExp, allowedLeadTime: number) => {
        if (typeof leadTime === 'number' && leadTime <= allowedLeadTime) return;
        const global = new RegExp(pattern.source, 'g');
        let match: RegExpExecArray | null;
        while ((match = global.exec(context.normalized.normalized)) !== null) {
          const span = spanToOriginal(
            context.normalized.map,
            match.index,
            match.index + match[0].length,
            context.originalLength,
          );
          const negation = detectNegation(
            context.normalized.normalized,
            match.index,
            DEFAULT_NEGATION_WINDOW,
          );
          hits.push({
            rule_id: 'L1-POL-002',
            severity: negation.negated ? 'info' : 'high',
            field: 'text',
            span,
            matched: context.input.text.slice(span[0], span[1]) || match[0],
            suggestion: '改为政策允许的时效（发货 ≤N 天按事实快照），或说明需人工确认',
            ...(negation.negated ? { negated: true, negation_marker: negation.marker } : {}),
          });
        }
      };
      collect(sameDayPattern, 0);
      collect(nextDayPattern, 1);
      return hits;
    },
  },
  {
    id: 'L1-POL-001',
    severity: 'blocker',
    platforms: ALL,
    contentTypes: ['detail', 'faq', 'reply'],
    suggestion: '引用有效政策原文；无引用则删除政策表述',
    evaluate: (context) => {
      const hasPolicyClaim = /(退换|售后|保修|包邮|七天无理由|退款|退货)/.test(
        context.normalized.normalized,
      );
      if (!hasPolicyClaim) return [];
      const refs = context.input.facts.policy_refs ?? [];
      if (refs.length > 0) return [];
      return termHits(
        context,
        ['退换', '售后', '保修', '包邮', '七天无理由', '退款', '退货'],
        'L1-POL-001',
        'blocker',
        '引用有效政策原文；无引用则删除政策表述',
      );
    },
  },
  {
    id: 'L1-REP-001',
    severity: 'high',
    platforms: ALL,
    contentTypes: ['reply'],
    suggestion: '改为“帮您申请”，补偿额度走审批',
    evaluate: (context) =>
      termHits(
        context,
        ['赔付', '补发', '我赔你', '赔偿', '退款比例'],
        'L1-REP-001',
        'high',
        '改为“帮您申请”，补偿额度走审批',
      ),
  },
  {
    id: 'L1-REP-002',
    severity: 'blocker',
    platforms: ALL,
    contentTypes: ['reply'],
    suggestion: '立即阻断；仅走平台售后流程',
    evaluate: (context) =>
      termHits(
        context,
        ['身份证', '银行卡', '验证码', '密码'],
        'L1-REP-002',
        'blocker',
        '索要敏感信息立即阻断；仅走平台售后流程',
      ),
  },
];

export const L1_RULE_IDS = RULES.map((rule) => rule.id);
export const L1_RULE_SET_VERSION = RULE_SET_VERSION;
export const L1_LEXICON_VERSION = LEXICON_VERSION;

export function runL1(input: JudgeInput): L1Result {
  const started = Date.now();
  const normalized = normalizeText(input.text);
  const context: RuleContext = {
    input,
    normalized,
    originalLength: input.text.length,
  };
  const hits: L1Hit[] = [];
  const errors: L1Result['errors'] = [];
  const skipped: string[] = [];
  let evaluated = 0;

  for (const rule of RULES) {
    if (!applies(rule, input)) {
      skipped.push(rule.id);
      continue;
    }
    evaluated += 1;
    try {
      hits.push(...rule.evaluate(context));
    } catch (error) {
      errors.push({ rule_id: rule.id, message: String(error) });
    }
  }

  hits.sort((left, right) => left.span[0] - right.span[0] || left.rule_id.localeCompare(right.rule_id));
  const blocked = hits.some((hit) => hit.severity === 'blocker');
  return {
    rule_set_version: RULE_SET_VERSION,
    lexicon_version: LEXICON_VERSION,
    evaluated,
    skipped,
    hits,
    errors,
    duration_ms: Math.max(0, Date.now() - started),
    blocked,
  };
}

export function l1HighestSeverity(result: L1Result): Severity {
  return maxSeverity(...result.hits.map((hit) => hit.severity));
}
