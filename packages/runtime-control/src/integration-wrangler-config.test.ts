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
 * Both keys are asserted because `preview_urls` has no dependable
 * default. Wrangler's deploy path resolves none locally: an unset
 * value is dropped from the request body and the API decides. Its
 * config schema documents a default of `false`, and the helper it
 * mocks that API with computes a third answer. Left unset, per-version
 * `<version>-<name>.<subdomain>.workers.dev` hostnames can keep
 * serving the Worker.
 *
 * Two things are deliberately derived rather than listed. The configs
 * come from walking `integrations/`, so a config that ships without a
 * registry entry is still checked — a list taken from the registry
 * would have skipped it entirely. The environments come from each
 * config's own `env` table, so an `[env.dev]` added later is covered
 * the moment it exists rather than the moment someone remembers to
 * extend a hardcoded pair. `staging` and `prod` are then asserted
 * present separately, because iterating what is there alone passes an
 * empty table.
 *
 * The keys are inheritable, so a top-level value would carry into an
 * env that omits them. They are asserted per-env anyway: an env block
 * that later sets a hostname is the likely regression, and it reads as
 * a local decision at the point it is made.
 *
 * Lives beside `wrangler-control-config.test.ts` so every check on
 * what the deployed Cloudflare topology looks like is in one place,
 * and because this package already carries the TOML parser and the
 * Node types the check needs — `@withmarfa/runtime-sdk`, where the
 * matching auth gate lives, deliberately compiles against Workers
 * types only.
 */
import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseToml } from "smol-toml";
import { IN_TREE_INTEGRATIONS, findIntegrationByDir } from "@withmarfa/shared";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "..", "..", "..");
const INTEGRATIONS_ROOT = resolve(REPO_ROOT, "integrations");

/**
 * Environments every deployed Worker has. Not the list iterated over —
 * that comes from each config — just the floor below which coverage
 * must not drop.
 */
const REQUIRED_ENVS = ["staging", "prod"];

/**
 * Directories under `integrations/` that may hold a Wrangler config
 * without a registry entry. `_template` is the scaffold contributors
 * copy. It is never deployed, but everything in it is inherited by
 * every integration started from it, so its keys are checked too.
 */
const UNREGISTERED_DIRS = ["_template"];

interface SubdomainKeys {
  workers_dev?: boolean;
  preview_urls?: boolean;
}

interface WranglerConfig extends SubdomainKeys {
  env?: Record<string, SubdomainKeys>;
}

/** Every `wrangler.toml` under `integrations/`, found rather than listed. */
function discoverIntegrationConfigs(): string[] {
  const found: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        // Build output and installed packages carry Wrangler configs
        // belonging to other projects.
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

const DISCOVERED = discoverIntegrationConfigs();

/** First path segment under `integrations/` — the owning integration. */
function owningDir(configPath: string): string {
  return relative(INTEGRATIONS_ROOT, configPath).split(sep)[0] ?? "";
}

const CONFIGS: { label: string; path: string }[] = [
  ...DISCOVERED.map((path) => ({ label: relative(REPO_ROOT, path), path })),
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

describe("integration Wrangler configs match the registry", () => {
  it.each(IN_TREE_INTEGRATIONS.filter((i) => i.hasWorker))(
    "$name ships a config",
    ({ dirName }) => {
      expect(DISCOVERED).toContain(
        join(INTEGRATIONS_ROOT, dirName, "wrangler.toml"),
      );
    },
  );

  it.each(IN_TREE_INTEGRATIONS.filter((i) => !i.hasWorker))(
    "$name ships no config",
    ({ dirName }) => {
      // The inverse gap: an integration that deploys a Worker while the
      // registry says it has none is invisible to every dispatch site
      // that reads the registry, and a check driven off the registry
      // would never look at its surface.
      expect(DISCOVERED).not.toContain(
        join(INTEGRATIONS_ROOT, dirName, "wrangler.toml"),
      );
    },
  );

  it.each(DISCOVERED)("%s belongs to a known integration", (configPath) => {
    const dir = owningDir(configPath);
    const known =
      findIntegrationByDir(dir) !== undefined ||
      UNREGISTERED_DIRS.includes(dir);
    expect(known, `no registry entry for integrations/${dir}`).toBe(true);
  });
});

describe("per-Integration Worker configs publish no public hostname", () => {
  it("has configs to check", () => {
    // Vacuity guard. A walk that finds nothing would leave every
    // assertion below passing against no deployed surface at all.
    expect(DISCOVERED.length).toBeGreaterThan(0);
  });

  it.each(CONFIGS)("$label", ({ path }) => {
    const config = parseToml(readFileSync(path, "utf8")) as WranglerConfig;

    expect(config.workers_dev).toBe(false);
    expect(config.preview_urls).toBe(false);

    const envNames = Object.keys(config.env ?? {});
    for (const required of REQUIRED_ENVS) {
      expect(envNames, `missing [env.${required}]`).toContain(required);
    }

    for (const envName of envNames) {
      const env = config.env?.[envName];
      expect(env?.workers_dev, `[env.${envName}].workers_dev`).toBe(false);
      expect(env?.preview_urls, `[env.${envName}].preview_urls`).toBe(false);
    }
  });

  it.each(CONFIGS)("$label declares no routes", ({ path }) => {
    // A `routes` / `route` entry would bind the Worker to a hostname,
    // which is the other way this surface becomes reachable. No
    // integration needs one: inbound webhooks land on the control
    // plane, which fans out over Service Bindings.
    const config = parseToml(readFileSync(path, "utf8")) as Record<
      string,
      unknown
    > & {
      env?: Record<string, Record<string, unknown>>;
    };
    for (const key of ["route", "routes"]) {
      expect(config[key], `top-level ${key}`).toBeUndefined();
      for (const envName of Object.keys(config.env ?? {})) {
        expect(
          config.env?.[envName]?.[key],
          `[env.${envName}].${key}`,
        ).toBeUndefined();
      }
    }
  });
});
