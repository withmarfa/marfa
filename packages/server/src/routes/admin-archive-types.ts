/**
 * Registering the types an archive carries, before the restore writes
 * anything that needs them.
 *
 * An item can be of a type registered here rather than shipped, and until
 * the archive carried those registrations a restore into an empty database
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
  isValidEdgeTypeIdentifier,
  registerEdgeTypeSchema,
  getEdgeTypeSchema,
  unregisterEdgeTypeSchema,
  validateTypeSchema,
  malformedTypeIdentifier,
} from "@withmarfa/shared";
import type { EdgeTypeSchema, TypeSchema } from "@withmarfa/shared";
import type { Storage, TypeProvenance } from "../storage/interface.js";
import {
  EdgeTypeRequestSchema,
  assertEdgeNamesFree,
  edgeTypeFromRequest,
} from "./edge-types.js";
import { assertParentChain } from "./_parent-chain.js";

/** Bounds an archive the same way the item and edge counts are bounded. */
export const MAX_ARCHIVE_TYPES = 200;
export const MAX_ARCHIVE_EDGE_TYPES = 200;

export interface ArchiveTypeEntry {
  type?: unknown;
  edge_type?: unknown;
  /** Provenance for the `type` on the same line. Optional because a line
   *  can be hand-written or damaged, not because any archive this build
   *  reads omits it. */
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
 * Runs the same check `POST /types` runs, against the same registry, after
 * the batch's own parents are registered so a parent-child
 * pair in one archive validates in either input order.
 *
 * The routes that check a parent chain share the check rather than holding a
 * copy, so a restore cannot accept a chain `POST /types` would refuse. Only
 * the phrasing differs: an archive entry has to be named, because the caller
 * handed over a bundle rather than that type individually.
 */
function assertParentChainResolves(typeId: string, parentId: string): void {
  assertParentChain(typeId, parentId, {
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
function normalizeForCompare(schema: TypeSchema): TypeSchema {
  const result = validateTypeSchema(schema);
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
 *   over a `loadAll()` that reads the whole table. A restore writes
 *   into the same table the platform seed uses, so a replayed `platform` claim
 *   would seed an attacker-chosen type into the registry at the next boot,
 *   undeletable, and resolving for every caller.
 *   A delayed fuse: `create` writes the overlay now and nothing manifests
 *   until a restart.
 * - **`family: "core"` or `"system"`.** A family is the build's: only the seed
 *   writes one, and the restore never does. A type under an ordinary namespace
 *   claiming a shipped family is claiming to be part of the build.
 *
 * Everything else this build does not recognize becomes `unknown`, which is the
 * fail-closed direction: the root is still offerable, read-only.
 */
function provenanceFor(
  entry: ArchiveTypeEntry,
  typeId: string,
): TypeProvenance {
  const raw = entry.provenance;
  if (raw === undefined || raw === null || typeof raw !== "object") {
    return { origin: "unknown" };
  }
  const claimed = raw as { origin?: unknown; family?: unknown };

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

  if (claimed.origin === "user") {
    // `user` earns a read AND write wildcard over the whole namespace
    // root, which makes it the one claim in this file worth more than the
    // two refused above. It is honored as claimed: user accounts carry no
    // handle, so there is nothing to check a publisher-tier id against, and
    // the only party a refusal could stop is the deployment's own operator,
    // who holds the restore door.
    return { origin: "user" };
  }

  // Recorded as unrecorded, which is the fail-closed answer: an origin a
  // newer build wrote that this one does not know earns the read-only
  // treatment rather than a wildcard nobody claimed.
  return { origin: "unknown" };
}

function parseTypeEntries(entries: ArchiveTypeEntry[]): {
  types: PendingType[];
  edgeTypes: EdgeTypeSchema[];
} {
  const types: PendingType[] = [];
  const edgeTypes: EdgeTypeSchema[] = [];
  const edgeNamesTaken = new Map<string, string>();

  for (const entry of entries) {
    if (entry.type !== undefined) {
      const raw = entry.type as { id?: unknown };
      if (typeof raw.id !== "string" || !isValidTypeIdentifier(raw.id)) {
        throw malformedTypeIdentifier(
          "type.id",
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
      const result = validateTypeSchema(entry.type);
      if (!result.success) {
        throw new MarfaError(
          ErrorCode.INVALID_SCHEMA,
          `Archive carries an invalid type schema for "${raw.id}"`,
          { errors: result.errors },
        );
      }
      types.push({
        schema: result.data,
        provenance: provenanceFor(entry, raw.id),
      });
      continue;
    }

    if (entry.edge_type !== undefined) {
      const raw = entry.edge_type as { id?: unknown };
      if (typeof raw.id === "string" && isCoreEdgeType(raw.id)) {
        throw new MarfaError(
          ErrorCode.CONFLICT,
          `Archive carries "${raw.id}", which is a core edge type and cannot be redefined`,
        );
      }
      const parsed = EdgeTypeRequestSchema.safeParse(entry.edge_type);
      if (!parsed.success) {
        throw new MarfaError(
          ErrorCode.VALIDATION_ERROR,
          `Archive carries an invalid edge type "${String(raw.id)}"`,
          { errors: parsed.error.issues },
        );
      }
      const body = parsed.data;
      // The same grammar the live route applies. This copy carried the same
      // hyphen escape hatch, against a file a caller supplies, so a restore
      // was the laxest door onto the edge vocabulary.
      if (!isValidEdgeTypeIdentifier(body.id)) {
        throw new MarfaError(
          ErrorCode.VALIDATION_ERROR,
          `Archive carries an edge type with an invalid identifier: ${body.id}`,
        );
      }
      const schema = edgeTypeFromRequest(body, edgeNamesTaken);
      edgeNamesTaken.set(schema.id, schema.id);
      if (schema.reverse_name !== undefined) {
        edgeNamesTaken.set(schema.reverse_name, schema.id);
      }
      edgeTypes.push(schema);
      continue;
    }

    // A line naming neither key is refused rather than skipped.
    //
    // Every refusal this function exists for — a reserved namespace, a
    // claimed platform origin, a reserved family, a core edge type — lives
    // inside one of the two branches above, so a line that falls past both
    // is a line nothing checked. Dropping it silently is the worst of the
    // available answers: an archive whose registrations all fall through
    // restores as `200` with four zeros, which is exactly the shape of an
    // archive that genuinely carried none.
    throw new MarfaError(
      ErrorCode.VALIDATION_ERROR,
      `Archive carries a types.ndjson line naming neither "type" nor "edge_type": {${Object.keys(entry).join(", ")}}`,
    );
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
): Promise<ArchiveTypeResult> {
  const { types, edgeTypes } = parseTypeEntries(entries);

  if (types.length > MAX_ARCHIVE_TYPES) {
    throw new MarfaError(
      ErrorCode.VALIDATION_ERROR,
      `Maximum ${String(MAX_ARCHIVE_TYPES)} type registrations per archive`,
    );
  }
  if (edgeTypes.length > MAX_ARCHIVE_EDGE_TYPES) {
    throw new MarfaError(
      ErrorCode.VALIDATION_ERROR,
      `Maximum ${String(MAX_ARCHIVE_EDGE_TYPES)} edge-type registrations per archive`,
    );
  }

  // What is registered is a question about this database,
  // not about the in-memory registry: the registry is process state
  // seeded at boot and can hold entries this instance never wrote. The rows
  // are what a restore is reconciling against.
  const existingTypes = new Map(
    (await storage.types.listRegistered()).map((s) => [s.id, s]),
  );
  const existingEdgeTypes = new Map(
    (await storage.edgeTypes.list()).map((s) => [s.id, s]),
  );

  const conflicts: string[] = [];
  const typesToWrite: PendingType[] = [];
  let typesSkipped = 0;
  for (const entry of types) {
    const existing = existingTypes.get(entry.schema.id);
    if (!existing) {
      typesToWrite.push(entry);
    } else if (sameSchema(normalizeForCompare(existing), entry.schema)) {
      // A row that is already here keeps the provenance it already has.
      // Re-restoring an archive must stay a no-op, and rewriting the
      // column would let an archive claiming `user` hand a row recorded
      // as `unknown` the write wildcard it was held back from.
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
      `Archive redefines ${String(conflicts.length)} type(s) this instance already registers differently: ${conflicts.join(", ")}`,
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
      if (schema.parent && !getTypeSchema(schema.parent)) continue;
      if (schema.parent) {
        assertParentChainResolves(schema.id, schema.parent);
        // Checked again now its parent is registered: the first pass ran
        // before the batch's own parents were, so it could not see what a
        // child inherits from one of them, a second thumbnail among it.
        const inherited = validateTypeSchema(schema);
        if (!inherited.success) {
          throw new MarfaError(
            ErrorCode.INVALID_SCHEMA,
            `Archive carries an invalid type schema for "${schema.id}"`,
            { errors: inherited.errors },
          );
        }
      }
      // `types.create` registers into the registry as part of the write, so
      // nothing here calls it directly.
      //
      // Provenance is passed rather than defaulted: the column defaults to
      // `user`, the one the consent screen offers a read-and-write wildcard
      // over, so defaulting would turn a row recorded as `unknown` into the
      // person's own on a round trip.
      await storage.types.create(schema, entry.provenance);
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

  // The names were checked when the archive was read, and much has been
  // awaited since, so each is checked again where it is claimed: under the
  // write lock, with the row written before the registry holds the name, as
  // the route does.
  for (const schema of edgeTypesToWrite) {
    try {
      await storage.runInTransaction(async () => {
        // An id registered since the rows were read was registered by a
        // request that wrote its own row, and registering over it would put
        // this archive's schema in its place.
        if (getEdgeTypeSchema(schema.id)) {
          throw new MarfaError(
            ErrorCode.CONFLICT,
            `Archive carries "${schema.id}", which was registered while the restore ran`,
          );
        }
        assertEdgeNamesFree(schema.id, schema.reverse_name);
        await storage.edgeTypes.create(schema);
        registerEdgeTypeSchema(schema);
      });
    } catch (err) {
      if (getEdgeTypeSchema(schema.id) === schema) {
        unregisterEdgeTypeSchema(schema.id);
      }
      throw err;
    }
  }

  return {
    typesRegistered: written.length,
    typesSkipped,
    edgeTypesRegistered: edgeTypesToWrite.length,
    edgeTypesSkipped,
  };
}
