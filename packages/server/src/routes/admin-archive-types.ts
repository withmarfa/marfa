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
import type { Storage } from "../storage/interface.js";
import { EdgeTypeRequestSchema } from "./edge-types.js";
import { assertParentChain } from "./_parent-chain.js";

/** Bounds an archive the same way the item and edge counts are bounded. */
export const MAX_ARCHIVE_TYPES = 200;
export const MAX_ARCHIVE_EDGE_TYPES = 200;

export interface ArchiveTypeEntry {
  custom_type?: unknown;
  custom_edge_type?: unknown;
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

function parseTypeEntries(
  entries: ArchiveTypeEntry[],
  spaceId: string | undefined,
): { types: TypeSchema[]; edgeTypes: EdgeTypeSchema[] } {
  const types: TypeSchema[] = [];
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
      types.push(result.data);
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
): Promise<ArchiveTypeResult> {
  const { types, edgeTypes } = parseTypeEntries(entries, spaceId);

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
  const typesToWrite: TypeSchema[] = [];
  let typesSkipped = 0;
  for (const schema of types) {
    const existing = existingTypes.get(schema.id);
    if (!existing) {
      typesToWrite.push(schema);
    } else if (sameSchema(normalizeForCompare(existing, spaceId), schema)) {
      typesSkipped += 1;
    } else {
      conflicts.push(schema.id);
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
  const written: TypeSchema[] = [];
  let progress = true;
  while (pending.length > 0 && progress) {
    progress = false;
    for (let i = pending.length - 1; i >= 0; i -= 1) {
      const schema = pending[i];
      if (!schema) continue;
      if (schema.parent && !getTypeSchema(schema.parent, spaceId)) continue;
      if (schema.parent) {
        assertParentChainResolves(schema.id, schema.parent, spaceId);
      }
      // `types.create` registers into the space overlay as part of the
      // write, so nothing here calls the registry directly.
      await storage.types.create(schema, spaceId);
      written.push(schema);
      pending.splice(i, 1);
      progress = true;
    }
  }
  if (pending.length > 0) {
    throw new MarfaError(
      ErrorCode.VALIDATION_ERROR,
      `Archive types name parents that do not resolve: ${pending.map((s) => s.id).join(", ")}`,
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
