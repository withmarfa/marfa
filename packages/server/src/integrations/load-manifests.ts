/**
 * Reading every in-tree integration's manifest from built output.
 *
 * Distinct from `local-runtime/registrations.ts`, and the distinction is
 * the point. That loader answers "what can this process dispatch", so it
 * requires a `dist/local.js` handler entry and refuses anything not
 * declaring local compatibility. This one answers "what does this build
 * ship a manifest for", which is a larger set: the catalog describes what
 * is installable, and an integration whose code runs elsewhere is still
 * installable.
 *
 * So an integration declaring itself `manifest-only` is found here and
 * skipped by the runtime, on purpose: a connection can hold its
 * credentials, configuration and observability without anything ever
 * dispatching into it.
 *
 * This reads the installed directory and nothing else. A manifest the
 * build ships rather than a deployment installs is not an integration and
 * belongs to no directory: `client-manifests.ts` carries those, and the
 * catalog reconcile takes the union.
 *
 * Manifests are read from built output rather than from `src/manifest.ts`
 * because this runs inside the server, which is compiled JavaScript with
 * no TypeScript loader. The built entry is also the artifact the runtime
 * consumes, so the catalog and the runtime cannot disagree about what a
 * manifest says.
 */
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { IntegrationManifest } from "@withmarfa/shared";
import { validateManifest } from "./validate-manifest.js";
import { discoverIntegrationDirs } from "./discover.js";

export interface InTreeManifest {
  /** Manifest `name`, `<handle>/<name>`. */
  name: string;
  /** Directory under `integrations/`, which is `<handle>/<name>` and so
   *  the same string as `name`. Kept distinct because a deployment can
   *  install into a directory that disagrees, and the skip reasons have to
   *  name the directory that was read rather than the manifest it claimed. */
  dirName: string;
  manifest: IntegrationManifest;
}

export interface LoadManifestsResult {
  manifests: InTreeManifest[];
  /** Directories that yielded no usable manifest, with the reason. Carried
   *  rather than logged-and-dropped so a caller can report a short catalog
   *  instead of silently reconciling less than it should. */
  skipped: { dirName: string; reason: string }[];
}

/** The built entries that may carry a manifest export, most specific first.
 *  `local.js` is the handler entry and re-exports the manifest; `manifest.js`
 *  is what a manifest-only package builds. */
const CANDIDATE_ENTRIES = ["local.js", "manifest.js"] as const;

function looksLikeManifest(v: unknown): boolean {
  return (
    typeof v === "object" &&
    v !== null &&
    "manifest_schema_version" in v &&
    "name" in v &&
    "version" in v
  );
}

/**
 * Pull the manifest out of an imported module.
 *
 * Duck-typed rather than keyed on an export name, because the two entry
 * shapes do not agree on one. A handler entry re-exports its manifest as
 * `manifest`; a manifest-only entry is the integration's own `manifest.ts`
 * built directly, and each of those names its constant after itself.
 * Requiring a single name would mean renaming exports across the tree to
 * satisfy a loader.
 *
 * No integration ships the manifest-only shape today. Every one of them
 * builds a handler entry, so naming an example here would name something
 * dispatchable and teach the opposite of the distinction.
 */
function findManifestExport(mod: Record<string, unknown>): unknown {
  if (looksLikeManifest(mod.manifest)) return mod.manifest;
  const dflt = mod.default as Record<string, unknown> | undefined;
  if (dflt && looksLikeManifest(dflt.manifest)) return dflt.manifest;
  return Object.values(mod).find(looksLikeManifest);
}

export async function loadInTreeManifests(options: {
  /** Absolute path to the `integrations/` directory. */
  integrationsRoot: string;
  /** Per-integration directory names. Defaults to whatever is installed. */
  integrationDirs?: string[];
}): Promise<LoadManifestsResult> {
  const dirs =
    options.integrationDirs ??
    discoverIntegrationDirs(options.integrationsRoot);
  const manifests: InTreeManifest[] = [];
  const skipped: { dirName: string; reason: string }[] = [];

  for (const dirName of dirs) {
    let entryPath: string | undefined;
    for (const candidate of CANDIDATE_ENTRIES) {
      const p = resolve(options.integrationsRoot, dirName, "dist", candidate);
      if (existsSync(p)) {
        entryPath = p;
        break;
      }
    }
    if (!entryPath) {
      skipped.push({
        dirName,
        reason: `no built manifest entry (looked for dist/${CANDIDATE_ENTRIES.join(", dist/")})`,
      });
      continue;
    }

    let mod: Record<string, unknown>;
    try {
      mod = (await import(pathToFileURL(entryPath).href)) as Record<
        string,
        unknown
      >;
    } catch (err) {
      skipped.push({
        dirName,
        reason: `import failed: ${err instanceof Error ? err.message : String(err)}`,
      });
      continue;
    }

    const raw = findManifestExport(mod);
    if (raw === undefined) {
      skipped.push({ dirName, reason: "no manifest export found" });
      continue;
    }
    const validated = validateManifest(raw);
    if (!validated.ok) {
      skipped.push({
        dirName,
        reason: `manifest failed validation: ${validated.errors
          .map((e) => `${e.path}: ${e.message}`)
          .join("; ")}`,
      });
      continue;
    }
    manifests.push({
      name: validated.manifest.name,
      dirName,
      manifest: validated.manifest,
    });
  }

  return { manifests, skipped };
}
