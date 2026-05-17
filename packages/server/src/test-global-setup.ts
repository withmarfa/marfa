/**
 * Vitest global setup for the server package.
 *
 * When STORAGE_DIALECT=pg, builds the template database once before any
 * test runs and drops it once after all tests finish. Per-file clones
 * are owned by `createPgTestStorage` in `test-utils.ts`.
 *
 * When STORAGE_DIALECT is anything else (the default sqlite path),
 * this is a no-op — sqlite tests already get per-file isolation via
 * `mkdtempSync` in `createTestContext`.
 *
 * Returned function is invoked by vitest at teardown.
 */

import { buildTemplate, dropTemplate } from "./storage/pg/test-template.js";

export default async function setup(): Promise<() => Promise<void>> {
  if (process.env.STORAGE_DIALECT !== "pg") {
    // sqlite path — nothing to do here.
    return async () => {
      /* no PG resources to release on the sqlite path */
    };
  }

  await buildTemplate();

  return async () => {
    await dropTemplate();
  };
}
