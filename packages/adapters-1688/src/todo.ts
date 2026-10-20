/**
 * 未核实项登记表 —— docs/02《平台接入侦察报告·1688》附录 B 的代码化。
 *
 * 硬规则（docs/02 §0 与文首写法约定）：
 * 1. 1688 公开 API 文档本轮**未取得可核实来源**，因此 method 名、字段名、限流数字、
 *    签名算法、请求协议、导入包模板一律为「未核验」；
 * 2. 代码里**不得**出现猜出来的 method 名/字段名。凡是需要平台事实的位置，一律引用
 *    本表的 TODO id，并以 `null` 占位，等待回填；
 * 3. 回填后必须同时更新：本表 `status`、`docs/02` 对应章节、契约 fixture（见
 *    `testing/fixtures.ts`）与 `docs/验收记录-M1-1688.md`。
 *
 * 这与 docs/02 的判定规则 H0/H1/H2 一致：未核验不是「先写再说」，而是显式的阻塞点。
 */

export type TodoId =
  | 'TODO-1688-001'
  | 'TODO-1688-002'
  | 'TODO-1688-003'
  | 'TODO-1688-004'
  | 'TODO-1688-005'
  | 'TODO-1688-006'
  | 'TODO-1688-007'
  | 'TODO-1688-008'
  | 'TODO-1688-009'
  | 'TODO-1688-010'
  | 'TODO-1688-011'
  | 'TODO-1688-012'
  | 'TODO-1688-PERSIST-01';

export interface TodoItem {
  id: TodoId;
  /** 对应 docs/02 的章节/附录项。 */
  docRef: string;
  /** 待核实的具体问题（必须可被平台方/文档回答，不能是「看看文档」）。 */
  question: string;
  /** 阻塞了哪些能力。 */
  blocking: string;
  /** open = 仍未核实（默认）；verified = 已回填并更新了 fixtures。 */
  status: 'open' | 'verified';
}

export const TODO_ITEMS: Record<TodoId, TodoItem> = {
  'TODO-1688-001': {
    id: 'TODO-1688-001',
    docRef: 'docs/02 §0.1 M2、§二、附录 B#1',
    question: '1688 开放平台 API 文档的访问入口与可引用 URL；method 命名空间前缀与版本号规则。',
    blocking: '全部接口调用（本包所有 OperationDescriptor 的 `method` 为 null）。',
    status: 'open',
  },
  'TODO-1688-002': {
    id: 'TODO-1688-002',
    docRef: 'docs/02 文首写法约定 #1、§三#2',
    question: '请求协议：HTTP 方法、请求路径/域名（生产与沙箱是否不同）、参数位置（query 还是 body）、body 是 form 表单还是 JSON。',
    blocking: 'client 的请求构造（`buildRequest()` 在缺这三项时拒绝发送）。',
    status: 'open',
  },
  'TODO-1688-003': {
    id: 'TODO-1688-003',
    docRef: 'docs/02 §1.1#5/#6、附录 B#2',
    question: '签名算法与签名参数名（app_key / sign / timestamp / nonce / sign_method 的真实键名与算法），令牌有效期与刷新方式。',
    blocking: '`RequestSigner` 的真实实现（当前只有 `UnverifiedSigner` 与仅用于回放复算的测试签名器）。',
    status: 'open',
  },
  'TODO-1688-004': {
    id: 'TODO-1688-004',
    docRef: 'docs/02 §二（各表「限流」列）、附录 B#8',
    question: '各接口的 QPS / 日上限、超限错误码与 `Retry-After` 语义；是否有改价冷静期。',
    blocking: '限流默认值（当前 `ASSUMED_CLIENT_RATE_LIMIT` 只是本地保护，不是平台配额）。',
    status: 'open',
  },
  'TODO-1688-005': {
    id: 'TODO-1688-005',
    docRef: 'docs/02 §2.4#1、§2.7#1–#3、附录 B#3',
    question: '发布/改价接口承载起批价、阶梯价、区间价的字段结构（数组键名、货币单位、是否含税、档位上限、是否允许重叠）。',
    blocking: '价格档位到平台报文的映射（本包只做内部 `PriceTiersV1` 建模与导出）。',
    status: 'open',
  },
  'TODO-1688-006': {
    id: 'TODO-1688-006',
    docRef: 'docs/02 §2.7#4、附录 B#4',
    question: '规格（颜色/尺码）维度与每个组合的最小起订量字段；混批规则字段是否存在。',
    blocking: '规格与起批量的平台映射（`buildAttributeMappings()` 输出全部为 draft）。',
    status: 'open',
  },
  'TODO-1688-007': {
    id: 'TODO-1688-007',
    docRef: 'docs/02 §2.3#4、§2.7#5、附录 B#5',
    question: '代发（一件代发）相关接口与字段：代发标记、代发价、代发库存、面单来源、退货地址、时效承诺。',
    blocking: '代发字段映射与代发单履约（本包只做内部 `DropshipTerms` 建模）。',
    status: 'open',
  },
  'TODO-1688-008': {
    id: 'TODO-1688-008',
    docRef: 'docs/02 §2.4#3、§2.5、§2.7#6–#7、附录 B#6/#7',
    question: '旺旺询盘会话拉取/发送/订阅的 method；报价单（创建/发送/失效）与账期字段。',
    blocking: '询盘工作台与报价链路（本包只登记 OperationDescriptor，不实现）。',
    status: 'open',
  },
  'TODO-1688-009': {
    id: 'TODO-1688-009',
    docRef: 'docs/02 §2.1#5、§6.3#4、附录 B#2',
    question: '类目树与类目属性（必填属性、值域、属性 id）的查询方式与快照版本字段。',
    blocking: 'L2 平台预检与 `platform_attribute_mapping` 的 `verified` 状态（平台值 id 目前一律未知）。',
    status: 'open',
  },
  'TODO-1688-010': {
    id: 'TODO-1688-010',
    docRef: 'docs/02 §2.1#6、附录 B#2',
    question: '商家后台批量发布模板的真实列名、必填列、单文件行数上限与失败回执格式。',
    blocking: '上架包的**最终模板**（本包导出的 CSV 是内部规范化包，不是平台模板）。',
    status: 'open',
  },
  'TODO-1688-011': {
    id: 'TODO-1688-011',
    docRef: 'docs/02 §1.3#6、§2.7#5',
    question: '代发服务承诺字段（是否需承诺 48h 发货、是否需公示代发价）与退货地址的承载方式。',
    blocking: '代发条款的合规展示（`DropshipTerms.returnAddressRef` 只存引用，不存明文地址）。',
    status: 'open',
  },
  'TODO-1688-012': {
    id: 'TODO-1688-012',
    docRef: 'docs/02 §1.1#9、§6.4、附录 B#9',
    question: '是否提供沙箱、沙箱是否覆盖写接口与报价、沙箱店铺是否独立。',
    blocking: '契约录制与夜间沙箱（当前 fixture 为本地合成，见 `testing/fixtures.ts`）。',
    status: 'open',
  },
  'TODO-1688-PERSIST-01': {
    id: 'TODO-1688-PERSIST-01',
    docRef: 'docs/02 §6.1 步骤 1、§2.7#4/#5；docs/06 §4.2.2',
    question: '主数据缺列：`product_sku.price_tiers` 与 `min_order_qty` 已有，但 `mix_batch_allowed`（混批）与 `dropship_terms`（代发条款）在 docs/06 与迁移中**没有承载列**。需 docs/06 增补（列或 JSON 结构）后本包的这两个模型才能落库。',
    blocking: '混批/代发的持久化与上架包回读（当前只在内存模型与导出包中表达，导出时标 `persisted: false`）。',
    status: 'open',
  },
};

/** 读取 TODO 项；未知 id 直接抛错，防止拼写错误静默通过。 */
export function todo(id: TodoId): TodoItem {
  const item = TODO_ITEMS[id];
  if (!item) throw new Error(`未知 TODO id：${id}`);
  return item;
}

export function openTodos(): TodoItem[] {
  return Object.values(TODO_ITEMS).filter((item) => item.status === 'open');
}

/** 汇总一条阻塞说明，用于错误信息与验收文档。 */
export function describeTodo(id: TodoId): string {
  const item = todo(id);
  return `${item.id}（${item.docRef}）：${item.question}`;
}
