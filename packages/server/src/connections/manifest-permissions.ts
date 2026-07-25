/**
 * Manifest → runtime-credential permission translation.
 *
 * Single source of truth for how an Integration manifest's declared
 * surface becomes the permission maps stamped onto a runtime credential.
 * Both mint paths use these builders — the hosted install pipeline
 * (`install-pipeline.ts`) and the local substrate's in-process mint
 * (`integrations/local-runtime/credentials.ts`) — so a credential's
 * reach is always least-privilege: exactly what the manifest declares,
 * never a wildcard.
 */
import type { IntegrationManifest } from "@withmarfa/shared";

/** Translate manifest.target_types + direction into a `type_permissions`
 *  map. Read-only Integrations get `read` on each target type;
 *  write/both get `write`. The runtime's per-Connection
 *  ConnectionClient enforces these at the server boundary.
 *
 *  Two grants are unconditional because they are substrate contract
 *  rather than manifest-declared surface, and a connector cannot run
 *  without them:
 *
 *    - `system.activity` write — the status-reporting channel. The
 *      runtime SDK's activity sink calls `POST /items` with it on every
 *      run; the reserved-namespace gate in `middleware/auth.ts` carries
 *      the matching carve-out for runtime credentials.
 *    - `system.connection` read — a handler reads its own Connection to
 *      resolve `properties.configuration`. `type_permissions` has no
 *      per-item axis, so this is tenant-wide read on connection rows;
 *      it is the tightest the permission model expresses, and reads of
 *      `system.*` were never platform-gated in the first place. */
export function buildTypePermissions(
  manifest: IntegrationManifest | undefined,
): Record<string, "read" | "write"> {
  const out: Record<string, "read" | "write"> = {
    "system.activity": "write",
    "system.connection": "read",
  };
  if (!manifest) return out;
  const level: "read" | "write" =
    manifest.direction === "read" ? "read" : "write";
  for (const t of manifest.target_types) {
    out[t] = level;
  }
  return out;
}

/** Translate manifest.permissions into a runtime-credential
 *  `extension_permissions` map. The `connection.runtime` namespace is
 *  always granted write — the runtime needs it to hydrate its own
 *  cursor state — and any manifest-declared extension grants merge on
 *  top. Same shape the broker uses at refresh time, kept in sync here
 *  so the seed credential and refreshed credentials carry identical
 *  permissions. */
export function buildExtensionPermissions(
  manifest: IntegrationManifest | undefined,
): Record<string, "read" | "write"> {
  const out: Record<string, "read" | "write"> = {
    "connection.runtime": "write",
  };
  const declared = manifest?.permissions?.extension;
  if (declared) {
    for (const [ns, level] of Object.entries(declared)) {
      out[ns] = level;
    }
  }
  return out;
}

export function buildEdgePermissions(
  manifest: IntegrationManifest | undefined,
): Record<string, "read" | "write"> {
  const declared = manifest?.permissions?.edge;
  return declared ? { ...declared } : {};
}
