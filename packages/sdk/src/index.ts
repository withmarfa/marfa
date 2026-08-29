// Client
export { MarfaClient } from "./client.js";
export type {
  ClientConfig,
  UpdateOptions,
  ListFilters,
  SearchFilters,
  MetadataInput,
  ItemWithExtensions,
  HydratedEdges,
  ItemDetail,
  ItemDetailInclude,
  BulkInput,
  BulkItemInput,
  BulkMode,
  BulkResult,
  BulkResultEntry,
  BulkOutcome,
  BulkActionInput,
  BulkActionFilter,
  BulkActionResult,
  BulkActionErrorEntry,
  BulkEdgeInput,
  BulkEdgeInputItem,
  BulkEdgeResult,
  BulkEdgeResultEntry,
  CreateWithAttachmentsInput,
  CreateWithAttachmentsAttachment,
  CreateWithAttachmentsResult,
  SpaceApiKeySummary,
  DriftedPlatformType,
  SecureStorage,
  Occurrence,
  OccurrenceSeriesError,
  OccurrencesScan,
  OccurrencesResult,
  ListOccurrencesOptions,
} from "./client.js";

// Pagination
export { paginate, collect, PageLimitExceededError } from "./pagination.js";
export type { PageFetcher, CollectOptions } from "./pagination.js";

// Errors
export {
  MarfaError,
  NotFoundError,
  ValidationError,
  ConflictError,
  UnauthorizedError,
  ForbiddenError,
} from "./errors.js";

// Conflict types
export type {
  ConflictStrategy,
  ConflictData,
  ConflictResolver,
  ConflictAutoMergedEvent,
  ConflictAutoMergeListener,
} from "./conflict.js";

// Change stream
export { CatchupTooOldError, SseParser } from "./events.js";
export type {
  MarfaEvent,
  MarfaItemEvent,
  MarfaEdgeEvent,
  CatchupTooOld,
  SubscribeOptions,
  Subscription,
} from "./events.js";

// Type authoring helper
export { defineType } from "./define-type.js";

// Webhook signature verification (inbound — for receivers)
export { verifyWebhookSignature } from "./webhooks.js";
export type {
  WebhookVerifyResult,
  WebhookVerifyReason,
  VerifyWebhookSignatureInput,
} from "./webhooks.js";

// Re-export key types from @withmarfa/shared
export type {
  Item,
  ItemWithMetadata,
  ItemEdgesBlock,
  CreateItemInput,
  Edge,
  Metadata,
  Version,
  ApiKey,
  CreateKeyInput,
  UpdateKeyInput,
  PaginatedResult,
  SearchResult,
  ConflictSnapshot,
  ItemState,
  MergePolicy,
  MergeStrategy,
  Profile,
  UpdateProfileInput,
  Space,
  SpaceStatus,
  SpaceMetrics,
  SpaceActivityEntry,
  SpaceQuota,
} from "@withmarfa/shared";
export type { TypeSchema } from "@withmarfa/shared";
