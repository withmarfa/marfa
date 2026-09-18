// Client
export { MarfaClient } from "./client.js";
export type {
  ClientConfig,
  IdempotentWriteOptions,
  UpdateOptions,
  ListFilters,
  SystemTypesOptIn,
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
  AncestorUnavailableError,
  ConflictError,
  EdgeConflictError,
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
  StreamIncomplete,
  SubscribeOptions,
  Subscription,
} from "./events.js";

// Type authoring helper
export { defineType } from "./define-type.js";

// Local type-graph cache. Registers a `client.types.list()` payload into the
// shared registry so `validateProperties` answers the way the server does
// without a round trip — the piece a durable client needs to check a write
// against the instance's custom types before it queues one.
//
// `validateProperties` is re-exported beside it deliberately, and it is the
// only runtime value this file takes from `@withmarfa/shared` rather than a
// type. The pair reads and writes one module-level registry, so they have to
// come from one instance of that package. Documenting the helper here while
// leaving the function to a separate import invites a consumer whose tree
// resolves two copies: hydration fills one registry, validation reads the
// other, and every type comes back unknown with nothing anywhere reporting an
// error. Exporting both from one entry point is what makes that unreachable
// through the documented usage.
export { hydrateTypeRegistry, validateProperties } from "@withmarfa/shared";
export type {
  TypeRegistryHydration,
  // The return type of the function above. Exporting the value without the
  // type it returns leaves a consumer naming it by reaching into the other
  // package, which is the split this export exists to close.
  ValidationResult,
} from "@withmarfa/shared";

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
} from "@withmarfa/shared";
export type { TypeSchema } from "@withmarfa/shared";
