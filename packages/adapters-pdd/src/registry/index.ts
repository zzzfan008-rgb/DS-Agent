/**
 * 接口注册表查询、统计与「未核验接口清单」生成。
 *
 * 安全门：`requireCallable()` 是 `PddClient` 调用真实平台前的最后一道检查。
 * 只要 method/version/path 任一为 null 或 verification!=='verified'，一律拒绝调用。
 */

import { PddError } from '../errors.js';
import { PDD_INTERFACES } from './pdd-interfaces.js';
import type {
  PddInterfaceConclusion,
  PddInterfaceSection,
  PddInterfaceSpec,
  PddRegistryStats,
  UnverifiedInterfaceRow,
  VerifiedPddInterfaceSpec,
} from './types.js';

export interface InterfaceFilter {
  section?: PddInterfaceSection;
  write?: boolean;
  conclusion?: PddInterfaceConclusion;
  verification?: 'unverified' | 'verified';
}

const FALLBACK_NOTES: Record<UnverifiedInterfaceRow['fallback'], string> = {
  none: '无导入包替代；保持只读/人工，不阻塞其它模块',
  listing_package: '走上架包（CSV/Excel）+ 后台人工导入，回填批次号与包哈希（ADR-0006）',
  read_only_sync: '只读同步暂缺，业务使用本地已有数据并显式标注数据时间',
  manual_workbench: '工作台人工处理 + 剪贴板助手/人工后台操作，登记 handoff',
};

export class InterfaceRegistry {
  private readonly byKey = new Map<string, PddInterfaceSpec>();

  constructor(specs: readonly PddInterfaceSpec[]) {
    for (const spec of specs) {
      if (this.byKey.has(spec.key)) throw new Error(`接口注册表 key 重复：${spec.key}`);
      this.byKey.set(spec.key, spec);
    }
  }

  get size(): number {
    return this.byKey.size;
  }

  get(key: string): PddInterfaceSpec | undefined {
    return this.byKey.get(key);
  }

  require(key: string): PddInterfaceSpec {
    const spec = this.byKey.get(key);
    if (!spec) {
      throw new PddError({
        code: 'interface_not_registered',
        message: `接口未注册：${key}（注册表见 docs/01 §2）`,
        errorClass: 'permanent',
        nextAction: 'contact_admin',
        detail: { interface_key: key },
      });
    }
    return spec;
  }

  /** 只有 verified 且 method/version/path 齐全才返回；否则抛 unverified_interface。 */
  requireCallable(key: string): VerifiedPddInterfaceSpec {
    const spec = this.require(key);
    const missing: string[] = [];
    if (spec.verification !== 'verified') missing.push('verification');
    if (spec.platform_method === null) missing.push('platform_method');
    if (spec.platform_version === null) missing.push('platform_version');
    if (spec.path_template === null) missing.push('path_template');
    if (missing.length > 0) {
      throw new PddError({
        code: 'unverified_interface',
        message: `接口 ${key} 尚未核验（缺 ${missing.join(', ')}），禁止发起真实平台调用`,
        errorClass: 'permanent',
        nextAction: spec.fallback === 'listing_package' ? 'fix_and_resubmit' : 'contact_admin',
        detail: {
          interface_key: key,
          missing,
          doc_ref: spec.doc_ref,
          todos: spec.todos,
          fallback: spec.fallback,
          fallback_note: FALLBACK_NOTES[spec.fallback],
        },
      });
    }
    return spec as VerifiedPddInterfaceSpec;
  }

  list(filter: InterfaceFilter = {}): PddInterfaceSpec[] {
    return [...this.byKey.values()].filter((spec) => {
      if (filter.section !== undefined && spec.section !== filter.section) return false;
      if (filter.write !== undefined && spec.write !== filter.write) return false;
      if (filter.conclusion !== undefined && spec.conclusion !== filter.conclusion) return false;
      if (filter.verification !== undefined && spec.verification !== filter.verification) return false;
      return true;
    });
  }

  stats(): PddRegistryStats {
    const bySection: Record<PddInterfaceSection, number> = {
      '2.1': 0,
      '2.2': 0,
      '2.3': 0,
      '2.4': 0,
      '2.5': 0,
      '2.6': 0,
    };
    const byConclusion: Record<PddInterfaceConclusion, number> = {
      automation: 0,
      conditional_automation: 0,
      degraded: 0,
      manual: 0,
      pending_review: 0,
    };
    let verified = 0;
    let write = 0;
    for (const spec of this.byKey.values()) {
      bySection[spec.section] += 1;
      byConclusion[spec.conclusion] += 1;
      if (spec.verification === 'verified') verified += 1;
      if (spec.write) write += 1;
    }
    return {
      total: this.byKey.size,
      verified,
      unverified: this.byKey.size - verified,
      write,
      read: this.byKey.size - write,
      by_section: bySection,
      by_conclusion: byConclusion,
    };
  }

  /** 「未自动化接口清单」是一等交付物（ADR-0006 / docs/03）。 */
  unverifiedReport(): UnverifiedInterfaceRow[] {
    return [...this.byKey.values()]
      .filter((spec) => spec.verification !== 'verified')
      .map((spec) => ({
        key: spec.key,
        section: spec.section,
        title: spec.title,
        reason: 'method_unverified' as const,
        fallback: spec.fallback,
        fallback_note: FALLBACK_NOTES[spec.fallback],
        doc_ref: spec.doc_ref,
        todo: spec.todos.method,
        owner: '平台接入负责人（docs/01 §1.1；需 P1/P2 账号）',
        review_date: null,
      }));
  }
}

export function createInterfaceRegistry(specs: readonly PddInterfaceSpec[]): InterfaceRegistry {
  return new InterfaceRegistry(specs);
}

/** 生产注册表：docs/01 的 28 条，全部未核验。测试可注入合成注册表。 */
export const pddRegistry = new InterfaceRegistry(PDD_INTERFACES);
