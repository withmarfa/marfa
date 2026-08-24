/**
 * Registering an Integration manifest into the catalog.
 *
 * Extracted from the `POST /integrations` handler so the route and the
 * boot-time catalog reconcile share one implementation. They had better:
 * a catalog row is the manifest a connection resolves for the rest of its
 * life, and two paths that build it differently would produce two kinds of
 * row that behave differently under the same name.
 *
 * **Sibling-per-version, and this function never rewrites.** Registering a
 * name at a version that already exists is reported as a conflict, not an
 * update. The freeze is the point: a connection resolves the manifest it
 * was installed against, and an in-place rewrite would change an installed
 * connection's declared surface with nobody told. Moving a connection
 * forward is a deliberate act with its own consent gate, in
 * `connections/upgrade-pipeline.ts`.
 */
import {
  ErrorCode,
  MarfaError,
  getTypeSchema,
  isReservedRoot,
  registerTypeSchema,
  validateTypeSchema,
} from "@withmarfa/shared";
import type { IntegrationManifest, Item, TypeSchema } from "@withmarfa/shared";
import type { Storage } from "../storage/interface.js";

export interface IntegrationCatalogProperties {
  manifest_name: string;
  manifest_version: string;
  publisher: string;
  summary?: string;
  direction: "read" | "write" | "both";
  manifest: IntegrationManifest;
  registered_at: string;
}

export type RegisterManifestOutcome =
  | { status: "registered"; item: Item }
  | { status: "already_present"; item: Item };

/**
 * Find the catalog row for an exact `(manifest_name, manifest_version)`
 * pair. This is the collision key registration has always used, so it is
 * also the key the reconcile asks with.
 */
export async function findCatalogRow(
  storage: Storage,
  manifestName: string,
  manifestVersion: string,
  spaceId: string | undefined,
): Promise<Item | undefined> {
  const existing = await storage.items.list({
    spaceId,
    type: "system.integration",
    filter: `properties.manifest_name eq "${manifestName}" AND properties.manifest_version eq "${manifestVersion}"`,
    limit: 1,
  });
  return existing.data[0];
}

/**
 * Validate and register the type schemas a manifest brings with it.
 *
 * Ownership is enforced here rather than trusted: a manifest may declare
 * types under its own namespace and nowhere else, and never under a
 * reserved root, because the platform's own vocabulary is seeded rather
 * than registered. A package that could smuggle a type in through its
 * manifest would walk straight around the registration ownership rule.
 *
 * The namespace is the identifier's first segment, not the `publisher`
 * field. The two answer different questions and routinely differ, so
 * reading the gate off `publisher` would check the wrong string.
 */
function validateDeclaredTypes(
  manifest: IntegrationManifest,
  spaceId: string | undefined,
): TypeSchema[] {
  const namespace = manifest.name.split("/")[0] ?? "";
  const declaredTypes: TypeSchema[] = [];
  for (const raw of manifest.type_schemas ?? []) {
    const validated = validateTypeSchema(raw, spaceId);
    if (!validated.success) {
      throw new MarfaError(
        ErrorCode.INVALID_SCHEMA,
        `Invalid type schema declared by ${manifest.name}`,
        { errors: validated.errors },
      );
    }
    const root = validated.data.id.split(".")[0] ?? "";
    if (isReservedRoot(root)) {
      throw new MarfaError(
        ErrorCode.FORBIDDEN,
        `Reserved namespace: "${root}.*" is platform-shipped, so a manifest cannot declare "${validated.data.id}". Reserved-root types are seeded, never registered.`,
      );
    }
    if (root !== namespace) {
      throw new MarfaError(
        ErrorCode.FORBIDDEN,
        `Integration namespace: ${manifest.name} may declare types under "${namespace}.*" only; "${validated.data.id}" is outside it`,
      );
    }
    declaredTypes.push(validated.data);
  }
  return declaredTypes;
}

/**
 * Register one manifest into the catalog.
 *
 * Returns `already_present` rather than throwing when the exact
 * `(name, version)` pair is registered, so the reconcile can treat it as
 * the ordinary steady state. The route turns that into its 409.
 */
export async function registerIntegrationManifest(
  storage: Storage,
  manifest: IntegrationManifest,
  spaceId: string | undefined,
): Promise<RegisterManifestOutcome> {
  const existing = await findCatalogRow(
    storage,
    manifest.name,
    manifest.version,
    spaceId,
  );
  if (existing) return { status: "already_present", item: existing };

  const declaredTypes = validateDeclaredTypes(manifest, spaceId);

  // A target type that resolves nowhere used to register cleanly, install
  // cleanly, and fail on the integration's first write, with the error
  // naming the type rather than the manifest that declared it. Refuse it
  // here, where the manifest is in hand and the author can act.
  //
  // Deliberately not inside `validateManifest`: that function also runs
  // against every connection's STORED manifest on every resolution, and a
  // resolution failure fails the credential mint closed. A registry lookup
  // there would strip permissions from any installed connection naming a
  // type the registry no longer carries.
  const declaredIds = new Set(declaredTypes.map((t) => t.id));
  const unresolvable = manifest.target_types.filter(
    (t) => !declaredIds.has(t) && !getTypeSchema(t, spaceId),
  );
  if (unresolvable.length > 0) {
    throw new MarfaError(
      ErrorCode.VALIDATION_ERROR,
      `Manifest declares target types that resolve to no registered type: ${unresolvable.join(", ")}`,
      { field: "target_types", unresolvable },
    );
  }

  for (const schema of declaredTypes) {
    // Idempotent: re-registering a manifest version that ships the same
    // schema is a no-op rather than a conflict, so a catalog entry can be
    // replayed without the type registration standing in the way.
    const already = await storage.types.get(schema.id, spaceId);
    if (!already) {
      await storage.types.create(schema, spaceId, {
        origin: "integration",
        owner_integration: manifest.name,
      });
    }
    registerTypeSchema(schema, spaceId);
  }

  const properties: IntegrationCatalogProperties = {
    manifest_name: manifest.name,
    manifest_version: manifest.version,
    publisher: manifest.publisher,
    summary: manifest.description,
    direction: manifest.direction,
    manifest,
    registered_at: new Date().toISOString(),
  };
  const item = await storage.items.create(
    {
      type: "system.integration",
      properties: properties as unknown as Record<string, unknown>,
    },
    spaceId,
  );
  return { status: "registered", item };
}
