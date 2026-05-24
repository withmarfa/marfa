/**
 * In-tree integration loader for the local runtime (T-173).
 *
 * Each integration that opts into the local substrate ships a
 * `local.ts` entry alongside the existing `worker.ts`. The shape is:
 *
 *   ```ts
 *   // integrations/<name>/src/local.ts
 *   import { TEMPLATE_MANIFEST } from "./manifest.js";
 *   import { registerHandlers } from "./handlers.js";
 *
 *   registerHandlers();                  // seeds the in-thread registry
 *   export const manifest = TEMPLATE_MANIFEST;
 *   ```
 *
 * The loader takes a list of integration package directories, resolves
 * each to its built `dist/local.js`, imports it dynamically (to read
 * the manifest), and synthesises a `LocalIntegrationRegistration`. The
 * worker thread then `await import()`s the same `dist/local.js` on
 * startup so handlers register inside the thread too.
 *
 * T-173 ships the loader machinery without any in-tree opt-ins — the
 * per-integration `local.ts` entries land in T-174. The server boots
 * the substrate with an empty registration list when no integrations
 * have opted in, which is a no-op until T-174 adds entries. This keeps
 * the substrate flippable independently of the integration-side work.
 */
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { validateManifest } from "../validate-manifest.js";
import type { LocalIntegrationRegistration } from "./types.js";

interface LocalEntryModule {
  manifest?: unknown;
  default?: { manifest?: unknown };
}

/**
 * Resolve `integrations/<name>/dist/local.js` from a base directory.
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
 * `integrations/<name>/dist/local.js`. Skips integrations that haven't
 * landed a local entry yet — they continue running on Cloudflare under
 * `runtime_compatibility: ["hosted"]`.
 *
 * The default integration list mirrors the in-tree set; callers can
 * override for tests or alternate self-host bundles.
 */
export async function loadInTreeRegistrations(options: {
  /** Absolute path to the `integrations/` directory. */
  integrationsRoot: string;
  /** Per-integration directory names. Defaults to the in-tree set. */
  integrationDirs?: string[];
}): Promise<LocalIntegrationRegistration[]> {
  const dirs = options.integrationDirs ?? [
    "_template",
    "rss-watcher",
    "github-webhooks",
    "google-calendar",
    "google-tasks",
    "google-contacts",
    "google-drive",
    "google-youtube",
    "task-auto-archive",
    "sync",
    "todoist",
    "readwise",
    "raindrop",
    "mymehq-inbox",
  ];
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
    if (!validated.manifest.runtime_compatibility.includes("local")) {
      // Hosted-only integration that happens to have a local.ts —
      // refuse to register it on the local substrate so the manifest's
      // declared compatibility is honoured.
      console.warn(
        `[local-runtime] ${dir} declares runtime_compatibility=${JSON.stringify(
          validated.manifest.runtime_compatibility,
        )}; skipping local registration.`,
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
