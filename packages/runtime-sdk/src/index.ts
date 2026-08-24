/**
 * `@withmarfa/runtime-sdk` — the surface integrations import.
 *
 * Imported by integration handler modules (`integrations/<namespace>/<name>/src/handlers.ts`)
 * and by the local-runtime supervisor inside `@withmarfa/server`, which
 * drives dispatch through `consumeBatch`'s semantics.
 */
export { ConnectionGoneError } from "./errors.js";

export {
  registerScheduleHandler,
  registerWebhookHandler,
  registerItemEventHandler,
  dispatchMessage,
  _resetHandlers,
} from "./handlers.js";
export type {
  ScheduleHandler,
  WebhookHandler,
  ItemEventHandler,
} from "./handlers.js";

export { ConnectionClient, MarfaApiError } from "./connection-client.js";
export type {
  ConnectionClientOptions,
  CreateItemInput,
  ItemResource,
  ItemState,
  ListItemsQuery,
  ListItemsPage,
  BulkUpsertOptions,
  BulkUpsertResult,
  BulkUpsertResponse,
  UploadBlobInput,
  UploadBlobResult,
} from "./connection-client.js";

export { createCursorStore } from "./cursor-store.js";
export type { CursorStore, CursorStorageAdapter } from "./cursor-store.js";

export {
  createMappingResolver,
  familyOnlyMappingResolver,
  type MappingResolver,
  type MappingResolution,
} from "./mapping.js";
export { createActivitySink } from "./activity.js";
export type {
  ActivitySink,
  ActivityInput,
  ActivitySeverity,
} from "./activity.js";

export { createEchoSuppression } from "./echo-suppression.js";
export type {
  EchoSuppression,
  EchoSuppressionConfig,
} from "./echo-suppression.js";

export type { ConnectionContext } from "./connection-context.js";

export { consumeBatch, buildConnectionContext } from "./queue-consumer.js";
export type {
  ConsumerEnvironment,
  DlqProducer,
  QueueDeliveryMessage,
} from "./queue-consumer.js";

export type {
  CycleMetadata,
  QueueEnvelopeBase,
  WebhookMessage,
  WebhookHandlerInput,
  ScheduleMessage,
  ItemEventMessage,
  ManualMessage,
  QueueMessage,
  HandlerResult,
  RuntimeCredential,
  FailureReason,
} from "./types.js";
export {
  SDK_DEFAULT_HOP_BUDGET,
  nextHopMetadata,
  decodeBase64ToArrayBuffer,
} from "./types.js";

export { computeNextRunAt, isValidCron } from "./cron.js";
