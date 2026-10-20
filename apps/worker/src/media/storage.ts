/**
 * 对象存储抽象：测试/本地用 FsStorage，运行期用 S3Storage（MinIO 兼容，SigV4）。
 *
 * 为什么自实现 SigV4 而不引 SDK：只用到 PUT/GET/DELETE/HEAD/ListObjectsV2 五个动作，
 * 避免给 worker/api 增加一个 S3 SDK 依赖；签名逻辑在测试里用本地 HTTP 假 S3 校验。
 */
import { createHash, createHmac } from 'node:crypto';
import { mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';

export interface ObjectStorage {
  put(bucket: string, key: string, body: Buffer, contentType: string): Promise<{ sha256: string }>;
  get(bucket: string, key: string): Promise<Buffer>;
  exists(bucket: string, key: string): Promise<boolean>;
  delete(bucket: string, key: string): Promise<void>;
  /** 返回完整键（含 prefix）。 */
  list(bucket: string, prefix: string): Promise<string[]>;
}

export function sha256Hex(body: Buffer | string): string {
  return createHash('sha256').update(body).digest('hex');
}

function safeRelative(bucket: string, key: string): string {
  const cleanBucket = bucket.replace(/[^a-zA-Z0-9._-]/g, '');
  const cleanKey = key
    .split('/')
    .filter((segment) => segment !== '' && segment !== '.' && segment !== '..')
    .join('/');
  if (!cleanBucket || !cleanKey) throw new Error(`非法对象路径：${bucket}/${key}`);
  return join(cleanBucket, cleanKey);
}

/** 本地文件系统实现：测试与 demo 用；bucket 作为根下的一级目录。 */
export class FsStorage implements ObjectStorage {
  private constructor(private readonly root: string) {}

  static async create(root: string): Promise<FsStorage> {
    const absolute = resolve(root);
    await mkdir(absolute, { recursive: true });
    return new FsStorage(absolute);
  }

  async put(bucket: string, key: string, body: Buffer): Promise<{ sha256: string }> {
    const path = join(this.root, safeRelative(bucket, key));
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, body);
    return { sha256: sha256Hex(body) };
  }

  async get(bucket: string, key: string): Promise<Buffer> {
    return readFile(join(this.root, safeRelative(bucket, key)));
  }

  async exists(bucket: string, key: string): Promise<boolean> {
    try {
      const info = await stat(join(this.root, safeRelative(bucket, key)));
      return info.isFile();
    } catch {
      return false;
    }
  }

  async delete(bucket: string, key: string): Promise<void> {
    await rm(join(this.root, safeRelative(bucket, key)), { force: true });
  }

  async list(bucket: string, prefix: string): Promise<string[]> {
    const base = join(this.root, safeRelative(bucket, prefix || '.') .replace(/\/?$/, ''));
    const root = join(this.root, bucket);
    const result: string[] = [];
    const walk = async (dir: string): Promise<void> => {
      let entries;
      try {
        entries = await readdir(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) await walk(full);
        else result.push(full.slice(root.length + 1).split('\\').join('/'));
      }
    };
    await walk(base);
    return result.filter((key) => key.startsWith(prefix));
  }
}

export interface S3Options {
  endpoint: string;
  accessKey: string;
  secretKey: string;
  region?: string;
}

/** MinIO / S3 兼容实现（path-style + SigV4）。 */
export class S3Storage implements ObjectStorage {
  private readonly endpoint: string;
  private readonly region: string;

  constructor(private readonly options: S3Options) {
    this.endpoint = options.endpoint.replace(/\/$/, '');
    this.region = options.region ?? 'us-east-1';
  }

  private async signedFetch(
    method: 'PUT' | 'GET' | 'HEAD' | 'DELETE',
    bucket: string,
    key: string,
    body: Buffer | null,
    query = '',
  ): Promise<Response> {
    const url = new URL(
      `${this.endpoint}/${encodeURIComponent(bucket)}${key ? `/${key.split('/').map(encodeURIComponent).join('/')}` : ''}`,
    );
    if (query) url.search = query;
    const amzDate = new Date().toISOString().replace(/[:-]|\.\d{3}/g, '');
    const shortDate = amzDate.slice(0, 8);
    const payloadHash = sha256Hex(body ?? Buffer.alloc(0));
    const canonicalQuery = [...url.searchParams.entries()]
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
      .join('&');
    const canonicalUri = url.pathname;
    const canonicalHeaders = `host:${url.host}\nx-amz-content-sha256:${payloadHash}\nx-amz-date:${amzDate}\n`;
    const signedHeaders = 'host;x-amz-content-sha256;x-amz-date';
    const canonicalRequest = [
      method,
      canonicalUri,
      canonicalQuery,
      canonicalHeaders,
      signedHeaders,
      payloadHash,
    ].join('\n');
    const credentialScope = `${shortDate}/${this.region}/s3/aws4_request`;
    const stringToSign = [
      'AWS4-HMAC-SHA256',
      amzDate,
      credentialScope,
      sha256Hex(canonicalRequest),
    ].join('\n');
    const kDate = createHmac('sha256', `AWS4${this.options.secretKey}`).update(shortDate).digest();
    const kRegion = createHmac('sha256', kDate).update(this.region).digest();
    const kService = createHmac('sha256', kRegion).update('s3').digest();
    const kSigning = createHmac('sha256', kService).update('aws4_request').digest();
    const signature = createHmac('sha256', kSigning).update(stringToSign).digest('hex');
    const authorization = `AWS4-HMAC-SHA256 Credential=${this.options.accessKey}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;
    return fetch(url, {
      method,
      headers: {
        host: url.host,
        'x-amz-date': amzDate,
        'x-amz-content-sha256': payloadHash,
        authorization,
        ...(body ? { 'content-type': 'application/octet-stream' } : {}),
      },
      ...(body ? { body } : {}),
    });
  }

  private ensureOk(response: Response, action: string, allowed: number[] = [200, 204]): void {
    if (!allowed.includes(response.status)) {
      throw new Error(`S3 ${action} 失败：HTTP ${response.status} ${response.statusText}`);
    }
  }

  async ensureBucket(bucket: string): Promise<void> {
    const response = await this.signedFetch('PUT', bucket, '', null);
    this.ensureOk(response, 'create-bucket', [200, 204, 409]);
  }

  async put(bucket: string, key: string, body: Buffer): Promise<{ sha256: string }> {
    const response = await this.signedFetch('PUT', bucket, key, body);
    this.ensureOk(response, `put ${bucket}/${key}`);
    return { sha256: sha256Hex(body) };
  }

  async get(bucket: string, key: string): Promise<Buffer> {
    const response = await this.signedFetch('GET', bucket, key, null);
    this.ensureOk(response, `get ${bucket}/${key}`);
    return Buffer.from(await response.arrayBuffer());
  }

  async exists(bucket: string, key: string): Promise<boolean> {
    const response = await this.signedFetch('HEAD', bucket, key, null);
    if (response.status === 404) return false;
    this.ensureOk(response, `head ${bucket}/${key}`);
    return true;
  }

  async delete(bucket: string, key: string): Promise<void> {
    const response = await this.signedFetch('DELETE', bucket, key, null);
    this.ensureOk(response, `delete ${bucket}/${key}`, [200, 204, 404]);
  }

  async list(bucket: string, prefix: string): Promise<string[]> {
    const query = `list-type=2&prefix=${encodeURIComponent(prefix)}`;
    const response = await this.signedFetch('GET', bucket, '', null, query);
    this.ensureOk(response, `list ${bucket}/${prefix}`);
    const xml = await response.text();
    const keys = [...xml.matchAll(/<Key>([^<]*)<\/Key>/g)].map((match) =>
      (match[1] ?? '')
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>'),
    );
    return keys.filter((key) => key.startsWith(prefix));
  }
}

export function s3StorageFromEnv(): S3Storage {
  const endpoint = process.env.MINIO_ENDPOINT ?? 'http://127.0.0.1:9000';
  const accessKey = process.env.MINIO_ACCESS_KEY ?? 'dssaas';
  const secretKey = process.env.MINIO_SECRET_KEY ?? 'dssaas_dev_secret';
  return new S3Storage({ endpoint, accessKey, secretKey });
}
