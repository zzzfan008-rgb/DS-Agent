/**
 * @dssaas/adapters-pdd —— 拼多多适配（中心侧，M1 骨架）。
 *
 * 当前能力：
 * - 接口注册表：docs/01 §2.1–§2.6 的 28 条能力逐条建桩，未核验项全部 null + TODO；
 * - HTTP client：dry-run 门禁、签名占位、时间戳/nonce 防重放、令牌桶限流、退避重试、
 *   请求/响应脱敏留档；
 * - 录制回放：fixture 加载/匹配、回放 transport、录制 transport（格式对齐 tests/contract）；
 * - 上架包兜底：商品/SKU/尺码/成分/属性 → CSV + XLSX + manifest（含 payload_hash）。
 *
 * 明确不做：
 * - 不写任何平台密钥；缺省即 dry-run；
 * - 不编造 method/限流/字段名；
 * - 不直接写平台：写路径必须由 apps/api 的写入门调用（后续 M4）。
 */

export const PDD_ADAPTER = '@dssaas/adapters-pdd';

export {
  loadPddConfig,
  loadPddEnvFiles,
  describePddConfig,
  type PddConfig,
  type PddConfigSummary,
  type PddDryRunReason,
  type PddEnvironment,
  type PddMode,
} from './config.js';

export {
  PddError,
  isPddError,
  configError,
  defaultNextAction,
  type PddErrorClass,
  type PddErrorCode,
  type PddErrorInit,
  type PddNextAction,
} from './errors.js';

export {
  InterfaceRegistry,
  createInterfaceRegistry,
  pddRegistry,
  type InterfaceFilter,
} from './registry/index.js';
export { PDD_INTERFACES, PDD_INTERFACE_COUNT } from './registry/pdd-interfaces.js';
export {
  PDD_SOURCE_DOC,
  type PddFallbackChannel,
  type PddInterfaceConclusion,
  type PddInterfaceSection,
  type PddInterfaceSpec,
  type PddInterfaceTodos,
  type PddRegistryStats,
  type PddWriteLevel,
  type UnverifiedInterfaceRow,
  type VerifiedPddInterfaceSpec,
} from './registry/types.js';

export {
  PddClient,
  createPddClientFromEnv,
  type PddCallDryRun,
  type PddCallOptions,
  type PddCallRequestPreview,
  type PddCallResult,
  type PddCallSuccess,
  type PddClientOptions,
} from './http/client.js';
export { FetchTransport, assertSafeHttpUrl, type HttpTransport, type TransportRequest, type TransportResponse } from './http/transport.js';
export {
  ReplayTransport,
  RecordingTransport,
  loadReplayFixtures,
  matchFixture,
  saveReplayFixtures,
  validateReplayFixture,
  type LoadedFixture,
  type RecordingTransportOptions,
  type ReplayFixture,
  type ReplayTransportOptions,
} from './http/replay.js';
export {
  PlaceholderHmacSha256Signer,
  PLACEHOLDER_SIGNATURE_SCHEME,
  SIGNATURE_HEADERS,
  SIGNATURE_TODO,
  TimestampReplayGuard,
  buildPlaceholderSignatureMaterial,
  computePlaceholderSignature,
  computeSha256Hex,
  reserveOutboundNonce,
  type ReplayVerdict,
  type RequestSigner,
  type SigningContext,
} from './http/signer.js';
export { TokenBucketLimiter, type RateLimiter, type TokenBucketLimiterOptions } from './http/rate-limiter.js';
export { DEFAULT_RETRY_POLICY, computeBackoffDelayMs, hasAttemptsLeft, validateRetryPolicy, type RetryPolicy } from './http/retry.js';
export {
  JsonFileArchiver,
  NullArchiver,
  type CallArchiveRecord,
  type RequestArchiver,
} from './http/archive.js';
export {
  classifyHttpResponse,
  classifyTransportError,
  extractEnvelopeError,
  parseRetryAfterMs,
  type HttpResponseLike,
} from './http/classification.js';

export {
  buildPddListingPackage,
  PDD_LISTING_PACKAGE_GENERATOR,
  PDD_LISTING_PACKAGE_PROFILE,
  PDD_LISTING_PACKAGE_SCHEMA_VERSION,
  type BuildListingPackageOptions,
} from './listing-package/exporter.js';
export {
  ALLOWED_FITS,
  ALLOWED_MEASUREMENTS,
  ALLOWED_SIZE_CODES,
  ListingPackageValidationError,
  SIZE_ALIASES,
  hasBlockingIssues,
  normalizeSizeCode,
  validateAndNormalizeProduct,
} from './listing-package/validation.js';
export type {
  ListingAttributeInput,
  ListingFabricItemInput,
  ListingIssueSeverity,
  ListingPackageFile,
  ListingPackageIssue,
  ListingPackageManifest,
  ListingPackageProfile,
  ListingPackageResult,
  ListingProductInput,
  ListingSizeChartRowInput,
  ListingSkuInput,
  NormalizedListingProduct,
  PackageTable,
} from './listing-package/types.js';
