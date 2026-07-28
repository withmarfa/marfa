/**
 * Verify that no deployed per-Integration Worker serves a public
 * hostname.
 *
 * `workers_dev` and `preview_urls` are account-side settings that only
 * change when `wrangler deploy` pushes them. Setting them in a
 * `wrangler.toml` therefore does nothing until every affected Worker
 * has been redeployed, and a repository that looks correct can sit in
 * front of a fleet that is still fully exposed. This script reads the
 * live settings back so the closure can be verified rather than
 * assumed.
 *
 * Usage:
 *   pnpm --filter @withmarfa/infra-cloudflare run verify:worker-surface
 *   pnpm --filter @withmarfa/infra-cloudflare run verify:worker-surface staging
 *
 * With no argument it checks every named environment found in the
 * configs. Pass one or more environment names to narrow it.
 *
 * Required env:
 *   - CLOUDFLARE_API_TOKEN   (marfa-account token, Workers Scripts read)
 *   - CLOUDFLARE_ACCOUNT_ID  (account hosting the Workers)
 *
 * Read-only. It issues GETs and changes nothing.
 *
 * Exit codes:
 *   0  every target verified closed
 *   1  at least one target is exposed, missing, or could not be read
 */
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseToml } from "smol-toml";
import { CloudflareClient } from "../cloudflare-api.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "..", "..", "..");
const INTEGRATIONS_ROOT = resolve(REPO_ROOT, "integrations");

interface WranglerConfig {
  name?: string;
  env?: Record<string, { name?: string }>;
}

interface Target {
  scriptName: string;
  envName: string;
  configPath: string;
}

/**
 * Every `wrangler.toml` under `integrations/`, found rather than
 * listed, so a config added without a registry entry is still checked.
 * `packages/runtime-control/src/integration-wrangler-config.test.ts`
 * walks the same tree for the same reason; the walk is duplicated
 * because `@withmarfa/shared` carries no `node:fs` dependency and so
 * cannot host it for both.
 */
function discoverIntegrationConfigs(): string[] {
  const found: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        if (entry.name === "node_modules" || entry.name === "dist") continue;
        walk(join(dir, entry.name));
      } else if (entry.name === "wrangler.toml") {
        found.push(join(dir, entry.name));
      }
    }
  };
  walk(INTEGRATIONS_ROOT);
  return found.sort();
}

/**
 * Deployed Worker names, taken from each config's named environments.
 *
 * The top-level `name` is deliberately skipped: it is the local `dev`
 * identity and is never deployed, so probing it would report a missing
 * script on a fleet that is entirely correct.
 */
function resolveTargets(envFilter: string[]): Target[] {
  const targets: Target[] = [];
  for (const configPath of discoverIntegrationConfigs()) {
    const config = parseToml(
      readFileSync(configPath, "utf8"),
    ) as WranglerConfig;
    for (const [envName, env] of Object.entries(config.env ?? {})) {
      if (envFilter.length > 0 && !envFilter.includes(envName)) continue;
      if (!env.name) {
        throw new Error(
          `${relative(REPO_ROOT, configPath)}: [env.${envName}] declares no name`,
        );
      }
      targets.push({ scriptName: env.name, envName, configPath });
    }
  }
  return targets;
}

type Verdict = "closed" | "exposed" | "missing" | "error";

interface Result {
  target: Target;
  verdict: Verdict;
  detail: string;
}

async function main(): Promise<void> {
  const apiToken = process.env.CLOUDFLARE_API_TOKEN;
  const accountId = process.env.CLOUDFLARE_ACCOUNT_ID;
  const missing = [
    ...(apiToken ? [] : ["CLOUDFLARE_API_TOKEN"]),
    ...(accountId ? [] : ["CLOUDFLARE_ACCOUNT_ID"]),
  ];
  if (!apiToken || !accountId) {
    console.error(`error: required env vars not set: ${missing.join(", ")}`);
    console.error(
      "Export them (e.g. from your per-machine secrets file) and retry.",
    );
    process.exit(1);
  }

  const envFilter = process.argv.slice(2);
  const targets = resolveTargets(envFilter);
  if (targets.length === 0) {
    console.error(
      `error: no deployed Workers matched${envFilter.length > 0 ? ` environments: ${envFilter.join(", ")}` : ""}`,
    );
    process.exit(1);
  }

  const client = new CloudflareClient({ apiToken, accountId });
  const results: Result[] = [];

  for (const target of targets) {
    try {
      const subdomain = await client.getWorkerSubdomain(target.scriptName);
      if (!subdomain) {
        results.push({
          target,
          verdict: "missing",
          detail: "no such script in this account",
        });
        continue;
      }
      const exposed = subdomain.enabled || subdomain.previews_enabled;
      results.push({
        target,
        verdict: exposed ? "exposed" : "closed",
        detail: `workers_dev=${String(subdomain.enabled)} preview_urls=${String(subdomain.previews_enabled)}`,
      });
    } catch (err) {
      results.push({
        target,
        verdict: "error",
        detail: err instanceof Error ? err.message : String(err),
      });
    }
  }

  const width = Math.max(...results.map((r) => r.target.scriptName.length));
  const mark: Record<Verdict, string> = {
    closed: "ok  ",
    exposed: "OPEN",
    missing: "??  ",
    error: "ERR ",
  };
  for (const r of results) {
    console.log(
      `${mark[r.verdict]} ${r.target.scriptName.padEnd(width)}  ${r.detail}`,
    );
  }

  const byVerdict = (v: Verdict) => results.filter((r) => r.verdict === v);
  const closed = byVerdict("closed").length;
  console.log(`\n${String(closed)}/${String(results.length)} verified closed`);

  const exposed = byVerdict("exposed");
  if (exposed.length > 0) {
    console.error(
      `\n${String(exposed.length)} Worker(s) still serve a public hostname. Redeploy them:`,
    );
    for (const r of exposed) {
      console.error(
        `  ${r.target.scriptName}  (${relative(REPO_ROOT, r.target.configPath)}, --env ${r.target.envName})`,
      );
    }
  }
  const unread = [...byVerdict("missing"), ...byVerdict("error")];
  if (unread.length > 0) {
    console.error(
      `\n${String(unread.length)} Worker(s) could not be verified. A missing script mid-rollout is expected; anything else is not:`,
    );
    for (const r of unread) {
      console.error(`  ${r.target.scriptName}  ${r.detail}`);
    }
  }

  process.exit(closed === results.length ? 0 : 1);
}

await main();
