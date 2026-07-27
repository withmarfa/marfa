/**
 * Freshness test for the deployed surface of every per-Integration
 * Worker.
 *
 * The auth gate in `worker-entry.ts` and these config keys are two
 * halves of one invariant: nothing outside the account can reach an
 * integration's `fetch` handler. The gate is the part that holds even
 * if this config regresses, and this test is the part that stops the
 * config regressing in the first place — a new integration copies the
 * scaffold, and Wrangler's default (`workers_dev` on, absent `routes`)
 * would otherwise publish it at a public hostname with nobody noticing.
 *
 * Both keys are asserted because Wrangler derives them independently:
 * `preview_urls` defaults from the same "are there routes?" test rather
 * than from the resolved `workers_dev`, so setting only the first
 * leaves per-version `<version>-<name>.<subdomain>.workers.dev`
 * hostnames serving the Worker. Wrangler warns about the mismatch, but
 * suppresses the warning in CI and non-interactive shells, which is
 * exactly where these deploys run.
 *
 * Each config is checked at the top level and in both named
 * environments. Belt and braces: the keys are inheritable, so the
 * top-level value would carry, but an env block that later sets a
 * hostname is the likely regression and it reads as a local decision.
 *
 * Lives beside `wrangler-control-config.test.ts` so every check on
 * what the deployed Cloudflare topology looks like is in one place,
 * and because this package already carries the TOML parser and the
 * Node types the check needs — `@withmarfa/runtime-sdk`, where the
 * matching auth gate lives, deliberately compiles against Workers
 * types only.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseToml } from "smol-toml";
import { IN_TREE_INTEGRATIONS } from "@withmarfa/shared";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "..", "..", "..");

interface WranglerConfig {
  workers_dev?: boolean;
  preview_urls?: boolean;
  env?: Record<string, { workers_dev?: boolean; preview_urls?: boolean }>;
}

/**
 * Every Wrangler config that deploys a Worker built from this repo's
 * integration tree, plus the scaffold new integrations are copied from.
 * Derived from `IN_TREE_INTEGRATIONS` so adding a registry entry
 * extends the check automatically.
 */
const CONFIGS: { label: string; path: string }[] = [
  ...IN_TREE_INTEGRATIONS.filter((i) => i.hasWorker).map((i) => ({
    label: i.name,
    path: resolve(REPO_ROOT, "integrations", i.dirName, "wrangler.toml"),
  })),
  {
    // Sibling Cloudflare Email Worker for withmarfa.inbox. No `fetch`
    // handler at all, so a public hostname is pure attack surface.
    label: "withmarfa.inbox (email worker)",
    path: resolve(
      REPO_ROOT,
      "integrations",
      "withmarfa-inbox",
      "email-worker",
      "wrangler.toml",
    ),
  },
  {
    label: "integration scaffold",
    path: resolve(
      REPO_ROOT,
      "infra",
      "cloudflare",
      "wrangler.integration.template.toml",
    ),
  },
];

describe("per-Integration Worker configs publish no public hostname", () => {
  it("covers every in-tree integration that deploys a Worker", () => {
    // Guards against the registry and the check drifting apart — an
    // empty or truncated list would make every assertion below vacuous.
    expect(CONFIGS.length).toBe(
      IN_TREE_INTEGRATIONS.filter((i) => i.hasWorker).length + 2,
    );
  });

  it.each(CONFIGS)("$label", ({ path }) => {
    const config = parseToml(readFileSync(path, "utf8")) as WranglerConfig;

    expect(config.workers_dev).toBe(false);
    expect(config.preview_urls).toBe(false);

    for (const envName of ["staging", "prod"]) {
      const env = config.env?.[envName];
      expect(env, `missing [env.${envName}]`).toBeDefined();
      expect(env?.workers_dev, `[env.${envName}].workers_dev`).toBe(false);
      expect(env?.preview_urls, `[env.${envName}].preview_urls`).toBe(false);
    }
  });

  it.each(CONFIGS)("$label declares no routes", ({ path }) => {
    // A `routes` / `route` entry would bind the Worker to a hostname,
    // which is the other way this surface becomes reachable. No
    // integration needs one: inbound webhooks land on the control
    // plane, which fans out over Service Bindings.
    const raw = readFileSync(path, "utf8");
    const config = parseToml(raw) as Record<string, unknown> & {
      env?: Record<string, Record<string, unknown>>;
    };
    for (const key of ["route", "routes"]) {
      expect(config[key], `top-level ${key}`).toBeUndefined();
      for (const envName of ["staging", "prod"]) {
        expect(
          config.env?.[envName]?.[key],
          `[env.${envName}].${key}`,
        ).toBeUndefined();
      }
    }
  });
});
