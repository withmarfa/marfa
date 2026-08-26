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
  validateTypeSchema,
} from "@withmarfa/shared";
import type { IntegrationManifest, Item, TypeSchema } from "@withmarfa/shared";
import { assertParentChain } from "../routes/_parent-chain.js";
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
 * How a manifest's parent-chain refusal reads.
 *
 * The author of the manifest is the person who can act, and they are not
 * holding the type individually the way a `POST /types` caller is, so every
 * message names the manifest and the schema it declared.
 *
 * `unknownParent` names the ancestor and the parent separately. This door
 * only reaches it for an ancestor further up, since the check runs once the
 * immediate parent resolves, and that happens when the registry already
 * holds a chain pointing at nothing.
 */
function assertDeclaredParentChain(
  manifestName: string,
  typeId: string,
  parentId: string,
  spaceId: string | undefined,
): void {
  assertParentChain(typeId, parentId, spaceId, {
    tooDeep: (maxDepth) =>
      `${manifestName} declares type "${typeId}" with an inheritance chain deeper than ${String(maxDepth)}`,
    circular: () =>
      `${manifestName} declares a circular parent chain for type "${typeId}"`,
    unknownParent: (unresolved, parent) =>
      `${manifestName} declares type "${typeId}" under "${parent}", whose own ancestor "${unresolved}" resolves to no registered type`,
  });
}

/**
 * Write a manifest's declared schemas, parents before children.
 *
 * A manifest may legitimately list a child before its parent, so the order
 * of `type_schemas` cannot be the write order. Each pass writes whatever has
 * a resolvable immediate parent and stops when a pass writes nothing, which
 * is the same shape the archive restore uses for the same reason.
 *
 * The chain is checked once the immediate parent resolves, so a schema is
 * refused for the reason that actually applies rather than for the order it
 * happened to appear in.
 *
 * **A stalled remainder is refused for the reason that actually blocks it.**
 * See {@link diagnoseStalled}: a cycle among the manifest's own declarations
 * is something `assertParentChain` never sees, because that check runs only
 * once a parent resolves.
 *
 * **This is not atomic and does not pretend to be.** There is no transaction
 * around the batch and the registry is process-level in-memory state, so a
 * refusal partway through leaves the schemas already written in place. What
 * keeps that recoverable is that the catalog row is written last: the
 * manifest is not registered, so a corrected manifest is an ordinary
 * registration.
 *
 * **A type already registered is left exactly as it stands**, and a manifest
 * declaring it differently is a no-op for that type rather than an update.
 * That is what makes the replay above safe, and it is also the reason the
 * registry write is left to `types.create` rather than repeated after it:
 * registering unconditionally would leave this process serving a shape the
 * stored row does not carry, which the next restart silently reverts.
 * Evolving a registered type is `PUT /types/:id`, where the version bump is
 * checked.
 */
async function writeDeclaredTypes(
  storage: Storage,
  manifest: IntegrationManifest,
  declaredTypes: readonly TypeSchema[],
  spaceId: string | undefined,
): Promise<void> {
  const pending = [...declaredTypes];
  let progress = true;
  while (pending.length > 0 && progress) {
    progress = false;
    for (let i = pending.length - 1; i >= 0; i -= 1) {
      const schema = pending[i];
      if (!schema) continue;
      if (schema.parent) {
        if (!getTypeSchema(schema.parent, spaceId)) continue;
        assertDeclaredParentChain(
          manifest.name,
          schema.id,
          schema.parent,
          spaceId,
        );
      }
      // Replaying a catalog entry must not stand on its own type
      // registration, so an id that already resolves is skipped rather than
      // rewritten. `types.create` registers as part of the write in both
      // dialects, which is why nothing registers separately here.
      const already = await storage.types.get(schema.id, spaceId);
      if (!already) {
        await storage.types.create(schema, spaceId, {
          origin: "integration",
          // The family travels with the type. Without it the row records
          // who published the type and not what kind of type it is, and
          // the only thing left to answer that with is the identifier —
          // which cannot separate a vendor's type from a person's under a
          // claimed handle, because both are publisher-tier by prefix.
          family: "integration",
          owner_integration: manifest.name,
        });
      }
      pending.splice(i, 1);
      progress = true;
    }
  }
  if (pending.length === 0) return;
  throw stalledBatchRefusal(manifest.name, pending);
}

/**
 * Why each schema in a stalled batch could not be written.
 *
 * Every one of them is blocked, but not by itself and not for the same
 * reason, and the difference is the whole value of the message. Walking a
 * schema's parents through the batch either leaves it at a parent nothing
 * resolves, or closes a loop.
 *
 * **Being blocked by a cycle is not being in one.** Given `a` under `b`,
 * `b` under `c` and `c` under `b`, the loop is `b` and `c`; `a` is merely
 * queued behind it. Naming `a` as circular sends its author looking for a
 * loop it is not part of, which is the same wrong turn as reporting the
 * loop as a missing parent.
 *
 * Only the schema whose own parent is unresolvable is named, not everything
 * standing behind it, for the same reason. A schema that is neither is
 * blocked by one that is, so the refusal already names what to fix.
 */
function diagnoseStalled(pending: readonly TypeSchema[]): {
  unresolvable: { id: string; parent: string }[];
  cyclic: string[];
} {
  const byId = new Map(pending.map((schema) => [schema.id, schema]));
  const unresolvable = new Map<string, string>();
  const cyclic = new Set<string>();

  for (const start of pending) {
    const path: string[] = [];
    const onPath = new Set<string>();
    let current: TypeSchema = start;
    while (current.parent !== undefined) {
      if (onPath.has(current.id)) {
        for (const id of path.slice(path.indexOf(current.id))) cyclic.add(id);
        break;
      }
      path.push(current.id);
      onPath.add(current.id);
      const next = byId.get(current.parent);
      if (!next) {
        // The walk left the batch, and the loop above would already have
        // written this schema if the registry could resolve that parent.
        unresolvable.set(current.id, current.parent);
        break;
      }
      current = next;
    }
  }

  return {
    unresolvable: [...unresolvable].map(([id, parent]) => ({ id, parent })),
    cyclic: [...cyclic],
  };
}

/** The refusal a stalled batch earns, naming each cause it actually has. */
function stalledBatchRefusal(
  manifestName: string,
  pending: readonly TypeSchema[],
): MarfaError {
  const { unresolvable, cyclic } = diagnoseStalled(pending);
  const causes: string[] = [];
  if (unresolvable.length > 0) {
    causes.push(
      `these name a parent that resolves to no registered type: ${unresolvable
        .map((entry) => `"${entry.id}" names "${entry.parent}"`)
        .join(", ")}`,
    );
  }
  if (cyclic.length > 0) {
    causes.push(
      `these sit in a circular parent chain: ${cyclic
        .map((id) => `"${id}"`)
        .join(", ")}`,
    );
  }
  return new MarfaError(
    ErrorCode.VALIDATION_ERROR,
    `${manifestName} declares types that cannot be registered. ${causes.join(". ")}`,
  );
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

  await writeDeclaredTypes(storage, manifest, declaredTypes, spaceId);

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
