/**
 * Regenerate `packages/server/manifest-lock.json` from everything this
 * build ships: the manifests discovered under `integrations/`, plus the
 * client manifests the server carries as workspace dependencies.
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
import { CLIENT_MANIFESTS } from "../src/integrations/client-manifests.js";
import { buildManifestLock } from "../src/integrations/manifest-lock.js";

const serverRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const integrationsRoot = resolve(serverRoot, "../../integrations");

const { manifests, skipped } = await loadInTreeManifests({ integrationsRoot });
for (const s of skipped) {
  console.warn(`skip ${s.dirName}: ${s.reason}`);
}
// Gated on the discovered half alone. The client manifests ship with the
// build and are therefore always present, so counting them here would let an
// unbuilt tree write a lock naming one manifest and dropping fourteen.
if (manifests.length === 0) {
  console.error(
    "No built integration manifests found. Run `pnpm build` before regenerating the lock.",
  );
  process.exit(1);
}
const shipped = [...manifests, ...CLIENT_MANIFESTS];
const lockPath = resolve(serverRoot, "manifest-lock.json");
writeFileSync(
  lockPath,
  `${JSON.stringify(buildManifestLock(shipped), null, 2)}\n`,
);
console.log(`Wrote ${String(shipped.length)} manifests to ${lockPath}`);
