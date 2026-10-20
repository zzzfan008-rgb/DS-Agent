'use client';

/**
 * 审批数据加载（M1 只读）。
 *
 * 队长确认 Q1：`GET /api/approvals` 仅 404 → 演示数据；网络错误/5xx 一律抛错给错误态。
 * 401 由调用方统一处理为"会话过期 → 登录页"。
 */
import type { ApprovalDetailRaw, ApprovalListData } from './contracts';
import { demoApprovalDetail, demoApprovalList } from './demo/approvals';
import { failureFromUnknown, failureFromResponse, parseApiResponse, type ApiFailure } from './api';

export type ApprovalsSource = 'api' | 'demo';

export interface ApprovalListLoad {
  source: ApprovalsSource;
  data: ApprovalListData;
}

export interface ApprovalDetailLoad {
  source: ApprovalsSource;
  detail: ApprovalDetailRaw;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function invalidDataFailure(): ApiFailure {
  return {
    ok: false,
    status: 200,
    code: 'invalid_response',
    message: '审批接口返回了无法识别的数据结构',
    requestId: null,
    nextAction: 'retry_later',
    retryable: true,
    detail: null,
  };
}

function notFoundFailure(id: string): ApiFailure {
  return {
    ok: false,
    status: 404,
    code: 'not_found',
    message: `审批 ${id} 不存在或已被处理`,
    requestId: null,
    nextAction: 'none',
    retryable: false,
    detail: null,
  };
}

export function isApiFailure(value: unknown): value is ApiFailure {
  return isRecord(value) && value.ok === false && typeof value.code === 'string';
}

export async function loadApprovals(): Promise<ApprovalListLoad> {
  try {
    const response = await fetch('/api/approvals?limit=100', {
      method: 'GET',
      credentials: 'same-origin',
      cache: 'no-store',
      headers: { accept: 'application/json' },
    });
    // 仅"端点未实现"回退演示数据；其余失败一律错误态。
    if (response.status === 404) {
      return { source: 'demo', data: demoApprovalList() };
    }
    const result = await parseApiResponse<ApprovalListData>(response);
    if (!result.ok) throw result;
    const data = result.data;
    if (!isRecord(data) || !Array.isArray(data.items)) throw invalidDataFailure();
    return {
      source: 'api',
      data: {
        items: data.items,
        meta: isRecord(data.meta) ? (data.meta as ApprovalListData['meta']) : {},
      },
    };
  } catch (error) {
    if (isApiFailure(error)) throw error;
    throw failureFromUnknown(error);
  }
}

export async function loadApprovalDetail(id: string): Promise<ApprovalDetailLoad> {
  try {
    const response = await fetch(`/api/approvals/${encodeURIComponent(id)}`, {
      method: 'GET',
      credentials: 'same-origin',
      cache: 'no-store',
      headers: { accept: 'application/json' },
    });
    if (response.status === 404) {
      const demo = demoApprovalDetail(id);
      if (demo) return { source: 'demo', detail: demo };
      throw notFoundFailure(id);
    }
    const result = await parseApiResponse<ApprovalDetailRaw>(response);
    if (!result.ok) throw result;
    if (!isRecord(result.data) || typeof result.data.id !== 'string') {
      throw invalidDataFailure();
    }
    return { source: 'api', detail: result.data };
  } catch (error) {
    if (isApiFailure(error)) throw error;
    throw failureFromUnknown(error);
  }
}

/** 供组件显示的错误文案（404 由调用方转空态）。 */
export function failureFromBody(status: number, body: unknown, requestId: string | null): ApiFailure {
  return failureFromResponse(status, body, requestId);
}
