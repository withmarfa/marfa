/**
 * The tests `pnpm test:changed` always runs, because Vitest cannot select
 * them from a change.
 *
 * `--changed` follows imports: it runs a test only when the test or something
 * it imports changed. A test that reads files by path instead (it walks a
 * directory, reads a source file, the committed `openapi.json`, a workflow or
 * a chapter of the specification) is selected by none of those edits, so a
 * change can pass the quick check and fail in CI.
 *
 * A test belongs here when its verdict depends on a file it does not import.
 * Add the test's file name, or a name that every such test shares.
 *
 * Each entry is a substring of a test file's path relative to its project
 * root, which is how Vitest reads a file filter. An entry that matches no
 * file would silently drop a test, so `ci/whole-tree-tests.test.ts` fails on
 * one.
 */

/** Matched from the repository root, across `packages/` and `ci/`. */
export const ROOT_FILTERS: readonly string[] = [
  // Every census reads the server's source to count something in it.
  "census.test.ts",
  // The committed `openapi.json` and the files beside the routes.
  "openapi-committed-spec.test.ts",
  "openapi-open-objects.test.ts",
  "openapi-operation-order.test.ts",
  "openapi-routes.test.ts",
  "openapi-style.test.ts",
  "openapi-version-integers.test.ts",
  "packages/client/src/client.test.ts",
  "webhooks/retry.test.ts",
  // Walks of the server's source for a pattern.
  "auth/stale-client-ceiling.test.ts",
  "routes/edge-events-every-door.test.ts",
  "routes/idempotent-write-doors.test.ts",
  "routes/oidc-labels.test.ts",
  "pages/assets.test.ts",
  "pages/color-literals.test.ts",
  "pages/jsx-pragma.test.ts",
  "routes/one-auth-layout.test.ts",
  "routes/rollback-event-doors.test.ts",
  "routes/ui-viewer-coverage.test.ts",
  "routes/wire-shape-declarations.test.ts",
  "storage/scanned-columns.test.ts",
  // Named source and config files read as text.
  "housekeeping/scheduler.test.ts",
  "storage/idempotency-store.test.ts",
  "test-utils-sse.test.ts",
  "shutdown-stream.test.ts",
  // The item names the core is held to, in `conformance/fixtures/`.
  "packages/shared/src/item-name.test.ts",
  // The filter expressions the core's model is held to, beside them.
  "storage/filter-fixtures.test.ts",
  // The schema and registry files under `packages/types/`, read from disk.
  "packages/types/src/",
  // Everything under `ci/` checks the workflows and manifests, not a package.
  "ci/",
];

/**
 * Matched from `conformance/`, within the `generators` project, the one that
 * needs no server and no binary. `src/generators/` is left out: it imports
 * what it tests and takes most of the time.
 */
export const CONFORMANCE_FILTERS: readonly string[] = [
  // Reads the specification, the fixtures and the repository by path.
  "src/utils/",
  // A verdict over the fixture corpus.
  ".decision.test.ts",
];
