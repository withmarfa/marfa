import type { Client } from "@libsql/client";
import type { StoreIdentity } from "../types.js";
import type { Executor, LocalTransaction } from "./executor.js";
import { inspectDatabase, openDatabase, type LocalDb } from "./open.js";
import { acquireStoreLock } from "./lock.js";
import {
  setStoreAside,
  StoreUnrecoverableError,
  type StoreRecovery,
} from "./version.js";
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
  /**
   * Whether this handle may write.
   *
   * False when another engine already holds the store. Reads work; every
   * write refuses, including the cursor — which is the point, because two
   * engines advancing one cursor is how a store ends up claiming to have
   * applied events neither of them took.
   */
  readonly writer: boolean;
  /** The drizzle handle, for callers that need a query this surface does
   *  not have. */
  readonly db: LocalDb;
  /** The libsql client. An escape hatch. */
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
  /**
   * Told when a store had to be set aside and rebuilt.
   *
   * Everything in the report is work a person did — writes that never
   * left, refusals nobody has read — and the sidecar is the only copy of
   * it. An app that is told can offer it back; an app that is not gets a
   * store that quietly starts empty.
   */
  onRecovery?: (recovery: StoreRecovery) => void;
}

/** A store whose recorded identity is not the one asked for. */
export class StoreIdentityMismatchError extends Error {
  readonly held: StoreIdentity[];
  readonly wanted: StoreIdentity;
  constructor(wanted: StoreIdentity, held: StoreIdentity[]) {
    const describe = (id: StoreIdentity): string =>
      `${id.origin} space=${id.spaceId || "(single)"} account=${id.accountId || "(single)"}`;
    super(
      `@withmarfa/sdk/local: this store belongs to ${held.map(describe).join(", ")}, ` +
        `and was opened as ${describe(wanted)}. Refusing: a store holds one corpus and one cursor, ` +
        `and opening it as somebody else would apply one account's events over another's rows.`,
    );
    this.name = "StoreIdentityMismatchError";
    this.held = held;
    this.wanted = wanted;
  }
}

/** Every write path on a store another engine is holding. */
export class ReadOnlyStoreError extends Error {
  constructor(holder: string) {
    super(
      `@withmarfa/sdk/local: this store is open for writing by ${holder}, so this handle is read-only. ` +
        `Two engines over one store keep two ideas of where the stream has reached and share one cursor to record them.`,
    );
    this.name = "ReadOnlyStoreError";
  }
}

/**
 * A handle that reads and refuses to write.
 *
 * Guarded at the executor rather than on each layer, because every layer
 * runs its statements through this one object: a guard per layer would
 * have to be remembered by the next one added, and the one that forgot
 * would be the one that shared the cursor.
 */
function readOnly(db: LocalDb, holder: string): LocalDb {
  const refuse = (): never => {
    throw new ReadOnlyStoreError(holder);
  };
  return new Proxy(db, {
    get(target, property, receiver) {
      if (
        property === "insert" ||
        property === "update" ||
        property === "delete" ||
        property === "transaction"
      ) {
        return refuse;
      }
      return Reflect.get(target, property, receiver) as unknown;
    },
  });
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
  const lock = acquireStoreLock(options.path);

  let opened: Awaited<ReturnType<typeof inspectDatabase>>;
  try {
    opened = await inspectDatabase(options.path);

    // A store this build cannot open. Whichever way round it is, the queue
    // comes out first and the store is only moved once that has landed —
    // and if it cannot be moved, this refuses rather than rebuilding. The
    // engine never decides on its own that a person's unsent writes were
    // not worth keeping.
    const reason = opened.newerThanCode
      ? "store_is_newer"
      : opened.migrationError !== undefined
        ? "migration_failed"
        : null;
    if (reason !== null) {
      // A read-only handle cannot move anything aside, and rebuilding
      // under the engine that is writing would take the store out from
      // under it.
      if (!lock.writer) {
        opened.close();
        throw new StoreUnrecoverableError(
          reason,
          "another engine holds this store, so it cannot be rebuilt from here",
          opened.migrationError,
        );
      }
      const recovery = await setStoreAside({
        raw: opened.raw,
        path: options.path,
        reason,
        now,
        ...(opened.migrationError === undefined
          ? {}
          : { cause: opened.migrationError }),
      });
      // Fresh, and migrated by the ordinary path: there is nothing left
      // beside it for a migration to trip over.
      opened = { ...(await openDatabase(options.path)), newerThanCode: false };
      options.onRecovery?.(recovery);
    }
  } catch (error) {
    lock.release();
    throw error;
  }

  const { raw, close } = opened;
  const holder = lock.heldBy;
  const db = lock.writer
    ? opened.db
    : readOnly(
        opened.db,
        holder ? `pid ${String(holder.pid)}` : "another engine",
      );

  try {
    const scope = buildScope(db, now);

    // Whose store this is, before anything reads or writes it. A store
    // holds one corpus and one cursor; opened as somebody else it would
    // apply one account's events over another's rows and advance a cursor
    // that describes neither.
    const held = await scope.syncState.listIdentities();
    const matches = (candidate: StoreIdentity): boolean =>
      candidate.origin === options.identity.origin &&
      candidate.spaceId === options.identity.spaceId &&
      candidate.accountId === options.identity.accountId;
    if (held.length > 0 && !held.some(matches)) {
      throw new StoreIdentityMismatchError(options.identity, held);
    }
    // A reader takes the store as it finds it. Recording an identity is a
    // write, and one the holder has already made.
    if (lock.writer) await scope.syncState.ensure(options.identity);

    return {
      ...scope,
      identity: options.identity,
      writer: lock.writer,
      db,
      raw,
      transaction: <T>(
        fn: (scope: LocalStoreScope) => Promise<T>,
      ): Promise<T> =>
        db.transaction(async (tx: LocalTransaction) => fn(buildScope(tx, now))),
      close: () => {
        close();
        lock.release();
      },
    };
  } catch (error) {
    close();
    lock.release();
    throw error;
  }
}

export type { LocalDb } from "./open.js";
export type { Executor, LocalTransaction } from "./executor.js";
export type { CreateItemMutation, CreateEdgeMutation } from "./mutations.js";
export type { EnqueueInput, OutboxLayer } from "./outbox.js";
export type { DeadLetterLayer } from "./dead-letters.js";
export type { ServerStateLayer } from "./server-state.js";
export type { SyncStateLayer } from "./sync-state.js";
export type { VisibleLayer } from "./visible.js";
export { acquireStoreLock } from "./lock.js";
export type { StoreLock } from "./lock.js";
export { StoreUnrecoverableError } from "./version.js";
export type { StoreRecovery, RecoveryReason } from "./version.js";
export type { MutationLayer } from "./mutations.js";
