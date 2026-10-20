/**
 * @dssaas/adapters-1688 —— 1688 适配（中心侧）。
 *
 * 状态：M1 骨架。**平台契约未核验**（docs/02 §0）：全部 method 名、字段名、限流数字、
 * 签名算法、导入包模板均为 TODO（见 `TODO_ITEMS`）。本包已交付的是：
 *
 * - 领域模型：阶梯价/起批价/区间价（`domain/price-tiers.ts`）、起批量与混批
 *   （`domain/moq.ts`）、代发条款（`domain/dropship.ts`）、规格轴与矩阵
 *   （`domain/spec.ts`）、尺码表/成分/洗护/资质校验（`domain/*`）；
 * - 字段映射：`mapping/attributes.ts`（1688 属性映射，全部 draft + TODO）；
 * - 上架包：`listing/exporter.ts`（内部规范化包 + 门禁 + JSON/CSV 导出）；
 * - 客户端骨架：`client/*`（签名端口、限流、重试、留档、接口注册表桩）；
 * - 录制回放：`testing/fixtures.ts`（机制 + 合成样例，非平台真实报文）。
 *
 * 使用约束：
 * - 本包只能被 `apps/api`（写入门）与 `apps/worker` 引用，**不得**被前端直接引用；
 * - `Alibaba1688Client.execute()` 在契约核验前必定失败（`CONTRACT_NOT_VERIFIED`），
 *   这是刻意的安全默认值，不是缺陷；
 * - 任何真实凭据（appKey/appSecret/token）都不进入本包，签名可下沉到 `packages/edge-proxy`。
 */

export const ALIBABA_1688_ADAPTER = '@dssaas/adapters-1688';

// ---- 基础设施 ----
export { AdapterError, DomainValidationError } from './errors.js';
export type { AdapterErrorCode, AdapterErrorInit } from './errors.js';
export { TODO_ITEMS, todo, describeTodo, openTodos } from './todo.js';
export type { TodoId, TodoItem } from './todo.js';
export {
  blocker,
  warning,
  success,
  failure,
  hasBlocker,
  formatIssue,
  dedupeIssues,
  describeValue,
  isInteger,
  asRecord,
} from './validation.js';
export type { Severity, ValidationIssue, ValidationResult } from './validation.js';
export { canonicalJson, canonicalHash, sha256Hex } from './json.js';
export { escapeCsvCell, toCsv } from './csv.js';

// ---- 领域模型 ----
export {
  MAX_PRICE_CENTS,
  MAX_QTY,
  isPriceCents,
  isQty,
  formatCents,
  displayCents,
  centsFromYuan,
} from './domain/money.js';
export {
  PRICE_TIER_MAX_COUNT,
  PRICE_TIER_RULE_IDS,
  validatePriceTiers,
  assertPriceTiers,
  isPriceMonotonic,
  computePriceRange,
  resolveTierPrice,
  priceTiersDigest,
  describePriceTiers,
} from './domain/price-tiers.js';
export type {
  PriceTier,
  PriceTierRuleId,
  PriceTierValidateOptions,
  PriceRange,
  ResolvedTierPrice,
} from './domain/price-tiers.js';
export {
  MOQ_UNITS,
  MOQ_UNIT_LABEL,
  validateMoq,
  assertMoq,
  orderableQty,
  checkMoqAgainstTiers,
  unitLabel,
} from './domain/moq.js';
export type { Moq, MoqUnit, OrderableQty } from './domain/moq.js';
export {
  DROPSHIP_STOCK_SOURCES,
  DROPSHIP_FIELD_MAP,
  validateDropship,
  assertDropship,
} from './domain/dropship.js';
export type { DropshipTerms, DropshipStockSource, DropshipFieldMapping } from './domain/dropship.js';
export {
  ALPHA_SIZE_ORDER,
  SIZE_ALIASES,
  REJECTED_SIZE_CODES,
  normalizeSizeCode,
  normalizeColorCode,
  sizeOrderFor,
  buildSpecAxes,
  specKeyOf,
  specBlockers,
} from './domain/spec.js';
export type {
  SpecSkuInput,
  SpecValue,
  SpecAxis,
  SpecMatrixCell,
  SpecBuildResult,
  NormalizedSpecSku,
  SizeCodeResolution,
  ColorCodeResolution,
} from './domain/spec.js';
export {
  MEASUREMENT_KEYS,
  REQUIRED_MEASUREMENTS,
  requiredMeasuresFor,
  validateSizeChart,
  checkRecommendRanges,
  checkSizeChartCoverage,
} from './domain/size-chart.js';
export type { MeasurementKey, SizeSystem, SizeChartRow, SizeChartRowInput } from './domain/size-chart.js';
export {
  FIBERS,
  FIBER_ALIASES,
  MATERIAL_NOTES,
  validateMaterials,
  renderMaterialsText,
  normalizeFiberName,
} from './domain/fabric.js';
export type { Fiber, MaterialNote, MaterialRow } from './domain/fabric.js';
export {
  CARE_SLOTS,
  CARE_CODEBOOK,
  CARE_SOURCES,
  validateCare,
  careTextLines,
} from './domain/care.js';
export type { CareSlot, CareSlotValue, CareInstructions, CareSource } from './domain/care.js';
export {
  SAFETY_CATEGORIES,
  REPORT_STATUSES,
  evaluateQualification,
  qualificationAllowsPublish,
  unknownQualification,
} from './domain/qualification.js';
export type {
  QualificationInput,
  QualificationReport,
  QualificationStatus,
  QualificationEvaluation,
  QualificationOptions,
} from './domain/qualification.js';

// ---- 映射 ----
export {
  MAPPING_PLATFORM,
  MAPPING_CSV_HEADERS,
  DEFAULT_ATTR_PATHS,
  buildAttributeMappings,
  renderMappingCsv,
} from './mapping/attributes.js';
export type {
  AttributeMappingRow,
  AttributeMappingInput,
  AttributeMappingResult,
  AttrPathKey,
  AttrType,
  MappingStatus,
  MappingSource,
  VerifiedMappingEntry,
  VerifiedMappingIndex,
} from './mapping/attributes.js';

// ---- 上架包 ----
export {
  LISTING_PACKAGE_SCHEMA_VERSION,
  hashListingPackage,
  describeListingPackage,
} from './listing/package.js';
export type {
  ListingPackageInput,
  ListingPackageDraft,
  ListingPackageSku,
  MediaRef,
  ListingSkuInput,
} from './listing/package.js';
export {
  CONTRACT_TODO_IDS,
  buildListingPackage,
  renderListingPackageJson,
  renderListingPackageCsv,
  PACKAGE_CSV_HEADERS,
  packageAttributePaths,
} from './listing/exporter.js';
export type { BuildListingPackageOptions } from './listing/exporter.js';

// ---- 客户端 ----
export {
  UNVERIFIED_PROTOCOL,
  OPERATIONS,
  OPERATION_LIST,
  DEFAULT_CATALOG,
  getOperation,
  listOperations,
  operationsByCapability,
  verificationGaps,
  registrySummary,
} from './client/registry.js';
export type {
  OperationDescriptor,
  OperationCatalog,
  OperationCapability,
  OperationChannel,
  RiskLevel,
  VerificationGap,
} from './client/registry.js';
export { UNVERIFIED_SIGNER, canonicalizeParams, requestFingerprint } from './client/signature.js';
export type { RequestSigner, SignInput, SignedRequest } from './client/signature.js';
export { ASSUMED_CLIENT_RATE_LIMIT, TokenBucketRateLimiter } from './client/limiter.js';
export type { RateLimitConfig, RateLimiter } from './client/limiter.js';
export {
  DEFAULT_RETRY_POLICY,
  MAX_RETRY_AFTER_MS,
  policyForOperation,
  backoffDelay,
  parseRetryAfter,
  executeWithRetry,
} from './client/retry.js';
export type { RetryPolicy, RetryContext, RetryOutcome } from './client/retry.js';
export {
  REDACTION_PLACEHOLDER,
  SENSITIVE_KEY_PATTERNS,
  isSensitiveKey,
  redactHeaders,
  redactBody,
  redactUrl,
  archiveRequest,
  archiveResponse,
  MemoryArchiveSink,
  DirectoryArchiveSink,
  NOOP_ARCHIVE_SINK,
} from './client/archive.js';
export type { ArchiveEntry, ArchiveSink, ArchivedRequest, ArchivedResponse } from './client/archive.js';
export { systemClock, systemRandom, httpTransport } from './client/types.js';
export type { Clock, RandomSource, Transport, HttpRequest, HttpResponse, HttpMethod } from './client/types.js';
export { Alibaba1688Client, createClient } from './client/client.js';
export type { ClientOptions, ClientPlan, ExecuteOptions, ExecuteResult } from './client/client.js';

// ---- 测试工具（仅测试/回放；不得用于生产签名）----
export {
  FixedClock,
  SeededRandom,
  FakeTransport,
  ForbiddenTransport,
  jsonResponse,
  createTestSigner,
} from './testing/fakes.js';
export type { TransportHandler } from './testing/fakes.js';
export {
  createFixture,
  ReplayTransport,
  RecordingTransport,
  fixtureFileName,
  fixturePath,
  saveFixture,
  loadFixtureFile,
  loadFixtures,
  assertFixtureHonesty,
} from './testing/fixtures.js';
export type { ContractFixture, FixtureMeta } from './testing/fixtures.js';
