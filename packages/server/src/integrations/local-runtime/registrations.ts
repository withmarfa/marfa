/**
 * Loader for the integrations this deployment has installed.
 *
 * Each integration that opts into the local substrate ships a `local.ts`
 * entry. The shape is:
 *
 *   ```ts
 *   // <namespace>/<name>/src/local.ts
 *   import { MANIFEST } from "./manifest.js";
 *   import { registerHandlers } from "./handlers.js";
 *
 *   registerHandlers();                  // seeds the in-thread registry
 *   export const manifest = MANIFEST;
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
 * Resolve `<namespace>/<name>/dist/local.js` under the integrations root.
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
 * Load every installed integration's `local.ts` entry from
 * `<namespace>/<name>/dist/local.js` under the integrations root. An
 * integration that ships no local entry is skipped: it declares a surface
 * a connection can install against and nothing for this process to
 * dispatch into, so the catalog carries it and the runtime does not.
 *
 * The default list is whatever discovery finds; callers can override for
 * tests or alternate self-host bundles.
 */
export async function loadInTreeRegistrations(options: {
  /** Absolute path to the integrations root. */
  integrationsRoot: string;
  /** Per-integration directory names. Defaults to whatever is installed. */
  integrationDirs?: string[];
}): Promise<LocalIntegrationRegistration[]> {
  // A deployment that drops an integration keeps whatever cron row it
  // already registered for it, which is why the supervisor's `start()`
  // reconciles schedules against the registration set rather than only
  // seeding from it.
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
