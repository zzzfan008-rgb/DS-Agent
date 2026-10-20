/**
 * workflow_run 状态机（docs/11 §3–§4），纯函数，不依赖 DB。
 *
 * DB 的 error_class 只有 retryable/manual/permanent（t1 CHECK）；uncertain/guard 映射后落库，
 * 业务语义在 result.payload 中保留。
 */
export type WorkflowState =
  | 'pending'
  | 'running'
  | 'waiting_human'
  | 'succeeded'
  | 'failed_retryable'
  | 'failed_permanent'
  | 'cancelled';

export const WORKFLOW_STATES: WorkflowState[] = [
  'pending',
  'running',
  'waiting_human',
  'succeeded',
  'failed_retryable',
  'failed_permanent',
  'cancelled',
];

export const TERMINAL_STATES = new Set<WorkflowState>([
  'succeeded',
  'failed_permanent',
  'cancelled',
]);

const TRANSITIONS: Record<WorkflowState, WorkflowState[]> = {
  pending: ['running', 'cancelled'],
  running: ['waiting_human', 'succeeded', 'failed_retryable', 'failed_permanent', 'cancelled'],
  waiting_human: ['running', 'failed_permanent', 'cancelled'],
  failed_retryable: ['running', 'failed_permanent', 'cancelled'],
  succeeded: [],
  failed_permanent: [],
  cancelled: [],
};

export function canTransition(from: WorkflowState, to: WorkflowState): boolean {
  return TRANSITIONS[from]?.includes(to) ?? false;
}

export function assertTransition(from: WorkflowState, to: WorkflowState): void {
  if (!canTransition(from, to)) {
    throw new Error(`illegal workflow transition: ${from} → ${to}`);
  }
}

export function isTerminal(state: WorkflowState): boolean {
  return TERMINAL_STATES.has(state);
}

export type FailureClass = 'retryable' | 'uncertain' | 'manual' | 'permanent' | 'guard';
export type DbErrorClass = 'retryable' | 'manual' | 'permanent';

export interface FailureClassification {
  failureClass: FailureClass;
  dbErrorClass: DbErrorClass;
  nextState: WorkflowState;
  retryable: boolean;
  nextAction:
    | 'retry_later'
    | 'reconcile_first'
    | 'fix_and_resubmit'
    | 'create_compensation'
    | 'reopen_approval'
    | 'contact_admin'
    | 'none';
}

const GUARD_CODES = new Set([
  'approval_required',
  'approval_stale',
  'irreversible',
  'kill_switch_on',
  'quota',
  'quota_exceeded',
  'forbidden',
  'idempotency_conflict',
  'conflict',
]);
const RETRYABLE_CODES = new Set([
  'upstream_5xx',
  'rate_limited',
  'timeout',
  'network_error',
  'ETIMEDOUT',
  'ECONNRESET',
  'EAI_AGAIN',
]);
const MANUAL_CODES = new Set(['platform_reject', 'invalid_fact']);
const PERMANENT_CODES = new Set(['not_found', 'validation_failed', 'unverified_interface', 'config_error']);

export function classifyFailure(input: {
  code?: string;
  httpStatus?: number;
  subClass?: 'unknown' | 'fatal' | 'repairable' | string;
  message?: string;
}): FailureClassification {
  const code = input.code ?? '';
  const status = input.httpStatus;

  if (GUARD_CODES.has(code)) {
    return {
      failureClass: 'guard',
      dbErrorClass: 'permanent',
      nextState: 'failed_permanent',
      retryable: false,
      nextAction: code === 'approval_required' || code === 'approval_stale' ? 'reopen_approval' : 'contact_admin',
    };
  }
  if (code === 'uncertain' || input.subClass === 'unknown') {
    return {
      failureClass: 'uncertain',
      dbErrorClass: 'retryable',
      nextState: 'failed_retryable',
      retryable: false,
      nextAction: 'reconcile_first',
    };
  }
  if (RETRYABLE_CODES.has(code) || status === 429 || (status !== undefined && status >= 500)) {
    return {
      failureClass: 'retryable',
      dbErrorClass: 'retryable',
      nextState: 'failed_retryable',
      retryable: true,
      nextAction: 'retry_later',
    };
  }
  if (MANUAL_CODES.has(code) || input.subClass === 'repairable') {
    return {
      failureClass: 'manual',
      dbErrorClass: 'manual',
      nextState: 'waiting_human',
      retryable: false,
      nextAction: 'fix_and_resubmit',
    };
  }
  if (PERMANENT_CODES.has(code) || input.subClass === 'fatal' || (status !== undefined && status >= 400 && status < 500)) {
    return {
      failureClass: 'permanent',
      dbErrorClass: 'permanent',
      nextState: 'failed_permanent',
      retryable: false,
      nextAction: 'fix_and_resubmit',
    };
  }
  return {
    failureClass: 'permanent',
    dbErrorClass: 'permanent',
    nextState: 'failed_permanent',
    retryable: false,
    nextAction: 'contact_admin',
  };
}

/** docs/11 §4.2：10s/30s/90s，±20% 抖动。第 n 次（1-based）失败后的退避。 */
export function computeBackoffMs(attempt: number, random: () => number = Math.random): number {
  const base = attempt <= 1 ? 10_000 : attempt === 2 ? 30_000 : 90_000;
  const jitter = 0.8 + random() * 0.4;
  return Math.round(base * jitter);
}

export interface ReplayPreconditionsInput {
  runState: WorkflowState;
  failureClass: FailureClass | null;
  repairHintsClosed: boolean;
  killSwitchBlocked: boolean;
  approvalStatus: string | null;
  approvalExpiresAt: Date | null;
  approvalTargetHash: string | null;
  currentTargetHash: string | null;
  reconciled: boolean;
  reconcileNote: string | null;
  idempotencyStatus: string | null;
  actorRole: string;
  replayReason: string | null;
  level: string | null;
  irreversibleSideEffect: boolean;
  alreadyReplayed: boolean;
  now?: Date;
}

export interface ReplayValidation {
  ok: boolean;
  issues: string[];
}

const REPLAYABLE_FAILURE_CLASSES: FailureClass[] = ['retryable', 'uncertain'];

/** docs/11 §4.5 P1–P6 + 禁止清单。全部通过才允许新建 run。 */
export function validateReplayPreconditions(input: ReplayPreconditionsInput): ReplayValidation {
  const issues: string[] = [];
  const now = input.now ?? new Date();
  if (input.runState !== 'failed_permanent') issues.push('P0: run 不在 failed_permanent 终态');
  if (input.alreadyReplayed) issues.push('P0: 该死信已重放');
  if (!(input.failureClass && REPLAYABLE_FAILURE_CLASSES.includes(input.failureClass))) {
    if (!(input.failureClass === 'manual' && input.repairHintsClosed)) {
      issues.push('P1: 失败分类不是 retryable/uncertain，且 manual 修复项未关闭');
    }
  }
  if (input.killSwitchBlocked) issues.push('P2: kill switch 阻断了该任务');
  if (!input.approvalStatus || !['approved', 'approved_with_edit', 'scheduled'].includes(input.approvalStatus)) {
    issues.push('P3: 审批不存在或未批准');
  }
  if (input.approvalExpiresAt && input.approvalExpiresAt.getTime() <= now.getTime()) {
    issues.push('P3: 审批已过期');
  }
  if (!input.approvalTargetHash || input.approvalTargetHash !== input.currentTargetHash) {
    issues.push('P3: target_hash 与当前内容不一致');
  }
  if (!input.reconciled || !input.reconcileNote) issues.push('P4: 未完成对账/对账说明为空');
  if (input.idempotencyStatus === 'succeeded') issues.push('P5: 幂等键已有 succeeded 记录，应走响应回放');
  if (input.actorRole !== 'admin') issues.push('P6: 重放操作人不是 admin');
  if (!input.replayReason || input.replayReason.trim().length < 10) issues.push('P6: 缺少 replay_reason（≥10 字）');
  if (input.level === 'C') issues.push('禁止: C 级写不允许重放');
  if (input.irreversibleSideEffect) issues.push('禁止: 已产生不可逆副作用，应走补偿工单');
  return { ok: issues.length === 0, issues };
}
