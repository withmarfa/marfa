// Client
export { MarfaClient } from "./client.js";
export type {
  ClientConfig,
  UpdateOptions,
  ListFilters,
  SearchFilters,
  MetadataInput,
  ItemWithExtensions,
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
  TenantApiKeySummary,
  SecureStorage,
} from "./client.js";

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
  Tenant,
  TenantStatus,
  TenantMetrics,
  TenantActivityEntry,
  TenantQuota,
} from "@withmarfa/shared";
export type { TypeSchema } from "@withmarfa/shared";
