/**
 * `@withmarfa/runtime-sdk` — substrate-agnostic public surface.
 *
 * Imported by integration handler modules (`integrations/<name>/src/handlers.ts`)
 * and by both substrates (Cloudflare per-Integration Workers via
 * `@withmarfa/runtime-sdk/cloudflare`; the local-runtime supervisor inside
 * `@withmarfa/server`). This entry has no dependency on
 * `@cloudflare/workers-types` runtime symbols — handler code written
 * against it is portable across substrates.
 *
 * The Cloudflare-specific bootstrap (`createIntegrationWorker`,
 * `PerConnectionState` Durable Object, the DO storage proxy) lives at
 * `@withmarfa/runtime-sdk/cloudflare`.
 */
export { PerConnectionStateCore } from "./per-connection-state.js";
export type { PerConnectionInternalState } from "./per-connection-state.js";

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
  UploadBlobInput,
  UploadBlobResult,
} from "./connection-client.js";

export { createCursorStore } from "./cursor-store.js";
export type { CursorStore, CursorStorageAdapter } from "./cursor-store.js";

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
export type { ConsumerEnvironment, DlqProducer } from "./queue-consumer.js";

export { verifyHandler } from "./verify-handler.js";
export type {
  VerifyRequestBody,
  VerifyResponseBody,
} from "./verify-handler.js";

export type {
  CycleMetadata,
  QueueEnvelopeBase,
  WebhookMessage,
  WebhookHandlerInput,
  ScheduleMessage,
  ItemEventMessage,
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
