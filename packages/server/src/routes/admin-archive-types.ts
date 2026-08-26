/**
 * Registering the custom types an archive carries, before the restore
 * writes anything that needs them.
 *
 * A space's items can be of types the space registered itself, and until
 * the archive carried those registrations a restore into an empty space
 * dropped every such item as an unknown type. The registrations therefore
 * land first, outside the restore transaction, because the type registry
 * is process-level in-memory state that a rollback cannot reach anyway:
 * see the note on `registerArchiveTypes` for why that is acceptable and
 * what it costs.
 */

import {
  ErrorCode,
  MarfaError,
  classifyNamespace,
  getTypeSchema,
  isCoreEdgeType,
  isValidTypeIdentifier,
  registerEdgeTypeSchema,
  validateTypeSchema,
} from "@withmarfa/shared";
import type {
  EdgeTypeSchema,
  FieldDefinition,
  TypeSchema,
} from "@withmarfa/shared";
import type { Storage, TypeProvenance } from "../storage/interface.js";
import { EdgeTypeRequestSchema } from "./edge-types.js";
import { assertParentChain } from "./_parent-chain.js";

/** Bounds an archive the same way the item and edge counts are bounded. */
export const MAX_ARCHIVE_TYPES = 200;
export const MAX_ARCHIVE_EDGE_TYPES = 200;

export interface ArchiveTypeEntry {
  custom_type?: unknown;
  custom_edge_type?: unknown;
  /** Provenance for the `custom_type` on the same line. Absent in every
   *  archive taken before exports carried it, which is what `unknown`
   *  exists to record. */
  provenance?: unknown;
}

/** A type from the archive with the provenance the restore will write. */
interface PendingType {
  schema: TypeSchema;
  provenance: TypeProvenance;
}

export interface ArchiveTypeResult {
  typesRegistered: number;
  typesSkipped: number;
  edgeTypesRegistered: number;
  edgeTypesSkipped: number;
}

/**
 * Runs the same check `POST /types` runs, against the same space-scoped
 * registry, after the batch's own parents are registered so a parent-child
 * pair in one archive validates in either input order.
 *
 * The routes that check a parent chain share the check rather than holding a
 * copy, so a restore cannot accept a chain `POST /types` would refuse. Only
 * the phrasing differs: an archive entry has to be named, because the caller
 * handed over a bundle rather than that type individually.
 *
 * Manifest registration is not one of them and checks nothing, which is a
 * gap in that path rather than in this one.
 */
function assertParentChainResolves(
  typeId: string,
  parentId: string,
  spaceId: string | undefined,
): void {
  assertParentChain(typeId, parentId, spaceId, {
    tooDeep: (maxDepth) =>
      `Archive type "${typeId}" has an inheritance chain deeper than ${String(maxDepth)}`,
    circular: () => `Archive type "${typeId}" declares a circular parent chain`,
    // The caller checks that the immediate parent resolves before reaching
    // this, so the id reported here is always further up the chain and the
    // two are never the same. A branch on that would never take its other
    // side.
    unknownParent: (unresolved, parent) =>
      `Archive type "${typeId}" names parent "${parent}", whose own ancestor "${unresolved}" is unknown`,
  });
}

/** Two schemas are the same registration when they normalize identically. */
function sameSchema(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/**
 * The archive's entries are compared after validation, which normalizes
 * them (a `format` collapses into a field type, a top-level `required`
 * array moves onto its fields). The stored row was written by whatever
 * the server accepted at the time, so it has to be put through the same
 * pass or a schema identical in meaning reads as a conflict. A row that
 * no longer validates is left un-normalized and will simply compare
 * unequal, which is the right answer: it is not the archive's schema.
 */
function normalizeForCompare(
  schema: TypeSchema,
  spaceId: string | undefined,
): TypeSchema {
  const result = validateTypeSchema(schema, spaceId);
  return result.success ? result.data : schema;
}

/**
 * What provenance the restore writes for one archive entry.
 *
 * **An archive is a file, and a file is something an attacker can hand you.**
 * The namespace guard above stops a reserved *identifier*; provenance is a
 * separate axis and needs its own refusals, because the column decides what
 * the consent screen offers over the row.
 *
 * Two claims are refused outright rather than quietly downgraded, so that a
 * hostile archive fails loudly instead of half-landing:
 *
 * - **`origin: "platform"`.** `projectPlatformRows` filters `origin !== "platform"`
 *   and does not filter `space_id`, over a `loadCustomTypes()` that reads the
 *   whole table. On a self-host a restore writes into `space_id = ""`, the same
 *   bucket the platform seed uses, so a replayed `platform` claim would seed an
 *   attacker-chosen type into the global registry at the next boot, resolving for
 *   every space, undeletable, and `default_on` in every space's connected bundle.
 *   A delayed fuse: `create` writes the space overlay now and nothing manifests
 *   until a restart.
 * - **`family: "core"` or `"system"`.** Family decides membership of the content
 *   category, and `core` is the permissive value the boot projection exists to
 *   warn about. A type under an ordinary namespace claiming a shipped family is
 *   claiming to be part of the build.
 *
 * Everything else this build does not recognize becomes `unknown`, which is the
 * fail-closed direction: the root is still offerable, read-only.
 */
function provenanceFor(
  entry: ArchiveTypeEntry,
  typeId: string,
  publisherHandle: PublisherHandleCheck,
): TypeProvenance {
  const raw = entry.provenance;
  if (raw === undefined || raw === null || typeof raw !== "object") {
    return { origin: "unknown" };
  }
  const claimed = raw as {
    origin?: unknown;
    family?: unknown;
    owner_integration?: unknown;
  };

  if (claimed.origin === "platform") {
    throw new MarfaError(
      ErrorCode.FORBIDDEN,
      `Archive claims type "${typeId}" is platform-shipped; the platform set is a property of the build and cannot be restored`,
      { claimed_origin: "platform" },
    );
  }
  if (claimed.family === "core" || claimed.family === "system") {
    throw new MarfaError(
      ErrorCode.FORBIDDEN,
      `Archive claims type "${typeId}" belongs to the ${claimed.family} family, which is reserved for types the build ships`,
      { claimed_family: claimed.family },
    );
  }

  if (claimed.origin === "integration") {
    return {
      origin: "integration",
      // The family that travels with a manifest-declared type, and the only
      // one a restore may write. Anything else was refused above or is
      // absent.
      family: "integration",
      ...(typeof claimed.owner_integration === "string" &&
        claimed.owner_integration.length > 0 && {
          owner_integration: claimed.owner_integration,
        }),
    };
  }
  if (claimed.origin === "user") {
    // `user` earns a read AND write wildcard over the whole namespace
    // root, which makes it the one claim in this file worth more than the
    // two refused above. Honoring it unchecked turns a restore into a way
    // to buy what `POST /types` sells only to the holder of a handle:
    // that route binds publisher-tier registration to owning the handle,
    // and this path has never had the same check.
    //
    // Degraded rather than refused, deliberately. Refusing would reject
    // legitimate archives too, a space's own backup restored somewhere
    // its handle does not resolve among them, and the rule stated for the
    // bundles applies here: putting a type nowhere is an omission rather
    // than a narrowing. The type still restores and its root is still
    // offerable, without the half nobody could verify.
    if (!publisherHandle.permits(typeId)) return { origin: "unknown" };
    return { origin: "user" };
  }

  // Recorded as unrecorded. Covers an archive predating provenance, and an
  // origin a newer build wrote that this one does not know.
  return { origin: "unknown" };
}

/**
 * Whether a claimed `user` origin is one this space could have made itself.
 *
 * Mirrors the binding `POST /types` applies: the publisher tier is the only
 * one whose first segment is a claimable handle, so registering there means
 * holding that exact handle. The rule binds only in hosted mode, because
 * keys mode has no user accounts and so no handle system to check against,
 * and the only party a refusal could stop there is the deployment's own
 * operator.
 */
interface PublisherHandleCheck {
  permits(typeId: string): boolean;
}

function publisherHandleCheck(
  authMode: "keys" | "hosted",
  handle: string | null,
): PublisherHandleCheck {
  return {
    permits(typeId: string): boolean {
      if (authMode !== "hosted") return true;
      if (classifyNamespace(typeId) !== "publisher") return true;
      return handle !== null && typeId.split(".")[0] === handle;
    },
  };
}

function parseTypeEntries(
  entries: ArchiveTypeEntry[],
  spaceId: string | undefined,
  publisherHandle: PublisherHandleCheck,
): { types: PendingType[]; edgeTypes: EdgeTypeSchema[] } {
  const types: PendingType[] = [];
  const edgeTypes: EdgeTypeSchema[] = [];

  for (const entry of entries) {
    if (entry.custom_type !== undefined) {
      const raw = entry.custom_type as { id?: unknown };
      if (typeof raw.id !== "string" || !isValidTypeIdentifier(raw.id)) {
        throw new MarfaError(
          ErrorCode.INVALID_TYPE,
          `Archive carries a type with an invalid identifier: ${String(raw.id)}`,
        );
      }
      // An archive is a file, and a file is something an attacker can
      // hand you. Reserved namespaces are platform-shipped, so a restore
      // may never mint one whatever the credential doing the restoring
      // holds: the platform set is a property of the build, not of the
      // request.
      const tier = classifyNamespace(raw.id);
      if (tier === "core" || tier === "system" || tier === "marfa") {
        throw new MarfaError(
          ErrorCode.FORBIDDEN,
          `Archive carries a reserved-namespace type "${raw.id}"; ${tier}.* types are platform-shipped and cannot be restored`,
          { namespace: tier },
        );
      }
      const result = validateTypeSchema(entry.custom_type, spaceId);
      if (!result.success) {
        throw new MarfaError(
          ErrorCode.INVALID_SCHEMA,
          `Archive carries an invalid type schema for "${raw.id}"`,
          { errors: result.errors },
        );
      }
      types.push({
        schema: result.data,
        provenance: provenanceFor(entry, raw.id, publisherHandle),
      });
      continue;
    }

    if (entry.custom_edge_type !== undefined) {
      const raw = entry.custom_edge_type as { id?: unknown };
      if (typeof raw.id === "string" && isCoreEdgeType(raw.id)) {
        throw new MarfaError(
          ErrorCode.CONFLICT,
          `Archive carries "${raw.id}", which is a core edge type and cannot be redefined`,
        );
      }
      const parsed = EdgeTypeRequestSchema.safeParse(entry.custom_edge_type);
      if (!parsed.success) {
        throw new MarfaError(
          ErrorCode.VALIDATION_ERROR,
          `Archive carries an invalid edge type "${String(raw.id)}"`,
          { errors: parsed.error.issues },
        );
      }
      const body = parsed.data;
      if (!isValidTypeIdentifier(body.id) && !body.id.includes("-")) {
        throw new MarfaError(
          ErrorCode.VALIDATION_ERROR,
          `Archive carries an edge type with an invalid identifier: ${body.id}`,
        );
      }
      // Same defaulting the route applies, so a schema that round-trips
      // through an export and back compares equal to the one on disk.
      edgeTypes.push({
        id: body.id,
        ...(body.label !== undefined && { label: body.label }),
        ...(body.description !== undefined && {
          description: body.description,
        }),
        cardinality: body.cardinality,
        source_type_constraints: body.source_type_constraints ?? ["*"],
        target_type_constraints: body.target_type_constraints ?? ["*"],
        cascade_on_delete: body.cascade_on_delete ?? "orphan",
        property_schema: (body.property_schema ?? {}) as Record<
          string,
          FieldDefinition
        >,
      });
    }
  }

  return { types, edgeTypes };
}

/**
 * Validates and registers the archive's types, then reports what landed.
 *
 * Runs before the restore transaction opens, and deliberately: the type
 * registry is a process-level in-memory map, so registering inside the
 * transaction would leave the registry holding types a rollback removed
 * from the database. Registering first inverts that into the harmless
 * direction — a failed restore can leave a registration that no item
 * uses, which the next restore skips as identical and an operator can
 * delete. Blobs already land outside the transaction for the same reason.
 *
 * Conflicts are decided in a pre-pass over the whole batch so a refusal
 * names every clashing id at once and nothing has been written yet. An
 * identical existing registration is a skip, not a conflict: re-restoring
 * the same archive has to be a no-op.
 */
export async function registerArchiveTypes(
  storage: Storage,
  entries: ArchiveTypeEntry[],
  spaceId: string | undefined,
  authMode: "keys" | "hosted",
): Promise<ArchiveTypeResult> {
  // Resolved once for the batch rather than per entry: it is one row, it
  // cannot change while the batch is parsed, and the parse is synchronous.
  const handle =
    authMode === "hosted" && spaceId && storage.users
      ? ((await storage.users.getBySpaceId(spaceId))?.handle ?? null)
      : null;
  const { types, edgeTypes } = parseTypeEntries(
    entries,
    spaceId,
    publisherHandleCheck(authMode, handle),
  );

  if (types.length > MAX_ARCHIVE_TYPES) {
    throw new MarfaError(
      ErrorCode.VALIDATION_ERROR,
      `Maximum ${String(MAX_ARCHIVE_TYPES)} custom types per archive`,
    );
  }
  if (edgeTypes.length > MAX_ARCHIVE_EDGE_TYPES) {
    throw new MarfaError(
      ErrorCode.VALIDATION_ERROR,
      `Maximum ${String(MAX_ARCHIVE_EDGE_TYPES)} custom edge types per archive`,
    );
  }

  // What this space has registered is a question about this database,
  // not about the in-memory registry: the registry is process state
  // seeded at boot and can hold entries this space never wrote. The rows
  // are what a restore is reconciling against.
  const existingTypes = new Map(
    (await storage.types.listCustom(spaceId)).map((s) => [s.id, s]),
  );
  const existingEdgeTypes = new Map(
    (await storage.edgeTypes.list(spaceId)).map((s) => [s.id, s]),
  );

  const conflicts: string[] = [];
  const typesToWrite: PendingType[] = [];
  let typesSkipped = 0;
  for (const entry of types) {
    const existing = existingTypes.get(entry.schema.id);
    if (!existing) {
      typesToWrite.push(entry);
    } else if (
      sameSchema(normalizeForCompare(existing, spaceId), entry.schema)
    ) {
      // A row that is already here keeps the provenance it already has.
      // Re-restoring an archive must stay a no-op, and rewriting the
      // column would let a second restore of an older copy walk a row
      // back to `unknown` after an integration had claimed it.
      typesSkipped += 1;
    } else {
      conflicts.push(entry.schema.id);
    }
  }

  const edgeTypesToWrite: EdgeTypeSchema[] = [];
  let edgeTypesSkipped = 0;
  for (const schema of edgeTypes) {
    const existing = existingEdgeTypes.get(schema.id);
    if (!existing) {
      edgeTypesToWrite.push(schema);
    } else if (sameSchema(existing, schema)) {
      edgeTypesSkipped += 1;
    } else {
      conflicts.push(schema.id);
    }
  }

  if (conflicts.length > 0) {
    throw new MarfaError(
      ErrorCode.CONFLICT,
      `Archive redefines ${String(conflicts.length)} type(s) the target space already registers differently: ${conflicts.join(", ")}`,
      { conflicting_ids: conflicts },
    );
  }

  // Parents before children, so a subtype's parent resolves whichever
  // order the archive listed them in. A chain longer than the batch is
  // caught by the depth guard rather than by looping forever.
  const pending = [...typesToWrite];
  const written: PendingType[] = [];
  let progress = true;
  while (pending.length > 0 && progress) {
    progress = false;
    for (let i = pending.length - 1; i >= 0; i -= 1) {
      const entry = pending[i];
      if (!entry) continue;
      const schema = entry.schema;
      if (schema.parent && !getTypeSchema(schema.parent, spaceId)) continue;
      if (schema.parent) {
        assertParentChainResolves(schema.id, schema.parent, spaceId);
      }
      // `types.create` registers into the space overlay as part of the
      // write, so nothing here calls the registry directly.
      //
      // Provenance is passed rather than defaulted. Defaulting is what made
      // an archive round trip launder a connected service's type into the
      // person's own: the column defaults to `user`, and `user` is the one
      // the consent screen offers a read-and-write wildcard over.
      await storage.types.create(schema, spaceId, entry.provenance);
      written.push(entry);
      pending.splice(i, 1);
      progress = true;
    }
  }
  if (pending.length > 0) {
    throw new MarfaError(
      ErrorCode.VALIDATION_ERROR,
      `Archive types name parents that do not resolve: ${pending.map((e) => e.schema.id).join(", ")}`,
    );
  }

  for (const schema of edgeTypesToWrite) {
    await storage.edgeTypes.create(schema, spaceId);
    // The edge-type store does not touch the registry, so the route
    // registers separately and this has to as well.
    registerEdgeTypeSchema(schema, spaceId);
  }

  return {
    typesRegistered: written.length,
    typesSkipped,
    edgeTypesRegistered: edgeTypesToWrite.length,
    edgeTypesSkipped,
  };
}
