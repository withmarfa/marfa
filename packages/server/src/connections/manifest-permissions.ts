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
import { ConnectionMappingSchema } from "@withmarfa/shared";
import type { IntegrationManifest } from "@withmarfa/shared";

/** Translate manifest.target_types into a `type_permissions` map: `write`
 *  on each declared target type. The narrowing that matters is the set of
 *  types — a credential reaches what its manifest declared instead of the
 *  whole space — not the level.
 *
 *  `direction` deliberately plays no part. It describes flow relative to
 *  the UPSTREAM service, not access to Marfa, and it does not reduce to a
 *  Marfa-side level in either direction:
 *
 *    - `read` is an inbound integration: it pulls from upstream and
 *      WRITES the result into Marfa. Every inbound integration calls
 *      `createItem` on its target types, so mapping `read` to a read
 *      grant would break ingestion outright.
 *    - `write` is outbound, but an outbound integration transitions Marfa
 *      items, which is also a Marfa-side write.
 *
 *  Deriving a level from `direction` therefore encodes a relationship that
 *  does not exist. If a per-integration read-only ceiling is wanted later,
 *  it needs its own manifest field that says so.
 *
 *  `system.activity` write is granted unconditionally: it is the
 *  substrate's status-reporting channel rather than manifest-declared
 *  surface, and the runtime SDK's activity sink calls `POST /items` with
 *  it on every run. The reserved-namespace gate in `middleware/auth.ts`
 *  carries the matching carve-out for runtime credentials. A handler also
 *  reads its own Connection to resolve `properties.configuration`; that
 *  is NOT granted here, because `type_permissions` has no per-item axis
 *  and a `system.connection` grant would be space-wide read over every
 *  Connection row. `requireOwnConnectionRead` in `middleware/auth.ts`
 *  admits exactly the credential's own Connection instead. */
export function buildTypePermissions(
  manifest: IntegrationManifest | undefined,
  connectionProperties?: Record<string, unknown>,
): Record<string, "read" | "write"> {
  const out: Record<string, "read" | "write"> = {
    "system.activity": "write",
  };
  if (!manifest) return out;
  for (const t of manifest.target_types) {
    out[t] = "write";
  }
  // A user mapping routes records into types the manifest never named, so
  // the credential needs write on them too. Configure-time validation
  // already refused reserved namespaces and unresolvable types, so the
  // projection stays inside what the space itself declared mappable; a
  // stored document that no longer parses grants nothing.
  const mapping = ConnectionMappingSchema.safeParse(
    connectionProperties?.mapping,
  );
  if (mapping.success) {
    for (const rule of mapping.data.rules) {
      out[rule.target_type] = "write";
    }
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
  const out: Record<string, "read" | "write"> = {};
  const declared = manifest?.permissions?.extension;
  if (declared) {
    for (const [ns, level] of Object.entries(declared)) {
      out[ns] = level;
    }
  }
  // This is a substrate grant, not a manifest option. A manifest that names
  // the reserved namespace cannot accidentally downgrade the credential and
  // make cursor persistence fail at runtime.
  out["connection.runtime"] = "write";
  return out;
}

export function buildEdgePermissions(
  manifest: IntegrationManifest | undefined,
): Record<string, "read" | "write"> {
  const declared = manifest?.permissions?.edge;
  return declared ? { ...declared } : {};
}
