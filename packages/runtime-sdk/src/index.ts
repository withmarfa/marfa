/**
 * @mymehq/runtime-sdk — public exports.
 *
 * Imported by per-Integration Workers under `integrations/<name>/`.
 * The Worker registers handlers via `register*Handler`, exports
 * `PerConnectionState` so Cloudflare's DO machinery can instantiate
 * it, and exposes a default `fetch` + queue handler that the runtime
 * dispatches messages to.
 *
 * Layer 1 PR 2 ships the API surface; Layer 1 PR 3 wires the queue
 * consumer entrypoint that calls `dispatchMessage`.
 */
export {
  PerConnectionState,
  PerConnectionStateCore,
} from "./per-connection-state.js";
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

export { ConnectionClient, MymeApiError } from "./connection-client.js";
export type {
  ConnectionClientOptions,
  CreateItemInput,
  ItemResource,
  ItemState,
  ListItemsQuery,
  ListItemsPage,
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
export type { ConsumerEnvironment } from "./queue-consumer.js";

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
} from "./types.js";
export {
  SDK_DEFAULT_HOP_BUDGET,
  nextHopMetadata,
  decodeBase64ToArrayBuffer,
} from "./types.js";
