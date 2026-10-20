/**
 * 写入门 → 平台 adapter 端口的唯一桥（docs/11 不变量 I1）。
 *
 * M4 的 adapter 契约未核验，因此端口只做 dry-run：
 * - PDD：PddClient 强制 dry_run，调用注册表里的目标接口，返回 request_preview；
 * - 1688：Alibaba1688Client.plan()，返回 blocked/gaps，不发网络。
 * 真实发送必须等契约核验后替换此端口，写入门时序不变。
 */
import path from 'node:path';
import {
  NullArchiver,
  PddClient,
  loadPddConfig,
} from '@dssaas/adapters-pdd';
import { Alibaba1688Client } from '@dssaas/adapters-1688';
import { canonicalHash } from '@dssaas/core';
import type { ActionMeta } from './actions.js';
import { getActionMeta } from './actions.js';

export interface PlatformPreviewInput {
  platform: 'pdd' | '1688';
  action: string;
  payload: Record<string, unknown>;
  requestId: string;
  idempotencyKey: string;
}

export interface PlatformPreview {
  platform: 'pdd' | '1688';
  adapter: string;
  status: 'dry_run';
  interfaceKey: string;
  payloadHash: string;
  blocked: boolean;
  requestPreview: unknown;
  warnings: string[];
  todoIds: string[];
  /** 平台原文落 MinIO 的键；dry-run 为 null。 */
  raw_object_key?: string | null;
}

export interface PlatformWritePort {
  preview(input: PlatformPreviewInput): Promise<PlatformPreview>;
}

function toScalarString(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return null;
}

export class AdapterDryRunPort implements PlatformWritePort {
  private pdd: PddClient | null = null;
  private pdd1688: Alibaba1688Client | null = null;

  private getPdd(): PddClient {
    if (!this.pdd) {
      const config = loadPddConfig({
        env: { ...process.env, PDD_DRY_RUN: '1' },
        archiveDir: path.join(process.cwd(), 'data', 'pdd-write-gate-dryrun'),
      });
      this.pdd = new PddClient({
        config: { ...config, dryRun: true, dryRunReason: 'forced_by_env' },
        archiver: new NullArchiver(),
      });
    }
    return this.pdd;
  }

  private get1688(): Alibaba1688Client {
    if (!this.pdd1688) {
      this.pdd1688 = new Alibaba1688Client({ baseUrl: null, contractVersion: null });
    }
    return this.pdd1688;
  }

  async preview(input: PlatformPreviewInput): Promise<PlatformPreview> {
    const meta: ActionMeta = getActionMeta(input.action);
    const payloadHash = canonicalHash(input.payload);

    if (input.platform === 'pdd') {
      const result = await this.getPdd().call(meta.pddInterface, input.payload, {
        requestId: input.requestId,
        idempotencyKey: input.idempotencyKey,
        metadata: { action: input.action },
      });
      if (result.status !== 'dry_run') {
        // 端口契约：M4 只允许 dry-run；真实回调必须换端口实现，不能在此静默 live。
        throw new Error('write gate dry-run port received non-dry-run result');
      }
      return {
        platform: 'pdd',
        adapter: '@dssaas/adapters-pdd',
        status: 'dry_run',
        interfaceKey: meta.pddInterface,
        payloadHash,
        blocked: false,
        requestPreview: result.request_preview,
        warnings: result.warnings,
        todoIds: ['TODO-PDD-CONTRACT-VERIFY'],
        raw_object_key: null,
      };
    }

    const params: Record<string, string> = {};
    for (const [key, value] of Object.entries(input.payload)) {
      const scalar = toScalarString(value);
      if (scalar !== null) params[key] = scalar;
    }
    const plan = this.get1688().plan(meta.operation1688, { params });
    return {
      platform: '1688',
      adapter: '@dssaas/adapters-1688',
      status: 'dry_run',
      interfaceKey: meta.operation1688,
      payloadHash,
      blocked: plan.blocked,
      requestPreview: {
        operation: plan.operation,
        title: plan.title,
        channel: plan.channel,
        action_code: plan.actionCode,
        risk_level: plan.riskLevel,
        irreversible: plan.irreversible,
        params_digest: plan.paramsDigest,
        gaps: plan.gaps,
      },
      warnings: plan.blocked ? ['1688 契约未核验，plan.blocked=true，不发送'] : [],
      todoIds: plan.todoIds,
      raw_object_key: null,
    };
  }
}
