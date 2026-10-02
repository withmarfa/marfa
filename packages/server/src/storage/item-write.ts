/**
 * The one way an item row is created or changed.
 *
 * Every door and background job that writes an item hands its request here
 * and gets back what happened. Inside one transaction this resolves the row
 * the request lands on, asks every rule a write must pass of that row and
 * type as they stand at that moment, and writes the row, its tags and its
 * inline edges. A rule asked before the transaction opened is advisory: a
 * retype, a type change or a trash landing in between is exactly what it
 * exists to notice. `item-write-census.test.ts` fails on a module that
 * writes an item row any other way, outside the exceptions it names.
 *
 * The doors keep what is theirs: parsing the request, rendering the answer,
 * and announcing what committed.
 */
import {
  ErrorCode,
  MarfaError,
  SYSTEM_DEFAULT_STATE,
  getEdgeTypeSchema,
  getTypeSchema,
  hasBoundedLifecycle,
  isValidId,
  resolveEnforcement,
  validateTransition,
} from "@withmarfa/shared";
import type {
  AncestorUnavailableResponse,
  ApiKey,
  ConflictResponse,
  EnforcementSettings,
  Item,
  ItemState,
  Metadata,
  Tier,
} from "@withmarfa/shared";
import {
  checkEdgePermission,
  checkResolvedRowWrite,
  checkTypeAccess,
  computeTypeFilter,
  itemProvenanceSource,
  mayReadType,
  mayWriteEdge,
  requireDeclaredTypeMatches,
} from "../middleware/auth.js";
import { MAX_TAGS_PER_ITEM } from "../tag-limits.js";
import { applyInlineEdges } from "../routes/_edges-inline.js";
import type { InlineEdgeChanges } from "../routes/_edges-inline.js";
import { undeclaredPropertyRefusal } from "../routes/_undeclared-property.js";
import { sourceAllowlistRefusal } from "../routes/_source-allowlist.js";
import { assertTierApplicable } from "../routes/_tier-rules.js";
import { edgeTargetNotFound } from "./edge-constraints.js";
import { staleVersion } from "./conflict.js";
import type { ConflictMode, StaleVersionResponse } from "./conflict.js";
import { readInstanceConfig } from "./instance-config.js";
import type { ResolvedItem, Storage } from "./interface.js";
import type { BlobProof } from "./sqlite/blob-references.js";

/**
 * Who a write is made for. A credential's writes are held to its grants; the
 * platform's own (a folder, a grant's record, an enrichment, an archive
 * restore) are authorized by the door that makes them and held to everything
 * else.
 */
export type ItemWriter =
  { kind: "credential"; key: ApiKey } | { kind: "platform" };

/** The fields a write may set on a row that exists. */
interface RowChange {
  properties?: Record<string, unknown>;
  properties_mode?: "merge" | "replace";
  tier?: Tier;
  occurred_at?: string;
  source_id?: string;
  /** The version the caller read; absent writes over whatever stands. */
  version?: number;
  conflict_mode?: ConflictMode;
  idempotency_key?: string;
  /** Replaces the row's tags. */
  tags?: string[];
  /** Replaces the row's outbound edges of each type named. */
  edges?: Record<string, string[]>;
  blob_proof?: BlobProof;
}

/** A write to a row named by its id: `PATCH /items/{id}`, a bulk action's
 *  row, an enrichment, a platform record. */
export interface ItemUpdate extends RowChange {
  op: "update";
  id: string;
  /** The type the caller says the row is. Refused where it is not, unless
   *  `retype` asks to move the row into it. */
  declared_type?: string;
  retype?: boolean;
  /** What a row missing, unreadable or in the bin answers. */
  not_found?: () => MarfaError;
}

/**
 * A write that creates a row or lands on the one its keys resolve:
 * `POST /items` and an entry of `POST /items/bulk`.
 */
export interface ItemPut extends RowChange {
  op: "put";
  /** Which door, which decides what an id or natural key that matches
   *  does. */
  door: "item" | "bulk_upsert" | "bulk_create_only";
  type: string;
  id?: string;
  state?: ItemState;
  /** The source the body names; the credential's own when absent. */
  source?: string;
  capture_latitude?: number;
  capture_longitude?: number;
  /** Move a matched row into `type` rather than refuse the mismatch. */
  retype?: boolean;
  /** The entry's position in a bulk page, carried on a strict-mode
   *  refusal so the caller can find it. */
  index?: number;
}

/** A row only the platform creates: a folder, a grant's record, a row an
 *  archive restore brings back as it was. */
export interface ItemCreate {
  op: "create";
  type: string;
  properties: Record<string, unknown>;
  id?: string;
  state?: ItemState;
  source?: string;
  version?: number;
  tags?: string[];
  occurred_at?: string;
  tier?: Tier;
  source_id?: string;
  capture_latitude?: number;
  capture_longitude?: number;
  blob_proof?: BlobProof;
}

export type ItemWrite = ItemUpdate | ItemPut | ItemCreate;

export interface ItemCreated {
  outcome: "created";
  item: Item;
  metadata: Metadata;
  edges?: InlineEdgeChanges;
}

export type ItemWriteResult =
  | ItemCreated
  | {
      outcome: "updated";
      item: ResolvedItem;
      metadata: Metadata;
      edges?: InlineEdgeChanges;
    }
  /** Nothing written: the keys resolved a row this write leaves as it is. */
  | {
      outcome: "unchanged";
      item: Item;
      reason: "trashed" | "repeat" | "duplicate_id" | "duplicate_source";
      /** Whether the answer may name the row: false only where the caller
       *  may not read it. */
      disclosed: boolean;
    }
  /** The version the write named is not the row's, and the store could
   *  not merge it. */
  | {
      outcome: "conflict";
      id: string;
      conflict: ConflictResponse | AncestorUnavailableResponse;
    }
  /** The same, for a write that changed nothing of the row itself and so
   *  carried nothing to merge. */
  | { outcome: "stale"; id: string; conflict: StaleVersionResponse };

const refusedRows = new WeakMap<object, string>();

/**
 * The row a refusal was made against, where the caller may be told it: set
 * once the row's own gates have passed, so a refusal ahead of them names
 * nothing.
 */
export function refusedRowId(err: unknown): string | undefined {
  return typeof err === "object" && err !== null
    ? refusedRows.get(err)
    : undefined;
}

async function naming<T>(id: string, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof MarfaError && !refusedRows.has(err)) {
      refusedRows.set(err, id);
    }
    throw err;
  }
}

export async function writeItem(
  storage: Storage,
  writer: { kind: "platform" },
  write: ItemCreate,
): Promise<ItemCreated>;
export async function writeItem(
  storage: Storage,
  writer: ItemWriter,
  write: ItemWrite,
): Promise<ItemWriteResult>;
export async function writeItem(
  storage: Storage,
  writer: ItemWriter,
  write: ItemWrite,
): Promise<ItemWriteResult> {
  return await storage.runInTransaction(async () => {
    switch (write.op) {
      case "update":
        return await updateById(storage, writer, write);
      case "put":
        return await put(storage, writer, write);
      case "create":
        return await createPlatformRow(storage, writer, write);
    }
  });
}

function credentialOf(writer: ItemWriter): ApiKey | undefined {
  return writer.kind === "credential" ? writer.key : undefined;
}

async function enforcementFor(
  storage: Storage,
  writer: ItemWriter,
): Promise<EnforcementSettings> {
  return resolveEnforcement(
    await readInstanceConfig(storage.settings),
    credentialOf(writer),
  );
}

/** Whether this writer may read rows of `type`. */
function mayRead(writer: ItemWriter, type: string): boolean {
  return writer.kind === "platform" || mayReadType(writer.key, type);
}

function assertTypeWrite(writer: ItemWriter, type: string): void {
  if (writer.kind === "credential") checkTypeAccess(writer.key, type, "write");
}

/**
 * The shape of an inline edge set, and the writer's grant on each edge type.
 * An empty list is a delete instruction, so it is gated like any other.
 */
function assertEdgeSet(
  writer: ItemWriter,
  edges: Record<string, string[]> | undefined,
): void {
  if (!edges) return;
  for (const [edgeType, targets] of Object.entries(edges)) {
    if (!Array.isArray(targets)) {
      throw new MarfaError(
        ErrorCode.VALIDATION_ERROR,
        `edges.${edgeType} must be an array of item ids`,
      );
    }
    for (const target of targets) {
      if (!isValidId(target)) {
        throw new MarfaError(
          ErrorCode.INVALID_ID,
          `Invalid target id in edges.${edgeType}`,
        );
      }
    }
    assertEdgeWrite(writer, edgeType);
  }
}

function assertEdgeWrite(writer: ItemWriter, edgeType: string): void {
  if (writer.kind === "credential") {
    checkEdgePermission(writer.key, edgeType, "write");
    return;
  }
  throw new MarfaError(
    ErrorCode.EDGE_PERMISSION_DENIED,
    `Missing edge.${edgeType}:write permission`,
    { edge_type: edgeType, required: "write" },
  );
}

async function writeEdges(
  storage: Storage,
  writer: ItemWriter,
  id: string,
  edges: Record<string, string[]> | undefined,
): Promise<InlineEdgeChanges | undefined> {
  if (!edges) return undefined;
  return await applyInlineEdges(
    storage,
    id,
    edges,
    (edgeType) => {
      assertEdgeWrite(writer, edgeType);
    },
    (type) => mayRead(writer, type),
  );
}

/**
 * Each inline edge's type is known, each target named once, and each target
 * a live row the writer may read. Asked ahead of the version, so a stale
 * write cannot tell a target it may not read from a missing one.
 */
async function assertEdgeTargets(
  storage: Storage,
  writer: ItemWriter,
  edges: Record<string, string[]> | undefined,
): Promise<void> {
  if (!edges) return;
  for (const [edgeType, targets] of Object.entries(edges)) {
    if (!getEdgeTypeSchema(edgeType)) {
      throw new MarfaError(
        ErrorCode.EDGE_TYPE_NOT_FOUND,
        `Unknown edge type: ${edgeType}`,
      );
    }
    const seen = new Set<string>();
    for (const target of targets) {
      if (seen.has(target)) {
        throw new MarfaError(
          ErrorCode.EDGE_CONSTRAINT_VIOLATION,
          `Duplicate target ${target} in edges.${edgeType}`,
        );
      }
      seen.add(target);
      const row = await storage.items.get(target);
      if (!row || !mayRead(writer, row.type)) throw edgeTargetNotFound(target);
    }
  }
}

function assertTagCount(tags: readonly string[] | undefined): void {
  if (tags && tags.length > MAX_TAGS_PER_ITEM) {
    throw new MarfaError(
      ErrorCode.VALIDATION_ERROR,
      `Maximum ${String(MAX_TAGS_PER_ITEM)} tags per item`,
    );
  }
}

/**
 * A create is not a transition, so nothing puts it through the graph on its
 * own. Asking what the default start state can reach gives each type its own
 * answer: `trashed` is a state, and not one a `system.*` lifecycle holds.
 */
function assertCreatableState(
  type: string,
  state: ItemState | undefined,
): void {
  if (!state || state === SYSTEM_DEFAULT_STATE) return;
  const error = validateTransition(type, SYSTEM_DEFAULT_STATE, state);
  if (error) throw new MarfaError(ErrorCode.VALIDATION_ERROR, error);
}

/** A credential that may read no type at all is refused outright rather
 *  than told a row is missing. */
function assertReachesSomeType(writer: ItemWriter): void {
  if (writer.kind !== "credential") return;
  if (computeTypeFilter(writer.key).allowed?.length === 0) {
    throw new MarfaError(
      ErrorCode.TYPE_NOT_PERMITTED,
      "This credential's type permissions reach no type, so there is nothing on the data plane it may read.",
    );
  }
}

/** What `PATCH /items/{id}` and the other id-addressed writes do. */
async function updateById(
  storage: Storage,
  writer: ItemWriter,
  write: ItemUpdate,
): Promise<ItemWriteResult> {
  assertReachesSomeType(writer);
  const notFound =
    write.not_found ??
    (() =>
      new MarfaError(ErrorCode.ITEM_NOT_FOUND, `Item ${write.id} not found`));
  const row = await storage.items.get(write.id);
  if (!row || !mayRead(writer, row.type)) throw notFound();
  assertTypeWrite(writer, row.type);
  const retypeTo =
    write.retype === true &&
    write.declared_type !== undefined &&
    write.declared_type !== row.type
      ? write.declared_type
      : undefined;
  if (retypeTo !== undefined) {
    assertTypeWrite(writer, retypeTo);
  } else if (write.declared_type !== undefined) {
    requireDeclaredTypeMatches(write.declared_type, row);
  }
  return await changeRow(storage, writer, row, write, retypeTo, {});
}

/**
 * Everything a write to a resolved row asks after the row's own type gate:
 * the move's destination, the tier, the natural key, the inline edges, strict
 * mode, then the store's write, which validates the result and holds the
 * version.
 */
async function changeRow(
  storage: Storage,
  writer: ItemWriter,
  row: Item,
  change: RowChange,
  retypeTo: string | undefined,
  refusalDetails: Record<string, unknown>,
  /** An upsert writes the row whatever it carries: landing on it is the
   *  write. */
  upsert = false,
): Promise<ItemWriteResult> {
  return await naming(row.id, async () => {
    const resultingType = retypeTo ?? row.type;
    if (retypeTo !== undefined && !getTypeSchema(retypeTo)) {
      throw new MarfaError(
        ErrorCode.UNKNOWN_TYPE,
        `Unknown type: ${retypeTo}. Register it via POST /types before moving items into it.`,
        { type: retypeTo },
      );
    }
    assertTierApplicable(resultingType, change.tier);
    if (
      change.source_id !== undefined &&
      change.source_id !== (row.source_id ?? undefined)
    ) {
      const holder = await storage.items.findBySourceId(
        row.source,
        change.source_id,
      );
      if (holder && holder.id !== row.id) {
        throw new MarfaError(
          ErrorCode.SOURCE_ID_CONFLICT,
          `source_id "${change.source_id}" is already in use under source "${row.source}"`,
          { source: row.source, source_id: change.source_id },
        );
      }
    }
    assertEdgeSet(writer, change.edges);
    assertTagCount(change.tags);
    if (change.properties !== undefined && writer.kind === "credential") {
      const undeclared = undeclaredPropertyRefusal(
        await enforcementFor(storage, writer),
        resultingType,
        change.properties,
        refusalDetails,
      );
      if (undeclared) throw undeclared;
    }
    await assertEdgeTargets(storage, writer, change.edges);

    const writesRow =
      upsert ||
      change.properties !== undefined ||
      change.tier !== undefined ||
      change.occurred_at !== undefined ||
      change.source_id !== undefined ||
      retypeTo !== undefined;
    let item: ResolvedItem;
    if (writesRow) {
      const key = credentialOf(writer);
      const updated = await storage.items.update(row.id, {
        properties: change.properties,
        ...(change.properties_mode !== undefined && {
          properties_mode: change.properties_mode,
        }),
        ...(retypeTo !== undefined && { type: retypeTo }),
        ...(change.version !== undefined && { version: change.version }),
        ...(change.conflict_mode !== undefined && {
          conflict_mode: change.conflict_mode,
        }),
        ...(change.idempotency_key !== undefined && {
          idempotency_key: change.idempotency_key,
        }),
        ...(key !== undefined && {
          may_copy_edge: (
            edgeType: string,
            sourceType: string,
            targetType: string,
          ) => mayWriteEdge(key, edgeType, sourceType, targetType),
        }),
        tier: change.tier,
        occurred_at: change.occurred_at,
        source_id: change.source_id,
        ...(change.blob_proof !== undefined && {
          blob_proof: change.blob_proof ?? undefined,
        }),
      });
      if ("error" in updated) {
        return { outcome: "conflict", id: row.id, conflict: updated };
      }
      item = updated;
    } else {
      // Nothing of the row itself changes, so the store never sees the
      // version; it is held here, against the row as it stands.
      if (change.version !== undefined && change.version !== row.version) {
        return {
          outcome: "stale",
          id: row.id,
          conflict: staleVersion(row.version, row.properties, change.version, {
            id: row.id,
            tier: row.tier ?? "library",
            occurred_at: row.occurred_at,
            source_id: row.source_id ?? null,
            type: row.type,
          }),
        };
      }
      item = row;
    }

    if (change.tags !== undefined) {
      await storage.metadata.set(row.id, change.tags);
    }
    const edges = await writeEdges(storage, writer, row.id, change.edges);
    const metadata = await storage.metadata.get(row.id);
    return {
      outcome: "updated",
      item,
      metadata,
      ...(edges !== undefined && { edges }),
    };
  });
}

/**
 * `POST /items` and a bulk entry: create the row, or land on the one its
 * natural key or id resolves, decided inside the transaction that writes so
 * two sends of one key cannot both find nothing.
 */
async function put(
  storage: Storage,
  writer: ItemWriter,
  write: ItemPut,
): Promise<ItemWriteResult> {
  const key = credentialOf(writer);
  if (write.door === "item") assertCreatableState(write.type, write.state);
  assertTypeWrite(writer, write.type);
  const source = itemProvenanceSource(key, write.source);
  const enforcement = await enforcementFor(storage, writer);
  const notAllowed = sourceAllowlistRefusal(enforcement, write.type, source);
  if (notAllowed) throw notAllowed;
  assertTagCount(write.tags);
  assertEdgeSet(writer, write.edges);

  let existing: Item | null = null;
  let matchedBy: "source_id" | "id" | null = null;
  if (source !== undefined && write.source_id !== undefined) {
    existing = await storage.items.findBySourceIdIncludingTrashed(
      source,
      write.source_id,
    );
    if (existing) matchedBy = "source_id";
  }
  if (!existing && write.id !== undefined) {
    const byId = await storage.items.getIncludingTrashed(write.id);
    switch (write.door) {
      case "item": {
        // A create arriving again under the id the caller minted is the
        // caller's own write: answered with the row, not refused. A row the
        // caller may not read goes on to the insert's plain `conflict`.
        if (byId && mayRead(writer, byId.type)) {
          if (byId.type !== write.type) throw idReused(byId, write.type);
          return {
            outcome: "unchanged",
            item: byId,
            reason: "repeat",
            disclosed: true,
          };
        }
        break;
      }
      case "bulk_create_only":
        if (byId) {
          existing = byId;
          matchedBy = "id";
        }
        break;
      case "bulk_upsert":
        // The id fallback offline-first clients rely on: a live row they
        // may read is updated in place.
        if (byId && byId.state !== "trashed" && mayRead(writer, byId.type)) {
          existing = byId;
          matchedBy = "id";
        }
        break;
    }
  }

  if (existing && write.door === "bulk_create_only") {
    return {
      outcome: "unchanged",
      item: existing,
      reason: matchedBy === "id" ? "duplicate_id" : "duplicate_source",
      disclosed: matchedBy === "id" || mayRead(writer, existing.type),
    };
  }

  if (existing?.state === "trashed") {
    // The person deleted this row. A re-sync reviving it would overturn
    // that silently, and refusing would fail the same sync forever, so it
    // is acknowledged and nothing is written. Gated on the row's type first,
    // so a refusal discloses nothing.
    if (key !== undefined) checkResolvedRowWrite(key, existing);
    if (!write.retype) requireDeclaredTypeMatches(write.type, existing);
    return {
      outcome: "unchanged",
      item: existing,
      reason: "trashed",
      disclosed: true,
    };
  }

  if (existing) {
    const row = existing;
    if (key !== undefined) checkResolvedRowWrite(key, row);
    return await naming(row.id, async () => {
      if (
        write.door === "item" &&
        write.id !== undefined &&
        write.id !== row.id
      ) {
        throw new MarfaError(
          ErrorCode.VALIDATION_ERROR,
          "Request `id` does not match the item resolved by (source, source_id)",
          {
            field: "id",
            requested_id: write.id,
            existing_id: row.id,
            source,
            source_id: write.source_id,
          },
        );
      }
      // A move needs write on the type entered, which the write's own
      // type gate above has already asked.
      const moving = write.retype === true && write.type !== row.type;
      if (!moving) {
        if (matchedBy === "id" && write.type !== row.type) {
          throw idReused(row, write.type);
        }
        requireDeclaredTypeMatches(write.type, row);
      }
      // The id finds a row whatever source wrote it, and a natural key is
      // its source's: an entry moves one only under the source it is
      // written under, or it takes the row from the key its own connector
      // syncs it by.
      if (
        matchedBy === "id" &&
        write.source_id !== undefined &&
        write.source_id !== (row.source_id ?? undefined) &&
        row.source !== source
      ) {
        throw new MarfaError(
          ErrorCode.FORBIDDEN,
          `This entry is written under the source "${source ?? "(none)"}" and may not move a natural key under the source "${row.source}".`,
          { source: row.source },
        );
      }
      // A re-sync naming no tier leaves the row's tier where it is: the
      // person may have moved it since the connector last wrote it.
      return await changeRow(
        storage,
        writer,
        row,
        write,
        moving ? write.type : undefined,
        write.index === undefined
          ? {}
          : { index: write.index, item_id: row.id },
        true,
      );
    });
  }

  assertCreatableState(write.type, write.state);
  assertTierApplicable(write.type, write.tier);
  const undeclared = undeclaredPropertyRefusal(
    enforcement,
    write.type,
    write.properties ?? {},
    write.index === undefined ? {} : { index: write.index },
  );
  if (undeclared) throw undeclared;
  const created = await storage.items.create({
    type: write.type,
    properties: write.properties ?? {},
    ...(write.blob_proof !== undefined && {
      blob_proof: write.blob_proof ?? undefined,
    }),
    ...(write.id !== undefined && { id: write.id }),
    ...(write.state !== undefined && { state: write.state }),
    ...(createTier(writer, write) !== undefined && {
      tier: createTier(writer, write),
    }),
    ...(write.occurred_at !== undefined && { occurred_at: write.occurred_at }),
    ...(source !== undefined && { source }),
    ...(write.source_id !== undefined && { source_id: write.source_id }),
    ...(write.capture_latitude !== undefined && {
      capture_latitude: write.capture_latitude,
    }),
    ...(write.capture_longitude !== undefined && {
      capture_longitude: write.capture_longitude,
    }),
    ...(write.tags !== undefined && { tags: write.tags }),
  });
  const edges = await writeEdges(storage, writer, created.id, write.edges);
  return {
    outcome: "created",
    item: created,
    // What the create wrote: its tags over empty extensions.
    metadata: { item_id: created.id, tags: write.tags ?? [], extensions: {} },
    ...(edges !== undefined && { edges }),
  };
}

/**
 * The tier a new row takes: the body's, then on `POST /items` the
 * credential's default. A `system.*` row takes none, so it never inherits a
 * credential's default.
 */
function createTier(writer: ItemWriter, write: ItemPut): Tier | undefined {
  if (hasBoundedLifecycle(write.type)) return undefined;
  if (write.door !== "item") return write.tier;
  return write.tier ?? credentialOf(writer)?.default_tier ?? "library";
}

function idReused(row: Item, declared: string): MarfaError {
  return new MarfaError(
    ErrorCode.ID_REUSED,
    `Item id ${row.id} already names an item of type "${row.type}", not "${declared}"`,
    {
      existing_id: row.id,
      differs: ["type"],
      declared_type: declared,
      actual_type: row.type,
    },
  );
}

async function createPlatformRow(
  storage: Storage,
  writer: ItemWriter,
  write: ItemCreate,
): Promise<ItemCreated> {
  // A credential's creates go through `put`, which holds them to its grants.
  if (writer.kind !== "platform") {
    throw new Error("A credential's create is a put");
  }
  const created = await storage.items.create({
    type: write.type,
    properties: write.properties,
    ...(write.id !== undefined && { id: write.id }),
    ...(write.state !== undefined && { state: write.state }),
    ...(write.source !== undefined && { source: write.source }),
    ...(write.version !== undefined && { version: write.version }),
    ...(write.tags !== undefined && { tags: write.tags }),
    ...(write.occurred_at !== undefined && { occurred_at: write.occurred_at }),
    ...(write.tier !== undefined && { tier: write.tier }),
    ...(write.source_id !== undefined && { source_id: write.source_id }),
    ...(write.capture_latitude !== undefined && {
      capture_latitude: write.capture_latitude,
    }),
    ...(write.capture_longitude !== undefined && {
      capture_longitude: write.capture_longitude,
    }),
    ...(write.blob_proof != null && { blob_proof: write.blob_proof }),
  });
  return {
    outcome: "created",
    item: created,
    metadata: { item_id: created.id, tags: write.tags ?? [], extensions: {} },
  };
}
