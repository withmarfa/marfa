/**
 * Regenerate `integrations/manifest-lock.json` from built manifests.
 *
 * Run this deliberately, when a manifest change is intended:
 *   pnpm --filter @withmarfa/server run manifest-lock:generate
 *
 * The lock is checked by `manifest-lock.test.ts` in the ordinary suite, so
 * a manifest change that forgets to move a version fails a pull request
 * rather than a nightly job. That placement is the point: the generated-
 * artifact freshness workflows cannot gate a merge, which is how `main`
 * has gone red after a merge before.
 */
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { writeFileSync } from "node:fs";
import { loadInTreeManifests } from "../src/integrations/load-manifests.js";
import { buildManifestLock } from "../src/integrations/manifest-lock.js";

const integrationsRoot = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../../integrations",
);

const { manifests, skipped } = await loadInTreeManifests({ integrationsRoot });
for (const s of skipped) {
  console.warn(`skip ${s.dirName}: ${s.reason}`);
}
if (manifests.length === 0) {
  console.error(
    "No built manifests found. Run `pnpm build` before regenerating the lock.",
  );
  process.exit(1);
}
const lockPath = resolve(integrationsRoot, "manifest-lock.json");
writeFileSync(
  lockPath,
  `${JSON.stringify(buildManifestLock(manifests), null, 2)}\n`,
);
console.log(`Wrote ${String(manifests.length)} manifests to ${lockPath}`);
