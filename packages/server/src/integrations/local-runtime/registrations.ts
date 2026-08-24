/**
 * In-tree integration loader for the local runtime.
 *
 * Each integration that opts into the local substrate ships a
 * `local.ts` entry alongside the existing `worker.ts`. The shape is:
 *
 *   ```ts
 *   // integrations/<handle>/<name>/src/local.ts
 *   import { TEMPLATE_MANIFEST } from "./manifest.js";
 *   import { registerHandlers } from "./handlers.js";
 *
 *   registerHandlers();                  // seeds the in-thread registry
 *   export const manifest = TEMPLATE_MANIFEST;
 *   ```
 *
 * The loader takes a list of integration package directories, resolves
 * each to its built `dist/local.js`, imports it dynamically (to read
 * the manifest), and synthesizes a `LocalIntegrationRegistration`. The
 * worker thread then `await import()`s the same `dist/local.js` on
 * startup so handlers register inside the thread too.
 *
 * The server boots the substrate with an empty registration list when
 * no integrations have opted in, which is a no-op. The substrate is
 * flippable independently of whether any integrations have a local entry.
 */
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { validateManifest } from "../validate-manifest.js";
import { discoverIntegrationDirs } from "../discover.js";
import type { LocalIntegrationRegistration } from "./types.js";

interface LocalEntryModule {
  manifest?: unknown;
  default?: { manifest?: unknown };
}

/**
 * Resolve `integrations/<handle>/<name>/dist/local.js` from a base directory.
 * Returns the absolute path when the file exists, or `null` when the
 * integration hasn't shipped a local.ts yet.
 */
export function resolveLocalEntry(
  integrationsRoot: string,
  integrationDir: string,
): string | null {
  const candidate = resolve(
    integrationsRoot,
    integrationDir,
    "dist",
    "local.js",
  );
  return existsSync(candidate) ? candidate : null;
}

/**
 * Load every in-tree integration's `local.ts` entry from
 * `integrations/<handle>/<name>/dist/local.js`. An integration that ships no local
 * entry is skipped: it declares a surface a connection can install
 * against and nothing for this process to dispatch into, so the catalog
 * carries it and the runtime does not.
 *
 * The default integration list mirrors the in-tree set; callers can
 * override for tests or alternate self-host bundles.
 */
export async function loadInTreeRegistrations(options: {
  /** Absolute path to the `integrations/` directory. */
  integrationsRoot: string;
  /** Per-integration directory names. Defaults to whatever is installed. */
  integrationDirs?: string[];
}): Promise<LocalIntegrationRegistration[]> {
  // `_template` leaves the default set, and that is the one behaviour
  // change here rather than a tidy-up. It used to be prepended by hand
  // because it is not a real integration and so was not in the table, yet
  // the local runtime wanted a smoke shape to boot against. Discovery skips
  // it: a leading underscore means scaffolding.
  //
  // Nothing that genuinely wants it loses it — the boot smoke test, the
  // worker-entry smoke script and the image verification all name it
  // explicitly. What it does mean is that a deployment which already
  // registered `acme/template` carries a cron row for it, which is why the
  // supervisor's `start()` reconciles schedules against the registration
  // set rather than only seeding from it.
  const dirs =
    options.integrationDirs ??
    discoverIntegrationDirs(options.integrationsRoot);
  const registrations: LocalIntegrationRegistration[] = [];
  for (const dir of dirs) {
    const entryPath = resolveLocalEntry(options.integrationsRoot, dir);
    if (!entryPath) continue;
    let mod: LocalEntryModule;
    try {
      mod = (await import(pathToFileURL(entryPath).href)) as LocalEntryModule;
    } catch (err) {
      console.error(
        `[local-runtime] failed to import ${dir}/dist/local.js:`,
        err instanceof Error ? err.message : String(err),
      );
      continue;
    }
    const rawManifest = mod.manifest ?? mod.default?.manifest;
    const validated = validateManifest(rawManifest);
    if (!validated.ok) {
      console.error(
        `[local-runtime] ${dir} local.js manifest is invalid; skipping.`,
        validated.errors,
      );
      continue;
    }
    const cronTrigger = validated.manifest.triggers.find(
      (t) => t.type === "schedule",
    );
    const triggerKinds = new Set<
      "schedule" | "webhook" | "item-event" | "manual"
    >(validated.manifest.triggers.map((t) => t.type));
    registrations.push({
      name: validated.manifest.name,
      handlerModulePath: entryPath,
      ...(cronTrigger?.type === "schedule"
        ? { scheduleCron: cronTrigger.config.cron }
        : {}),
      echo: {
        echo_ttl_seconds:
          validated.manifest.bidirectional_handling.echo_ttl_seconds,
        lag_window_seconds:
          validated.manifest.bidirectional_handling.lag_window_seconds,
      },
      triggerKinds,
    });
  }
  return registrations;
}
