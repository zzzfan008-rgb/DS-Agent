/**
 * TOTP 校验（RFC 6238，HMAC-SHA1，6 位，30 秒步长，窗口 ±1；docs/14 §3.2）。
 *
 * 密钥真值不应落库：users.totp_secret_ref 只存名称，本文件的 resolver 在
 * M1 从 `DSSAAS_TOTP_SECRETS`（JSON）解析；生产替换为 DSH/Vault 解析器即可。
 * 防重放：进程内记录每个用户已用过的最大 step（M1 单实例；docs/14 用 Redis）。
 */
import * as OTPAuth from 'otpauth';

export type TotpResult = 'ok' | 'required' | 'invalid' | 'replay' | 'unavailable';

export interface TotpSecretResolver {
  resolve(ref: string): string | null;
}

export class MapTotpSecretResolver implements TotpSecretResolver {
  constructor(private readonly secrets: Record<string, string>) {}

  resolve(ref: string): string | null {
    const secret = this.secrets[ref];
    return typeof secret === 'string' && secret.trim() !== '' ? secret.trim() : null;
  }

  get size(): number {
    return Object.keys(this.secrets).length;
  }
}

/** 解析 DSSAAS_TOTP_SECRETS；空/非法 JSON 视为未配置（不阻断启动）。 */
export function parseTotpSecrets(json: string | null | undefined): Record<string, string> {
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

const STEP_SECONDS = 30;

export class TotpService {
  private readonly lastStepByUser = new Map<string, number>();

  constructor(
    private readonly resolver: TotpSecretResolver,
    private readonly issuer: string,
    private readonly now: () => number = () => Date.now(),
  ) {}

  isConfigured(): boolean {
    return this.resolver instanceof MapTotpSecretResolver ? this.resolver.size > 0 : true;
  }

  verify(userId: string, secretRef: string | null | undefined, code: string | undefined): TotpResult {
    if (!secretRef) return 'unavailable';
    const secret = this.resolver.resolve(secretRef);
    if (!secret) return 'unavailable';
    if (!code) return 'required';
    if (!/^\d{6}$/.test(code)) return 'invalid';

    let delta: number | null;
    try {
      const totp = new OTPAuth.TOTP({
        issuer: this.issuer,
        label: `user:${userId}`,
        algorithm: 'SHA1',
        digits: 6,
        period: STEP_SECONDS,
        secret: OTPAuth.Secret.fromBase32(secret),
      });
      delta = totp.validate({ token: code, window: 1 });
    } catch {
      return 'unavailable';
    }
    if (delta === null) return 'invalid';

    const usedStep = Math.floor(this.now() / 1000 / STEP_SECONDS) + delta;
    const lastStep = this.lastStepByUser.get(userId);
    if (lastStep !== undefined && usedStep <= lastStep) return 'replay';
    this.lastStepByUser.set(userId, usedStep);
    return 'ok';
  }
}
