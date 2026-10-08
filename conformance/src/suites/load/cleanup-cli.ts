#!/usr/bin/env tsx
/**
 * Backstop cleanup for load test data. Run via `pnpm load:cleanup`.
 *
 * The load suites delete what they create through the tracked-resource path,
 * so this only exists for a run that was killed mid-flight. It trashes every
 * item tagged `env:test` that the credential can see — instance-wide, not
 * scoped to a run, and other suites use the same tag — so it deliberately
 * refuses to guess a target. Both variables must be set, because "no URL
 * configured" and "delete everything on the default server" must not be the
 * same command.
 *
 * This is the one filter-based delete in the repository, and it is a manual
 * command rather than anything a test run reaches. Nothing imports it.
 */

import "dotenv/config";
import { MarfaClient } from "../../client/api.js";
import { runConcurrent } from "../../utils/pool.js";
import { newRunId } from "../../utils/setup.js";

const apiUrl = process.env.MARFA_API_URL;
const apiKey = process.env.MARFA_API_KEY;

if (!apiUrl || !apiKey) {
  console.error(
    "MARFA_API_URL and MARFA_API_KEY must both be set. This deletes every\n" +
      "item tagged env:test on the target, so it will not fall back to a default.",
  );
  process.exit(1);
}

/**
 * Trash every item tagged `env:test` the credential can see.
 */
async function cleanupLoadData(
  client: MarfaClient,
): Promise<{ deleted: number; errors: number }> {
  let deleted = 0;
  let errorCount = 0;
  let hasMore = true;

  while (hasMore) {
    const response = await client.listItems({
      tags: ["env:test"],
      limit: 100,
    });

    if (!response.ok || response.data.data.length === 0) {
      hasMore = false;
      break;
    }

    const deleteTasks = response.data.data.map((item) => async () => {
      const resp = await client.deleteItem(item.id);
      return resp.ok;
    });

    const { results } = await runConcurrent(deleteTasks, 20);
    for (const ok of results) {
      if (ok) deleted++;
      else errorCount++;
    }

    hasMore = response.data.next_cursor !== null;

    if (deleted % 1000 === 0 && deleted > 0) {
      console.log(`  Deleted ${deleted.toLocaleString()} items...`);
    }
  }

  return { deleted, errors: errorCount };
}

console.log(`Trashing every item tagged env:test on ${apiUrl}...`);

// A short-lived descendant gives cleanup its own source while retaining
// the supplied credential's content reach and minting ceiling.
const provisioner = new MarfaClient({ baseUrl: apiUrl, apiKey });
const runId = newRunId();
const minted = await provisioner.createKey({
  label: `load-cleanup-${runId}`,
  source: `load-cleanup-${runId}`,
});
if (!minted.ok) {
  console.error(
    `Could not mint a key to sweep with: ${JSON.stringify(minted.error)}`,
  );
  process.exit(1);
}

const client = new MarfaClient({ baseUrl: apiUrl, apiKey: minted.data.key });
try {
  const { deleted, errors } = await cleanupLoadData(client);
  console.log(`Done. Deleted ${deleted} items, ${errors} errors.`);
} finally {
  await provisioner.revokeKey(minted.data.id);
}
