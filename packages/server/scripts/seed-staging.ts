/**
 * Register every in-tree integration manifest against a Marfa server.
 *
 * Mostly historical now: the server reconciles its own catalog at boot
 * (`integrations/catalog-reconcile.ts`), so a deployed instance registers
 * every shipped manifest version without anyone running anything. This
 * script remains useful against an instance you are not deploying to, and
 * for registering a manifest from source rather than from built output.
 *
 * It imports each in-tree manifest from `integrations/<dir>/src/manifest.ts`
 * and registers it via `POST /integrations` (platform-credential gated).
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
import { discoverIntegrationDirs } from "../src/integrations/discover.js";

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

  // Read from the directory, like the server's own two loaders. This was a
  // hand-written list, then a read of a hand-written table, and both were
  // the same enumeration a new integration gets added to in one place and
  // not the other. `_template` and anything else without a manifest export
  // is skipped with a warning rather than failing the run, which is what
  // makes reading the directory safe here.
  const dirs = discoverIntegrationDirs(integrationsRoot);

  let registered = 0;
  let existed = 0;
  let failed = 0;

  for (const dir of dirs) {
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
