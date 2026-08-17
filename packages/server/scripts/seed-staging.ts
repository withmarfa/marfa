/**
 * Register every in-tree integration manifest against a Marfa server.
 *
 * The integration catalog (`GET /integrations`) is empty on a freshly
 * bootstrapped instance — manifests are registered at runtime via
 * `POST /integrations` (platform-credential gated). This script imports
 * each in-tree manifest from `integrations/<dir>/src/manifest.ts` and
 * registers it, so a self-hoster (or staging) gets a populated catalog
 * without hand-writing manifest bodies.
 *
 * Usage (from the monorepo root):
 *   MARFA_API_URL=https://your-instance \
 *   MARFA_API_KEY=<platform-admin key> \
 *     pnpm --filter @withmarfa/server exec tsx scripts/seed-staging.ts
 *
 * The key MUST be a platform credential (is_platform: true). Re-running is
 * safe: a manifest already registered at the same (name, version) returns
 * 409 and is reported as "exists", not an error.
 */
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

// In-tree integration directories under `integrations/`. `_template` carries
// no real manifest and is skipped; any dir without a manifest export is
// skipped with a warning rather than failing the run.
const DIRS = [
  "rss-watcher",
  "readwise",
  "readwise-reader",
  "todoist",
  "raindrop",
  "github-webhooks",
  "google-calendar",
  "google-contacts",
  "google-drive",
  "google-tasks",
  "google-youtube",
  "task-auto-archive",
  "withmarfa-inbox",
  "sync",
];

interface Manifest {
  name: string;
  version: string;
}

function isManifest(v: unknown): v is Manifest {
  return (
    typeof v === "object" &&
    v !== null &&
    "manifest_schema_version" in v &&
    "name" in v &&
    "version" in v
  );
}

async function main(): Promise<void> {
  const apiUrl = (process.env.MARFA_API_URL ?? "http://localhost:9001").replace(
    /\/+$/,
    "",
  );
  const apiKey = process.env.MARFA_API_KEY;
  if (!apiKey) {
    console.error("MARFA_API_KEY is required (platform-admin key).");
    process.exit(1);
  }

  const integrationsRoot = resolve(
    dirname(fileURLToPath(import.meta.url)),
    "../../../integrations",
  );

  let registered = 0;
  let existed = 0;
  let failed = 0;

  for (const dir of DIRS) {
    const manifestPath = resolve(integrationsRoot, dir, "src/manifest.ts");
    let manifest: Manifest | undefined;
    try {
      const mod = (await import(pathToFileURL(manifestPath).href)) as Record<
        string,
        unknown
      >;
      manifest = Object.values(mod).find(isManifest);
    } catch (err) {
      console.warn(`skip ${dir}: cannot import manifest (${String(err)})`);
      continue;
    }
    if (!manifest) {
      console.warn(`skip ${dir}: no manifest export found`);
      continue;
    }

    const res = await fetch(`${apiUrl}/integrations`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({ manifest }),
    });

    const tag = `${manifest.name}@${manifest.version}`;
    if (res.status === 201) {
      registered += 1;
      console.log(`registered ${tag}`);
    } else if (res.status === 409) {
      existed += 1;
      console.log(`exists     ${tag}`);
    } else {
      failed += 1;
      const body = await res.text();
      console.error(
        `FAILED     ${tag} -> ${String(res.status)} ${body.slice(0, 200)}`,
      );
    }
  }

  console.log(
    `\nDone: ${String(registered)} registered, ${String(existed)} already present, ${String(failed)} failed.`,
  );
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
