import { MymeClient } from "@mymehq/sdk";

/**
 * `TestContext` for integration tests. Mirrors the pattern in
 * `mock-myme`: every id created during a test is registered here; the
 * test's `afterEach` calls `cleanup()` and the context purges them via
 * the SDK using a long-lived admin key.
 *
 * The integration suite mints rows in Atlas Postgres (`myme_mock`),
 * which is shared infra. Failing to clean up would leak rows that the
 * next test run would have to step around. Cleanup is best-effort —
 * already-deleted rows are fine, server errors are logged but don't
 * fail the cleanup pass.
 */
export interface TestContext {
  trackItem(id: string): void;
  trackEdge(id: string): void;
  cleanup(): Promise<void>;
}

export interface CreateTestContextOptions {
  apiUrl: string;
  apiKey: string;
}

export function createTestContext(
  options: CreateTestContextOptions,
): TestContext {
  const items = new Set<string>();
  const edges = new Set<string>();
  const sdk = new MymeClient({ url: options.apiUrl, apiKey: options.apiKey });

  return {
    trackItem(id) {
      items.add(id);
    },
    trackEdge(id) {
      edges.add(id);
    },
    async cleanup() {
      // Edges first — deleting an item with a `block` cascade rule on
      // its edges would otherwise fail.
      for (const id of edges) {
        try {
          await sdk.edges.delete(id);
        } catch {
          // best-effort
        }
      }
      // Items must be trashed before they can be purged. Issue a
      // delete first; ignore errors (already-trashed is fine), then
      // purge. This leaves no rows in `myme_mock` between runs.
      for (const id of items) {
        try {
          await sdk.items.delete(id);
        } catch {
          // already-deleted is fine
        }
        try {
          await sdk.items.purge(id);
        } catch {
          // Fall through; the trash-purge job will eventually reclaim
          // anything left soft-deleted.
        }
      }
      items.clear();
      edges.clear();
    },
  };
}
