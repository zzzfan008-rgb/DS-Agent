/** 知识库内部工具：uuid v5、Postgres 数组字面量、向量字面量。 */
import { createHash } from 'node:crypto';

const DNS_NAMESPACE = '6ba7b810-9dad-11d1-80b4-00c04fd430c8';

/** RFC 4122 v5（SHA-1）稳定 UUID：把 source_ref 映射成 kb_document.source_id。 */
export function uuidv5(name: string, namespace: string = DNS_NAMESPACE): string {
  const ns = Buffer.from(namespace.replaceAll('-', ''), 'hex');
  const hash = createHash('sha1').update(Buffer.concat([ns, Buffer.from(name, 'utf8')])).digest();
  hash[6] = (hash[6]! & 0x0f) | 0x50;
  hash[8] = (hash[8]! & 0x3f) | 0x80;
  const hex = hash.toString('hex').slice(0, 32);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** text[] 字面量（元素用双引号转义）；仅用于拼进参数值，不拼 SQL 片段。 */
export function pgTextArray(values: readonly string[]): string {
  return `{${values.map((value) => `"${value.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`).join(',')}}`;
}

/** pgvector 文本字面量：[1,2,…]。 */
export function vectorLiteral(vector: readonly number[]): string {
  return `[${vector.map((value) => (Number.isFinite(value) ? value.toFixed(8) : '0')).join(',')}]`;
}

/** L2 归一化；零向量返回 null（禁止写零向量，docs/09 E6）。 */
export function l2Normalize(vector: readonly number[]): number[] | null {
  let norm = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0));
  if (!Number.isFinite(norm) || norm === 0) return null;
  return vector.map((value) => value / norm);
}
