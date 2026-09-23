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
  BulkActionJob,
  BulkActionJobStatus,
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
//
// Every class the client throws, because a class a caller cannot import is
// a class a caller cannot catch: the two bulk-job errors exist so a caller
// can branch on which terminal state a job reached, and without them here
// the only handle is a string comparison on `code`.
export {
  MarfaError,
  NotFoundError,
  ValidationError,
  AncestorUnavailableError,
  ConflictError,
  EdgeConflictError,
  UnauthorizedError,
  ForbiddenError,
  BulkJobCanceledError,
  BulkJobFailedError,
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
export {
  hydrateTypeRegistry,
  validateProperties,
  // The registry's two readers, from the same instance for the same reason.
  getResolvedFields,
  getTypeSchema,
} from "@withmarfa/shared";
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
  // Both halves of the configuration door. `config.get` returns the second
  // and `config.set` takes either, so a consumer that cannot name them here
  // has to reach into the other package to declare a variable holding what
  // this client just handed it.
  InstanceConfig,
  InstanceConfigResponse,
} from "@withmarfa/shared";
export type { TypeSchema } from "@withmarfa/shared";
