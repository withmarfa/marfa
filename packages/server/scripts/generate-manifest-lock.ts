/**
 * Regenerate `packages/server/manifest-lock.json` from the client manifests
 * this build ships.
 *
 * Run this deliberately, when a manifest change is intended:
 *   pnpm --filter @withmarfa/server run manifest-lock:generate
 *
 * The lock is checked by `manifest-lock.test.ts` in the ordinary suite, so
 * a manifest change that forgets to move a version fails a pull request
 * rather than a nightly job. That placement is the point: the generated-
 * artifact freshness workflows cannot gate a merge, which is how `main`
 * has gone red after a merge before.
 *
 * An installed integration's manifest is not locked here. It reaches a
 * deployment from withmarfa/integrations at whatever commit the image
 * pinned, so this build has nothing to compare against and an entry for
 * one would be a claim about a tree this repository cannot see.
 */
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { writeFileSync } from "node:fs";
import { CLIENT_MANIFESTS } from "../src/integrations/client-manifests.js";
import { buildManifestLock } from "../src/integrations/manifest-lock.js";

const serverRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const lockPath = resolve(serverRoot, "manifest-lock.json");
writeFileSync(
  lockPath,
  `${JSON.stringify(buildManifestLock(CLIENT_MANIFESTS), null, 2)}\n`,
);
console.log(
  `Wrote ${String(CLIENT_MANIFESTS.length)} manifests to ${lockPath}`,
);
