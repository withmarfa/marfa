/**
 * Register the client manifests this build ships against a Marfa server.
 *
 * A deployed instance needs none of this: the server reconciles its own
 * catalog at boot (`integrations/catalog-reconcile.ts`). The script is for
 * an instance you are not deploying to.
 *
 * It registers via `POST /integrations` (platform-credential gated), from
 * `src/integrations/client-manifests.ts`. An installed integration is not
 * here: its manifest lives in withmarfa/integrations, and an instance gets
 * it from the image it runs.
 *
 * A client manifest resolves through its package's `exports` to built
 * output, so a stale or missing `dist` seeds a stale manifest and the
 * instance then carries a catalog row nobody can correct without a version
 * bump. Run `pnpm build` first.
 *
 * Usage (from the monorepo root):
 *   MARFA_API_URL=https://your-instance \
 *   MARFA_API_KEY=<platform-admin key> \
 *     pnpm --filter @withmarfa/server exec tsx scripts/seed-staging.ts
 *
 * The key MUST be a platform credential (is_operator: true). Re-running is
 * safe: a manifest already registered at the same (name, version) returns
 * 409 and is reported as "exists", not an error.
 */
import { CLIENT_MANIFESTS } from "../src/integrations/client-manifests.js";

interface Manifest {
  name: string;
  version: string;
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

  let registered = 0;
  let existed = 0;
  let failed = 0;

  const candidates: Manifest[] = CLIENT_MANIFESTS.map((c) => c.manifest);

  for (const manifest of candidates) {
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
