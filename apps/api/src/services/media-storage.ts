/**
 * t39：媒体对象读取（下载端点用）。
 *
 * 与 worker 的 ObjectStorage 保持同一套对象键约定；API 只读，不依赖 worker 包：
 * - 测试/本地：MEDIA_FS_ROOT 下 `<bucket>/<key>`；
 * - 运行期：MinIO/S3 path-style GET（SigV4，只实现 GET）。
 */
import { createHash, createHmac } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { ApiError } from '../lib/errors.js';

function sha256Hex(body: Buffer | string): string {
  return createHash('sha256').update(body).digest('hex');
}

function safeRelative(bucket: string, key: string): string {
  const cleanBucket = bucket.replace(/[^a-zA-Z0-9._-]/g, '');
  const cleanKey = key
    .split('/')
    .filter((segment) => segment !== '' && segment !== '.' && segment !== '..')
    .join('/');
  if (!cleanBucket || !cleanKey) throw new ApiError('validation_failed', '非法对象路径');
  return join(cleanBucket, cleanKey);
}

async function s3Get(bucket: string, key: string): Promise<Buffer> {
  const endpoint = (process.env.MINIO_ENDPOINT ?? 'http://127.0.0.1:9000').replace(/\/$/, '');
  const accessKey = process.env.MINIO_ACCESS_KEY ?? 'dssaas';
  const secretKey = process.env.MINIO_SECRET_KEY ?? 'dssaas_dev_secret';
  const region = process.env.MINIO_REGION ?? 'us-east-1';
  const url = new URL(
    `${endpoint}/${encodeURIComponent(bucket)}/${key.split('/').map(encodeURIComponent).join('/')}`,
  );
  const amzDate = new Date().toISOString().replace(/[:-]|\.\d{3}/g, '');
  const shortDate = amzDate.slice(0, 8);
  const payloadHash = sha256Hex(Buffer.alloc(0));
  const canonicalHeaders = `host:${url.host}\nx-amz-content-sha256:${payloadHash}\nx-amz-date:${amzDate}\n`;
  const signedHeaders = 'host;x-amz-content-sha256;x-amz-date';
  const canonicalRequest = ['GET', url.pathname, '', canonicalHeaders, signedHeaders, payloadHash].join('\n');
  const credentialScope = `${shortDate}/${region}/s3/aws4_request`;
  const stringToSign = ['AWS4-HMAC-SHA256', amzDate, credentialScope, sha256Hex(canonicalRequest)].join('\n');
  const kDate = createHmac('sha256', `AWS4${secretKey}`).update(shortDate).digest();
  const kRegion = createHmac('sha256', kDate).update(region).digest();
  const kService = createHmac('sha256', kRegion).update('s3').digest();
  const kSigning = createHmac('sha256', kService).update('aws4_request').digest();
  const signature = createHmac('sha256', kSigning).update(stringToSign).digest('hex');
  const authorization =
    `AWS4-HMAC-SHA256 Credential=${accessKey}/${credentialScope}, ` +
    `SignedHeaders=${signedHeaders}, Signature=${signature}`;

  const response = await fetch(url, {
    method: 'GET',
    headers: {
      host: url.host,
      'x-amz-date': amzDate,
      'x-amz-content-sha256': payloadHash,
      authorization,
    },
  });
  if (!response.ok) {
    throw new ApiError('provider_unavailable', `对象存储读取失败：HTTP ${response.status}`);
  }
  return Buffer.from(await response.arrayBuffer());
}

export async function readMediaObject(bucket: string, key: string): Promise<Buffer> {
  const root = process.env.MEDIA_FS_ROOT;
  if (root) {
    try {
      return await readFile(join(resolve(root), safeRelative(bucket, key)));
    } catch {
      throw new ApiError('not_found', '媒体对象不存在');
    }
  }
  return s3Get(bucket, key);
}
