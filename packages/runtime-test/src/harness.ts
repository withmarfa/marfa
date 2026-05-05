/**
 * Test harness: builds a full `ConsumerEnvironment` from in-memory
 * mocks. Per-Integration tests use this to drive their handlers in
 * isolation; Layer 3's integration test suites all hang off it.
 *
 * Usage:
 *
 *   const harness = createTestHarness({ integrationName: "myme.template" });
 *   harness.connection("conn_1").send({ kind: "schedule", ... });
 *   const outcome = await harness.consume();
 *   const cursor = await harness.connection("conn_1").storage.get("cursor:main");
 *
 * The harness does NOT mock the Myme HTTP API — that's intentional.
 * Integration tests that exercise the round-trip against Myme should
 * point a real Myme server at the harness via the `apiUrl` parameter
 * (typically a fresh-sqlite test instance from `@mymehq/server`).
 * Pure-handler tests can pass a stub `mintCredential` callback that
 * returns a static credential and a fetch shim.
 */
import {
  consumeBatch,
  type ConsumerEnvironment,
  type CursorStorageAdapter,
  type QueueMessage,
  type RuntimeCredential,
} from "@mymehq/runtime-sdk";
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
  /** Drain the queue and feed every message through consumeBatch. */
  consume(): Promise<{ acked: number; retried: number; failed: number }>;
}

const DEFAULT_CREDENTIAL: RuntimeCredential = {
  api_key: "myme_k1_runtime_test",
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

  const env: ConsumerEnvironment = {
    apiUrl: options.apiUrl ?? "http://localhost:0",
    integrationName: options.integrationName,
    storageFor,
    mintCredential,
    echo: { echo_ttl_seconds: options.echoTtlSeconds ?? 60 },
  };

  return {
    env,
    queue,
    connection(id: string) {
      // Materialise the storage (so callers can inspect even before
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
      // T-043 D2: drain via `drainMessages()` so each payload arrives
      // wrapped in a `Message<T>` envelope with `ack()` / `retry()` /
      // `attempts`. The consumer dispatches per-message; outcome
      // counters are still populated for telemetry compatibility.
      const messages = queue.drainMessages();
      return consumeBatch(env, messages);
    },
  };
}
