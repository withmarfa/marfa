import { rememberItemSubject } from "../middleware/replay-requirements.js";
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
 * The doors parse requests and render answers. By default, this function
 * records events inside the write's transaction, with subscriber delivery
 * after commit.
 */
import { itemWrites } from "./item-writes.js";
import {
  ErrorCode,
  MarfaError,
  SYSTEM_DEFAULT_STATE,
  getEdgeTypeSchema,
  getTypeSchema,
  hasBoundedLifecycle,
  isValidId,
  resolveEnforcement,
  softDeleteState,
  validateTransition,
} from "@withmarfa/shared";
import type {
  AncestorUnavailableResponse,
  ApiKey,
  ConflictResponse,
  Edge,
  EnforcementSettings,
  Item,
  ItemState,
  Metadata,
  Tier,
  Version,
} from "@withmarfa/shared";
import {
  checkEdgePermission,
  checkReachesSomeType,
  checkResolvedRowWrite,
  writableRowOf,
  checkTypeAccess,
  checkTypePermission,
  itemProvenanceSource,
  mayReadType,
  mayWriteEdge,
  requireDeclaredTypeMatches,
} from "../middleware/auth.js";
import { MAX_TAGS_PER_ITEM, distinctTags } from "../tag-limits.js";
import {
  announceInlineEdges,
  applyInlineEdges,
} from "../routes/_edges-inline.js";
import { publish, publishEdge } from "../pubsub.js";
import type { InlineEdgeChanges } from "../routes/_edges-inline.js";
import { undeclaredPropertyRefusal } from "../routes/_undeclared-property.js";
import { sourceAllowlistRefusal } from "../routes/_source-allowlist.js";
import { assertTierApplicable } from "../routes/_tier-rules.js";
import { edgeTargetNotFound } from "./edge-constraints.js";
import { planCascadeDelete } from "./edge-cascade.js";
import {
  readableBlockingEdges,
  sourceTypesFor,
} from "../routes/_edge-visibility.js";
import { refuseUnlessUninstalled } from "../routes/_connection-refusal.js";
import { staleVersion } from "./conflict.js";
import type { ConflictMode, StaleVersionResponse } from "./conflict.js";
import { readInstanceConfig } from "./instance-config.js";
import { baseVersion } from "./interface.js";
import type {
  ArchivedDates,
  BlobProof,
  CascadeRoot,
  ResolvedItem,
  Storage,
} from "./interface.js";

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

/** `DELETE /items/{id}`: the row into the bin, with what its cascading
 *  edges take. */
export interface ItemDelete {
  op: "delete";
  id: string;
  /** The version the caller read; absent deletes whatever stands. */
  version?: number;
}

/** A move along the type's lifecycle. Into the bin it is a delete; out of
 *  it, a restore. */
export interface ItemTransition {
  op: "transition";
  id: string;
  state: ItemState;
}

export interface ItemRestore {
  op: "restore";
  id: string;
}

/** The hard delete behind a soft one, with the row's edges. */
export interface ItemPurge {
  op: "purge";
  id: string;
  version?: number;
  /** The retention sweep's purge of an app grant a person revoked, which no
   *  credential may ask for. */
  revokedGrant?: true;
}

export type ItemWrite =
  | ItemUpdate
  | ItemPut
  | ItemCreate
  | ItemDelete
  | ItemTransition
  | ItemRestore
  | ItemPurge;

/** What a lifecycle write moved, for events recorded in its transaction. */
export interface ItemMoved {
  outcome: "moved";
  /** The row as it now stands, or as it stood before a purge took it. */
  item: Item;
  /** The state the row left. */
  from: ItemState;
  /** Rows a trash took with it through cascading edges, as they stood
   *  before it, each recorded as taken with `item`. */
  trashed: Item[];
  /** Rows a restore brought back because the trash that took them was
   *  undone. */
  broughtBack: Item[];
  /** Edges a purge took with the row. */
  edges: Edge[];
  /** The type of each such edge's source, read before the purge took the
   *  row, which its announcement carries (`events.md` 19). */
  edgeSourceTypes: Map<string, string>;
  /** The trash a purged row was taken by, read before the purge. */
  trashedWith?: CascadeRoot;
}

type ResultOf<W extends ItemWrite> = W extends ItemCreate
  ? ItemCreated
  : W extends ItemDelete | ItemPurge
    ? ItemMoved | Extract<ItemWriteResult, { outcome: "stale" }>
    : W extends ItemTransition | ItemRestore
      ? ItemMoved
      : ItemWriteResult;

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

/** How a write is announced. */
export interface AnnounceOptions {
  /** False where the caller announces what it wrote itself, together with
   *  writes of its own: an archive restore, a folder's two-step revoke. */
  announce?: boolean;
  /** Whether the events drive outbound work as well as being logged; the
   *  bulk doors decline it unless asked (`pubsub.ts`). */
  fanout?: boolean;
}

export async function writeItem<W extends ItemWrite>(
  storage: Storage,
  writer: W extends ItemCreate ? { kind: "platform" } : ItemWriter,
  write: W,
  { announce = true, fanout = true }: AnnounceOptions = {},
): Promise<ResultOf<W>> {
  const result = await storage.runInTransaction(async () => {
    const outcome = await (async (): Promise<ItemWriteResult | ItemMoved> => {
      switch (write.op) {
        case "update":
          return await updateById(storage, writer, write);
        case "put":
          return await put(storage, writer, write);
        case "create":
          return await createPlatformRow(storage, writer, write);
        case "delete":
          return await deleteRow(storage, writer, write);
        case "transition":
          return await transitionRow(storage, writer, write);
        case "restore":
          return await restoreRow(storage, writer, write);
        case "purge":
          return await purgeRow(storage, writer, write);
      }
    })();
    // Inside the write's transaction, so the change and its events commit
    // together or not at all.
    if (announce) await announceWrite(storage, write, outcome, fanout);
    return outcome;
  });
  return result as ResultOf<W>;
}

/**
 * The row an update left, without what the store reports about the write
 * beside it: the row has no such columns, so an event or an answer carrying
 * them would hold fields no read of the item returns.
 */
export function rowOf(item: ResolvedItem): Item {
  const row: Item & Partial<ResolvedItem> = { ...item };
  delete row.conflict_resolution;
  delete row.conflict_sibling;
  delete row.conflict_sibling_edges;
  return row;
}

/** The events a write's outcome is announced by, in the order a subscriber
 *  has to meet them: a row before the edges naming it, and the rows a move
 *  carried after the row moved. */
async function announceWrite(
  storage: Storage,
  write: ItemWrite,
  outcome: ItemWriteResult | ItemMoved,
  enableFanout: boolean,
): Promise<void> {
  switch (outcome.outcome) {
    case "created":
      await publish({
        type: "created",
        item: outcome.item,
        metadata: outcome.metadata,
        enableFanout,
      });
      if (outcome.edges)
        await announceInlineEdges(storage, outcome.edges, enableFanout);
      return;
    case "updated": {
      const {
        conflict_sibling: sibling,
        conflict_sibling_edges: siblingEdges,
      } = outcome.item;
      const item = rowOf(outcome.item);
      // The copy first, then the row that gave its value up, so no
      // subscriber sees the losing edit gone from the row and nowhere else.
      if (sibling) {
        await publish({
          type: "created",
          item: sibling,
          metadata: await storage.metadata.get(sibling.id),
          enableFanout,
        });
        await announceInlineEdges(
          storage,
          { created: siblingEdges ?? [], deleted: [] },
          enableFanout,
        );
      }
      await publish({
        type: "updated",
        item,
        metadata: outcome.metadata,
        enableFanout,
      });
      if (outcome.edges)
        await announceInlineEdges(storage, outcome.edges, enableFanout);
      return;
    }
    case "moved":
      await announceMove(storage, write, outcome, enableFanout);
      return;
    case "unchanged":
    case "conflict":
    case "stale":
      return;
  }
}

async function announceMove(
  storage: Storage,
  write: ItemWrite,
  moved: ItemMoved,
  enableFanout: boolean,
): Promise<void> {
  const root: CascadeRoot = { id: moved.item.id, type: moved.item.type };
  const trashedWithRoot = async (): Promise<void> => {
    for (const taken of moved.trashed) {
      await publish({
        type: "deleted",
        item: { ...taken, state: softDeleteState(taken.type) },
        ...(softDeleteState(taken.type) === "trashed" && {
          trashedWith: root,
        }),
        enableFanout,
      });
    }
  };
  const broughtBackWithRoot = async (): Promise<void> => {
    for (const item of moved.broughtBack) {
      await publish({
        type: "restored",
        item,
        metadata: await storage.metadata.get(item.id),
        restoredWith: root,
        enableFanout,
      });
    }
  };
  switch (write.op) {
    case "delete":
      // The rows the cascade took first, as the store takes them.
      await trashedWithRoot();
      await publish({
        type: "deleted",
        item: { ...moved.item, state: softDeleteState(moved.item.type) },
        enableFanout,
      });
      return;
    case "transition":
      await publish({
        type: "state_changed",
        item: moved.item,
        metadata: await storage.metadata.get(moved.item.id),
        enableFanout,
      });
      await trashedWithRoot();
      await broughtBackWithRoot();
      return;
    case "restore":
      await publish({
        type: "restored",
        item: moved.item,
        metadata: await storage.metadata.get(moved.item.id),
        enableFanout,
      });
      await broughtBackWithRoot();
      return;
    case "purge":
      // Each edge the purge took, then the row: an edge pointing at the row
      // lives on another, and nothing else tells that row's holder.
      for (const edge of moved.edges) {
        await publishEdge({
          type: "edge_deleted",
          edge,
          sourceType: moved.edgeSourceTypes.get(edge.source_id),
          purgedWith: moved.item.id,
          enableFanout,
        });
      }
      await publish({
        type: "purged",
        item: moved.item,
        ...(moved.trashedWith && { trashedWith: moved.trashedWith }),
        enableFanout,
      });
      return;
    default:
      return;
  }
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

function assertTypeWrite(writer: ItemWriter, type: string | Item): void {
  if (writer.kind === "credential") {
    if (typeof type !== "string") rememberItemSubject(type, "write");
    checkTypeAccess(
      writer.key,
      typeof type === "string" ? type : type.type,
      "write",
    );
  }
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
  throw new Error("The platform writes no inline edges");
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
      if (writer.kind === "credential") rememberItemSubject(row, "read");
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
  if (writer.kind === "credential") checkReachesSomeType(writer.key);
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
  const row = writableRow(
    writer,
    await storage.items.getIncludingTrashed(write.id),
    notFound,
  );
  assertTypeWrite(writer, row);
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
      // A natural key is its source's: a key moves one only under a source
      // it writes under, its own or one it claims, or it takes the row from
      // the key its own connector syncs it by.
      const key = credentialOf(writer);
      if (key !== undefined) itemProvenanceSource(key, row.source, "subject");
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
      const updated = await itemWrites(storage).update(row.id, {
        properties: change.properties,
        ...(change.properties_mode !== undefined && {
          properties_mode: change.properties_mode,
        }),
        ...(retypeTo !== undefined && { type: retypeTo }),
        // A stale write merges against the snapshot it names, and may be
        // answered with it, so the writer must be able to read its type.
        ...baseVersion(change.version, (type) => mayRead(writer, type)),
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
  sent: ItemPut,
): Promise<ItemWriteResult> {
  const write: ItemPut =
    sent.tags === undefined ? sent : { ...sent, tags: distinctTags(sent.tags) };
  const key = credentialOf(writer);
  if (write.door === "item") assertCreatableState(write.type, write.state);
  assertTypeWrite(writer, write.type);
  const source = itemProvenanceSource(key, write.source);
  const enforcement = await enforcementFor(storage, writer);
  const notAllowed = sourceAllowlistRefusal(enforcement, write.type, source);
  if (notAllowed) throw notAllowed;
  assertTagCount(sent.tags);
  assertEdgeSet(writer, write.edges);

  let existing: Item | null = null;
  let matchedBy: "source_id" | "id" | null = null;
  if (source !== undefined && write.source_id !== undefined) {
    existing = await storage.items.findBySourceId(source, write.source_id);
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
        // The id fallback offline-first clients rely on: a row they may read
        // is updated in place, or acknowledged where it is in the bin.
        if (byId && mayRead(writer, byId.type)) {
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
    if (key !== undefined) {
      checkResolvedRowWrite(key, existing);
      rememberItemSubject(existing, "write");
    }
    if (!write.retype) {
      if (matchedBy === "id" && write.type !== existing.type) {
        throw idReused(existing, write.type);
      }
      requireDeclaredTypeMatches(write.type, existing);
    }
    return {
      outcome: "unchanged",
      item: existing,
      reason: "trashed",
      disclosed: true,
    };
  }

  if (existing) {
    const row = existing;
    if (key !== undefined) {
      checkResolvedRowWrite(key, row);
      rememberItemSubject(row, "write");
    }
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
  const created = await itemWrites(storage).create({
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
 * The tier a new row takes on either create door: the body's, then the
 * credential's default. A `system.*` row takes none, so it never inherits a
 * credential's default.
 */
function createTier(writer: ItemWriter, write: ItemPut): Tier | undefined {
  if (hasBoundedLifecycle(write.type)) return undefined;
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
  const created = await itemWrites(storage).create({
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

/**
 * The row a write names, refused as missing where it is not there, the
 * writer may not read its type, or it is in the bin, which the refusal says
 * to a writer that may read it.
 */
function writableRow(
  writer: ItemWriter,
  row: Item | null,
  notFound: () => MarfaError,
): Item {
  return writableRowOf(row, (type) => mayRead(writer, type), notFound);
}

/** A lifecycle door's row, in the bin included where the move starts from
 *  there. */
async function lifecycleRow(
  storage: Storage,
  writer: ItemWriter,
  id: string,
  { includeTrashed, message }: { includeTrashed: boolean; message: string },
): Promise<Item> {
  assertReachesSomeType(writer);
  const row = await storage.items.getIncludingTrashed(id);
  const notFound = () => new MarfaError(ErrorCode.ITEM_NOT_FOUND, message);
  if (!includeTrashed) return writableRow(writer, row, notFound);
  if (!row || !mayRead(writer, row.type)) throw notFound();
  return row;
}

function staleAgainst(
  row: Item,
  version: number | undefined,
): Extract<ItemWriteResult, { outcome: "stale" }> | undefined {
  if (version === undefined || version === row.version) return undefined;
  return {
    outcome: "stale",
    id: row.id,
    conflict: staleVersion(row.version, row.properties, version, {
      id: row.id,
      tier: row.tier ?? "library",
      occurred_at: row.occurred_at,
      source_id: row.source_id ?? null,
      type: row.type,
    }),
  };
}

function moved(
  item: Item,
  from: ItemState,
  rest: Partial<ItemMoved> = {},
): ItemMoved {
  return {
    outcome: "moved",
    item,
    from,
    trashed: [],
    broughtBack: [],
    edges: [],
    edgeSourceTypes: new Map(),
    ...rest,
  };
}

/**
 * The row into its type's soft-deleted state, and every row its cascading
 * edges reach with it, each recorded as taken with it so a restore brings it
 * back. A `block` edge on any of them refuses the whole move, and so does a
 * live grant record the cascade would carry out.
 */
async function trash(
  storage: Storage,
  writer: ItemWriter,
  row: Item,
): Promise<Item[]> {
  const root: CascadeRoot = { id: row.id, type: row.type };
  let toTrash: string[];
  try {
    toTrash = await planCascadeDelete(storage.edges, row.id);
  } catch (err) {
    throw await withoutHiddenBlockers(storage, writer, err);
  }
  const taken = await Promise.all(toTrash.map((id) => storage.items.get(id)));
  for (const snap of taken) {
    if (!snap) continue;
    refuseUnlessUninstalled(snap, mayRead(writer, snap.type));
  }
  for (const id of toTrash) {
    await itemWrites(storage).delete(id, id === row.id ? undefined : root);
  }
  return taken.filter(
    (snap): snap is Item => snap !== null && snap.id !== row.id,
  );
}

/**
 * A block refusal listing, and counting, only the blocking edges whose kind
 * and both ends the writer may read, so a hidden holder is never named.
 */
async function withoutHiddenBlockers(
  storage: Storage,
  writer: ItemWriter,
  err: unknown,
): Promise<unknown> {
  if (writer.kind !== "credential") return err;
  const details = err instanceof MarfaError ? err.details : undefined;
  const blockers = (details as { blocking_edges?: Edge[] } | undefined)
    ?.blocking_edges;
  const root = (details as { root_item_id?: string } | undefined)?.root_item_id;
  if (!(err instanceof MarfaError) || !blockers || !root) return err;
  const listed = await readableBlockingEdges(storage, writer.key, blockers);
  return new MarfaError(
    err.code,
    listed.length === 0
      ? `Cannot delete item ${root}: blocked by an edge with cascade_on_delete=block`
      : `Cannot delete item ${root}: blocked by ${String(listed.length)} edge(s) with cascade_on_delete=block`,
    { ...details, blocking_edges: listed },
  );
}

async function deleteRow(
  storage: Storage,
  writer: ItemWriter,
  write: ItemDelete,
): Promise<ItemMoved | Extract<ItemWriteResult, { outcome: "stale" }>> {
  const row = await lifecycleRow(storage, writer, write.id, {
    includeTrashed: false,
    message: `Item ${write.id} not found`,
  });
  assertTypeWrite(writer, row);
  const stale = staleAgainst(row, write.version);
  if (stale) return stale;
  const trashed = await trash(storage, writer, row);
  return moved(row, row.state, { trashed });
}

async function transitionRow(
  storage: Storage,
  writer: ItemWriter,
  write: ItemTransition,
): Promise<ItemMoved> {
  const row = await lifecycleRow(storage, writer, write.id, {
    includeTrashed: true,
    message: "Item not found",
  });
  assertTypeWrite(writer, row);
  // Into the bin is a delete by another name: it takes what a delete takes,
  // is held by what holds a delete, and is restored as a delete is.
  if (write.state === "trashed" && row.state !== "trashed") {
    const error = validateTransition(row.type, row.state, write.state);
    if (error) throw new MarfaError(ErrorCode.INVALID_TRANSITION, error);
    const trashed = await trash(storage, writer, row);
    const now = await storage.items.getIncludingTrashed(row.id);
    return moved(now ?? row, row.state, { trashed });
  }
  const broughtBack =
    row.state === "trashed" && write.state === "active"
      ? await itemWrites(storage).restoreBeneath(row.id)
      : [];
  const item = await itemWrites(storage).transition(row.id, write.state);
  return moved(item, row.state, { broughtBack });
}

async function restoreRow(
  storage: Storage,
  writer: ItemWriter,
  write: ItemRestore,
): Promise<ItemMoved> {
  const row = await lifecycleRow(storage, writer, write.id, {
    includeTrashed: true,
    message: `Item ${write.id} not found`,
  });
  assertTypeWrite(writer, row);
  const broughtBack = await itemWrites(storage).restoreBeneath(row.id);
  const item = await itemWrites(storage).restore(row.id);
  return moved(item, row.state, { broughtBack });
}

async function purgeRow(
  storage: Storage,
  writer: ItemWriter,
  write: ItemPurge,
): Promise<ItemMoved | Extract<ItemWriteResult, { outcome: "stale" }>> {
  // The message `storage.items.purge` answers, so a hidden row and no row
  // read alike.
  const row = await lifecycleRow(storage, writer, write.id, {
    includeTrashed: true,
    message: "Item not found",
  });
  if (write.revokedGrant && writer.kind !== "platform")
    throw new MarfaError(
      ErrorCode.INVALID_TRANSITION,
      "Only revoked items can be purged",
    );
  refuseUnlessUninstalled(row);
  // The reserved-namespace fence is asked only of a row not yet
  // soft-deleted. A reserved row already there got there by a cascade or an
  // archive restore, and no credential gets past the fence and the map
  // both, so asking it would strand the row for good.
  if (writer.kind === "credential") {
    if (row.state === softDeleteState(row.type)) {
      rememberItemSubject(row, "write", true);
      checkTypePermission(writer.key, row.type, "write");
    } else {
      rememberItemSubject(row, "write");
      checkTypeAccess(writer.key, row.type, "write");
    }
  }
  const stale = staleAgainst(row, write.version);
  if (stale) return stale;
  const trashedWith = (await storage.items.cascadeMarks([row.id])).get(row.id);
  // Edges carry no foreign key to items, so they go with the row here.
  const edges = [
    ...(await storage.edges.deleteBySource(row.id)),
    ...(await storage.edges.deleteByTarget(row.id)),
  ];
  const edgeSourceTypes = await sourceTypesFor(
    storage,
    edges.map((edge) => edge.source_id),
  );
  await itemWrites(storage).purge(row.id, {
    revokedGrant: write.revokedGrant === true,
  });
  return moved(row, row.state, {
    edges,
    edgeSourceTypes,
    ...(trashedWith && { trashedWith }),
  });
}

/** Finalizes a newly created archive row after metadata has bumped its clock.
 *  The archive caller records the returned frame in its audited transaction. */
export async function finalizeArchiveItem(
  storage: Storage,
  id: string,
  dates: ArchivedDates,
  snapshots: readonly Version[],
): Promise<Item> {
  await storage.versions.restore(snapshots);
  await itemWrites(storage).restoreDates(id, dates);
  const item = await storage.items.getIncludingTrashed(id);
  if (!item)
    throw new Error(`Restored item ${id} disappeared before finalization`);
  return item;
}
