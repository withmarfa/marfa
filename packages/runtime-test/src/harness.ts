/**
 * Test harness: builds a full `ConsumerEnvironment` from in-memory
 * mocks. Per-Integration tests use this to drive their handlers in
 * isolation; per-Integration test suites hang off it.
 *
 * Usage:
 *
 *   const harness = createTestHarness({ integrationName: "acme/template" });
 *   harness.connection("conn_1").send({ kind: "schedule", ... });
 *   const outcome = await harness.consume();
 *   const cursor = await harness.connection("conn_1").storage.get("cursor:main");
 *
 * The harness does NOT mock the Marfa HTTP API — that's intentional.
 * Integration tests that exercise the round-trip against Marfa should
 * point a real Marfa server at the harness via the `apiUrl` parameter
 * (typically a fresh-sqlite test instance from `@withmarfa/server`).
 * Pure-handler tests can pass a stub `mintCredential` callback that
 * returns a static credential and a fetch shim.
 */
import {
  consumeBatch,
  type ConsumerEnvironment,
  type CursorStorageAdapter,
  type QueueMessage,
  type RuntimeCredential,
} from "@withmarfa/runtime-sdk";
import {
  createInMemoryStorage,
  type InMemoryStorage,
} from "./in-memory-storage.js";
import { createInMemoryQueue, type InMemoryQueue } from "./in-memory-queue.js";

export interface TestHarnessOptions {
  integrationName: string;
  /** Defaults to `http://localhost:0` — handlers should not hit real
   *  HTTP unless the test wires a custom mintCredential / fetch. */
  apiUrl?: string;
  /** Manifest-derived; defaults to 60s. */
  echoTtlSeconds?: number;
  /** Override the default mintCredential — useful when the test wants
   *  to assert minting was attempted, or to return a fixed credential
   *  for deterministic comparisons. */
  mintCredential?: (connectionId: string) => Promise<RuntimeCredential>;
  /**
   * The soft budget a handler sees as `ctx.budget`, in milliseconds.
   * Defaults to an hour, so an ordinary handler test never yields by
   * accident.
   *
   * Set it to `0` to test the yield branch: the budget is then already
   * past its deadline when the handler starts, so `shouldYield` is true
   * on the first poll. That is a real state in production — a backed-up
   * queue delivers work whose allowance is already spent — rather than a
   * condition invented for the test.
   */
  softLimitMs?: number;
}

/** One continuation the harness was asked to enqueue. */
export interface RecordedContinuation {
  message: QueueMessage;
  /** Epoch ms the handler asked not to be resumed before, if it asked. */
  notBefore?: number;
}

export interface TestHarness {
  /** The ConsumerEnvironment to feed into the SDK's consumeBatch. */
  env: ConsumerEnvironment;
  /** The webhook-receipt + scheduled-poll + reactive-run queues all
   *  share this in-memory buffer for the harness — tests don't care
   *  which "queue" a message is on, only which handler should fire.
   *  Send messages via `send()`. */
  queue: InMemoryQueue<QueueMessage>;
  /** Per-Connection storage handles. */
  connection(id: string): {
    storage: InMemoryStorage;
    /** Convenience — append a queue message with this connection_id
     *  and the harness's integration_name pre-filled. Cycle metadata
     *  is required for item-event messages; you supply the rest. */
    send(message: QueueMessage): Promise<void>;
  };
  /** Drain the queue and feed every message through consumeBatch.
   *  One pass: a continuation enqueued by this pass is picked up by the
   *  next one, so slice boundaries stay visible to the test. */
  consume(): Promise<{ acked: number; retried: number; failed: number }>;
  /**
   * Drive slices until the queue drains, and return one outcome per pass.
   *
   * The ceiling is not optional decoration. A handler that parks without
   * advancing loops forever, and the failure this harness exists to make
   * visible looks exactly like a slow test until the suite times out with
   * nothing to read. Hitting the ceiling throws and names the connection.
   */
  consumeUntilDone(options?: {
    maxSlices?: number;
  }): Promise<{ acked: number; retried: number; failed: number }[]>;
  /**
   * Every continuation the harness has been handed, oldest first.
   *
   * Exposed because an ack count cannot distinguish a sweep that finished
   * from one that parked and had its chain dropped — both read as one
   * acked message. This is the surface that tells them apart.
   */
  continuations: RecordedContinuation[];
}

const DEFAULT_CREDENTIAL: RuntimeCredential = {
  api_key: "marfa_k1_runtime_test",
  expires_at: new Date(Date.now() + 60 * 60_000).toISOString(),
  connection_id: "_unset_",
};

export function createTestHarness(options: TestHarnessOptions): TestHarness {
  const stores = new Map<string, InMemoryStorage>();
  const queue = createInMemoryQueue<QueueMessage>();

  const storageFor = (connectionId: string): CursorStorageAdapter => {
    let s = stores.get(connectionId);
    if (!s) {
      s = createInMemoryStorage();
      stores.set(connectionId, s);
    }
    return s;
  };

  const mintCredential =
    options.mintCredential ??
    ((connectionId: string) =>
      Promise.resolve({ ...DEFAULT_CREDENTIAL, connection_id: connectionId }));

  const continuations: RecordedContinuation[] = [];

  const env: ConsumerEnvironment = {
    apiUrl: options.apiUrl ?? "http://localhost:0",
    integrationName: options.integrationName,
    storageFor,
    mintCredential,
    echo: { echo_ttl_seconds: options.echoTtlSeconds ?? 60 },
    softLimitMs: options.softLimitMs ?? 60 * 60_000,
    enqueueContinuation: (message, enqueueOptions) => {
      continuations.push({
        message,
        ...(enqueueOptions?.notBefore !== undefined && {
          notBefore: enqueueOptions.notBefore,
        }),
      });
      // Straight back onto the same buffer the harness drains. `notBefore`
      // is recorded rather than honoured: a test that slept through a
      // handler's requested delay would be a test that takes as long as
      // the delay, and the assertion worth making is that the delay was
      // asked for, not that this process waited it out.
      return queue.send(message);
    },
  };

  return {
    env,
    queue,
    connection(id: string) {
      // Materialize the storage (so callers can inspect even before
      // any message lands).
      let s = stores.get(id);
      if (!s) {
        s = createInMemoryStorage();
        stores.set(id, s);
      }
      const storage = s;
      return {
        storage,
        send(message: QueueMessage): Promise<void> {
          return queue.send(message);
        },
      };
    },
    async consume() {
      // Drain via `drainMessages()` so each payload arrives wrapped in
      // a `Message<T>` envelope with `ack()` / `retry()` / `attempts`.
      // The consumer dispatches per-message; outcome counters are still
      // populated for telemetry compatibility.
      const messages = queue.drainMessages();
      return consumeBatch(env, messages);
    },
    async consumeUntilDone(options?: { maxSlices?: number }) {
      const maxSlices = options?.maxSlices ?? 20;
      const outcomes: { acked: number; retried: number; failed: number }[] = [];
      for (let pass = 0; pass < maxSlices; pass++) {
        const messages = queue.drainMessages();
        if (messages.length === 0) return outcomes;
        outcomes.push(await consumeBatch(env, messages));
      }
      // Only reachable when the queue still had work on the last pass.
      throw new Error(
        `consumeUntilDone hit its ${String(maxSlices)}-slice ceiling with work still queued; ` +
          `a handler is parking without advancing (${String(continuations.length)} continuations so far)`,
      );
    },
    continuations,
  };
}
