import { MymeSyncClient } from "../../../src/client.js";
import type { SyncLogger } from "../../../src/config.js";

/**
 * Convenience constructor used by every integration test file. Picks
 * `storage: 'memory'` (each test starts from a clean slate), wires a
 * silent logger by default, and tags `source` so the server-side
 * audit log records integration writes distinctly from real users.
 */
export interface MakeIntegrationClientOptions {
  apiUrl: string;
  apiKey: string;
  source?: string;
  logger?: SyncLogger;
  /**
   * When `true` (default), `start()` is awaited inside this helper.
   * Pass `false` if the test wants to assert behaviour during start
   * itself (e.g., timing of the `sync.started` event).
   */
  autoStart?: boolean;
}

export async function makeIntegrationClient(
  options: MakeIntegrationClientOptions,
): Promise<MymeSyncClient> {
  const client = new MymeSyncClient({
    apiUrl: options.apiUrl,
    apiKey: options.apiKey,
    storage: "memory",
    source: options.source ?? "sync-client-integration",
    device: "ci",
    logger: options.logger,
  });
  if (options.autoStart !== false) {
    await client.start();
  }
  return client;
}

/**
 * Poll until `predicate` returns truthy. Used for assertions that
 * span the read-replication path (server change → Electric → PGlite →
 * merged read). Resolves with the truthy value, throws on timeout.
 */
export async function waitFor<T>(
  predicate: () => T | Promise<T>,
  options: { timeoutMs?: number; intervalMs?: number; description?: string } = {},
): Promise<NonNullable<T>> {
  const timeoutMs = options.timeoutMs ?? 5_000;
  const intervalMs = options.intervalMs ?? 100;
  const description = options.description ?? "predicate";
  const deadline = Date.now() + timeoutMs;
  let lastValue: T | undefined;
  while (Date.now() < deadline) {
    const value: T = await predicate();
    if (value) return value;
    lastValue = value;
    await new Promise<void>((r) => setTimeout(r, intervalMs));
  }
  throw new Error(
    `waitFor: ${description} did not become truthy within ${String(timeoutMs)}ms` +
      ` (last: ${JSON.stringify(lastValue)})`,
  );
}
