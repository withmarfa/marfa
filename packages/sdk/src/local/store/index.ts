import type { Client } from "@libsql/client";
import type { StoreIdentity } from "../types.js";
import type { Executor, LocalTransaction } from "./executor.js";
import { openDatabase, type LocalDb } from "./open.js";
import { createDeadLetterLayer, type DeadLetterLayer } from "./dead-letters.js";
import { createMutationLayer, type MutationLayer } from "./mutations.js";
import { createOutboxLayer, type OutboxLayer } from "./outbox.js";
import {
  createServerStateLayer,
  type ServerStateLayer,
} from "./server-state.js";
import { createSyncStateLayer, type SyncStateLayer } from "./sync-state.js";
import { createVisibleLayer, type VisibleLayer } from "./visible.js";

/** Everything the store can do against one executor — the database itself,
 *  or an open transaction. */
export interface LocalStoreScope {
  /** Server state, in three layers so an item write cannot reach the
   *  metadata one. */
  server: ServerStateLayer;
  /** The queue of unsent mutations, which is also the pending layer. */
  outbox: OutboxLayer;
  /** Writes the server refused, kept for the app to show. */
  deadLetters: DeadLetterLayer;
  /** Cursor and identity. */
  syncState: SyncStateLayer;
  /** Server state with this client's queued mutations replayed over it. */
  visible: VisibleLayer;
  /** The writes an app makes. */
  mutations: MutationLayer;
}

export interface LocalStore extends LocalStoreScope {
  /** Which server, space and account this store belongs to. */
  readonly identity: StoreIdentity;
  /** The drizzle handle, for callers that need a query this surface does
   *  not have. */
  readonly db: LocalDb;
  /** The libsql client. An escape hatch, and the seam a lock will need. */
  readonly raw: Client;
  /**
   * Run several statements as one. Everything the callback touches is on
   * the transaction, so a failure leaves the store as it was rather than
   * half-changed.
   */
  transaction<T>(fn: (scope: LocalStoreScope) => Promise<T>): Promise<T>;
  close(): void;
}

export interface OpenLocalStoreOptions {
  /**
   * Where the store lives. A filesystem path, or `:memory:` — which is
   * shared across the process, so anything needing isolation uses a file.
   */
  path: string;
  /** Which server, space and account this store belongs to. */
  identity: StoreIdentity;
  /** Overrides the clock the mutation layer stamps with. */
  now?: () => string;
}

function buildScope(exec: Executor, now: () => string): LocalStoreScope {
  const server = createServerStateLayer(exec);
  const outbox = createOutboxLayer(exec);
  const deadLetters = createDeadLetterLayer(exec);
  const syncState = createSyncStateLayer(exec);
  const visible = createVisibleLayer(server, outbox);
  const mutations = createMutationLayer({ server, outbox, visible, now });
  return { server, outbox, deadLetters, syncState, visible, mutations };
}

/**
 * Open a durable local store.
 *
 * Migrations run forward on open; the migrator is drizzle's own, against
 * the folder this package ships, so the store carries a version rather than
 * being reconstructed from whatever the code happens to expect.
 */
export async function openLocalStore(
  options: OpenLocalStoreOptions,
): Promise<LocalStore> {
  const now = options.now ?? (() => new Date().toISOString());
  const { db, raw, close } = await openDatabase(options.path);
  const scope = buildScope(db, now);
  await scope.syncState.ensure(options.identity);

  return {
    ...scope,
    identity: options.identity,
    db,
    raw,
    transaction: <T>(fn: (scope: LocalStoreScope) => Promise<T>): Promise<T> =>
      db.transaction(async (tx: LocalTransaction) => fn(buildScope(tx, now))),
    close,
  };
}

export type { LocalDb } from "./open.js";
export type { Executor, LocalTransaction } from "./executor.js";
export type { CreateItemMutation, CreateEdgeMutation } from "./mutations.js";
export type { EnqueueInput, OutboxLayer } from "./outbox.js";
export type { DeadLetterLayer } from "./dead-letters.js";
export type { ServerStateLayer } from "./server-state.js";
export type { SyncStateLayer } from "./sync-state.js";
export type { VisibleLayer } from "./visible.js";
export type { MutationLayer } from "./mutations.js";
