/**
 * A durable local store for the TypeScript kit.
 *
 * A write lands on disk first and reaches the server afterwards, so an app
 * built on this keeps working with no network and opens with what it had
 * last time. What the engine keeps is the published sync contract, which is
 * behaviour rather than code: any engine holding to it is correct, whatever
 * language it is written in.
 *
 * Three layers, not one. Server state is what the server last said; the
 * outbox is what this client has written and not yet sent; visible state is
 * the first with the second replayed over it. That is what lets another
 * device's change arrive without hiding an edit this device has typed, and
 * it is why nothing here keeps a second copy of a pending row.
 *
 * `@libsql/client` and `drizzle-orm` are optional peers, so a consumer that
 * does not want a local store does not pay for one.
 */
export {
  openLocalStore,
  ReadOnlyStoreError,
  StoreIdentityMismatchError,
  StoreUnrecoverableError,
} from "./store/index.js";
export type {
  LocalStore,
  LocalStoreScope,
  OpenLocalStoreOptions,
  LocalDb,
  Executor,
  LocalTransaction,
  CreateItemMutation,
  CreateEdgeMutation,
  MutationLayer,
  OutboxLayer,
  DeadLetterLayer,
  ServerStateLayer,
  SyncStateLayer,
  VisibleLayer,
  EnqueueInput,
  StoreRecovery,
  RecoveryReason,
} from "./store/index.js";

export { createOutboxDrain, DEFAULT_RETRY_CEILING } from "./drain.js";
export type { DrainOptions, DrainResult, OutboxDrain } from "./drain.js";

export { createLocalSync } from "./sync.js";
export type { LocalSync, LocalSyncOptions } from "./sync.js";

export { createLocalEngine } from "./engine.js";
export type {
  LocalEngine,
  LocalEngineOptions,
  LocalEngineStatus,
} from "./engine.js";

export {
  createProjection,
  DEFAULT_PROJECTION_MAX_ITEMS,
} from "./projection.js";
export type {
  ProjectionCollection,
  ProjectionOptions,
  ProjectionUtils,
} from "./projection.js";

export { applyEvent } from "./apply.js";
export type { ApplyOutcome } from "./apply.js";

export { importAll, PendingWritesError } from "./import.js";
export type { ImportOptions, ImportResult } from "./import.js";

export { classifyFailure } from "./classify.js";
export type { Verdict } from "./classify.js";

export { SINGLE_ACCOUNT, SINGLE_SPACE } from "./types.js";
export type {
  BlockedReason,
  ConnectionState,
  DeadLetterEntry,
  DeadLetterReason,
  LocalEngineEvent,
  LocalEngineEventListener,
  MutationKind,
  OutboxEntry,
  OutboxRowState,
  StoreIdentity,
  SyncStateRow,
  TargetKind,
  VisibleEdge,
  VisibleItem,
  VisibleMetadata,
} from "./types.js";
