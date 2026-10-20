/**
 * 凭据解析（M1）。
 *
 * 铁律：业务代码只拿 `provider.credential_ref` 名称，按请求解析真值；
 * 本文件从 `DSSAAS_MODEL_CREDENTIALS`（JSON: {"credential_ref":"secret"}）读取，
 * 仅用于开发/PoC。生产替换为 DSH 凭据解析（dsh-credentials），接口不变。
 * 任何日志/审计/异常消息都不得包含 secret。
 */
export interface CredentialResolver {
  /** 找不到时返回 null；调用方按 provider_unavailable 处理。 */
  resolve(ref: string): string | null;
}

export class MapCredentialResolver implements CredentialResolver {
  constructor(private readonly secrets: Record<string, string>) {}

  resolve(ref: string): string | null {
    const value = this.secrets[ref];
    return typeof value === 'string' && value.trim() !== '' ? value.trim() : null;
  }

  get size(): number {
    return Object.keys(this.secrets).length;
  }
}

export function parseCredentialMap(json: string | null | undefined): Record<string, string> {
  if (!json || json.trim() === '') return {};
  try {
    const parsed: unknown = JSON.parse(json);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    const out: Record<string, string> = {};
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof value === 'string' && value.trim() !== '') out[key] = value.trim();
    }
    return out;
  } catch {
    return {};
  }
}

export function credentialMask(ref: string): string {
  if (ref.length <= 4) return '****';
  return `${ref.slice(0, 3)}****${ref.slice(-2)}`;
}
