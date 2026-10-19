/**
 * The restore's own checks, asked of an archive export's spooled selection
 * before a byte is sent, so the export never answers with an archive that
 * `POST /restore` refuses or that it would restore only in part.
 *
 * The selection is judged as a restore into an empty instance with this
 * instance's row size cap would judge it: its registrations are staged in a
 * registry frame of its own, which holds the shipped types and nothing of
 * this instance, and its rows are checked against them a page of lines at
 * a time. What a restore would skip is refused here, because a skipped row
 * is a row the archive says it holds and the restore does not bring back.
 *
 * What the check has to remember of the rows it has judged (ids, types and
 * states, natural keys, links, snapshot ids and the edges) is kept in the
 * export's scratch database, so memory holds a page of lines and not the
 * selection. Nothing outside the frame and that database is written.
 *
 * Out of scope are the checks that depend on the instance an archive is
 * restored into: the strict-property lever, rows the target already holds,
 * and the blobs it already has.
 */

import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { Writable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { Client, InStatement } from "@libsql/client";
import {
  ErrorCode,
  MarfaError,
  SYSTEM_DEFAULT_STATE,
  discardRegistryFrame,
  getEdgeTypeSchema,
  registerEdgeTypeSchema,
  registrySnapshotView,
  shippedPlatformTypes,
  type Item,
  type RegistryFrame,
} from "@withmarfa/shared";
import { yieldBulkWork } from "../bulk-actions/yield.js";
import { faultsArmed, holdAt } from "../control/faults.js";
import type { DiskReserve } from "../storage/disk-space.js";
import {
  CYCLE_RISK_EDGE_TYPES,
  assertEdgesFitGraph,
  type EdgeGraph,
  type EdgeProposal,
} from "../storage/edge-constraints.js";
import { linkOf } from "../storage/sqlite/item-links.js";
import { restoredItem } from "../storage/sqlite/item-store.js";
import { registryContext } from "../storage/sqlite/registry-context.js";
import { stageTypeRegistration } from "../storage/sqlite/type-store.js";
import { RESTORE_BATCH_BYTES, RESTORE_BATCH_LINES } from "./restore-archive.js";
import {
  LineLengthGuard,
  assertArchiveTextSize,
  type ReadArchive,
} from "./restore-archive-read.js";
import {
  archiveTypeEntries,
  edgeLines,
  edgeRefusal,
  itemLines,
  itemRefusal,
  restoredProperties,
  restoredSource,
  type ArchivedEdgeLine,
  type ArchivedItemLine,
} from "./restore-archive-rows.js";
import {
  planArchiveTypes,
  stageArchiveTypes,
} from "./restore-archive-types.js";

export interface ArchiveValidationInput {
  lineFiles: ReadArchive["lineFiles"];
  /** The largest properties a write door of the instance takes. */
  maxRowBytes: number;
  /** The export's scratch database, which the check adds its tables to. */
  database: Client;
}

/** The row a restore would refuse or skip, as the export's refusal names it. */
export interface RefusedRow {
  kind: "item" | "edge" | "type" | "blob" | "manifest";
  /** The item's or edge's id, the blob's digest, or null. */
  id: string | null;
  /** The item's type or the edge's edge type, or null. */
  type: string | null;
  /** The field the refusal is about, or null when it is about the whole row. */
  field: string | null;
  /** The code the restore refuses with, or the reason it skips the row for. */
  code: string;
  message: string;
}

/** A selection that a restore would not take whole, naming the row why. */
export class SelectionRefusal extends Error {
  constructor(
    readonly row: RefusedRow,
    options?: ErrorOptions,
  ) {
    super(row.message, options);
    this.name = "SelectionRefusal";
  }
}

type RowAt = Pick<RefusedRow, "kind" | "id" | "type"> & {
  field?: string | null;
};

/** The field a restore's refusal names, read from its details. */
function fieldOf(error: MarfaError): string | null {
  if (error.code === ErrorCode.UNKNOWN_TYPE) return "type";
  const details = error.details ?? {};
  if (typeof details.field === "string") return details.field;
  const [first] = Array.isArray(details.errors)
    ? (details.errors as Record<string, unknown>[])
    : [];
  if (typeof first?.path === "string") return first.path;
  if (typeof first?.field === "string")
    return error.code === ErrorCode.INVALID_PROPERTIES &&
      !first.field.startsWith("_")
      ? `properties.${first.field}`
      : first.field;
  return null;
}

/** `error`, which a restore would answer, about the row `at`. */
export function refusalAt(at: RowAt, error: MarfaError): SelectionRefusal {
  return new SelectionRefusal(
    {
      kind: at.kind,
      id: at.id,
      type: at.type,
      field: at.field === undefined ? fieldOf(error) : at.field,
      code: error.code,
      message: error.message,
    },
    { cause: error },
  );
}

/** A row a restore would skip rather than refuse, for `reason`. */
function skipped(at: RowAt, reason: string, message: string) {
  return new SelectionRefusal({
    kind: at.kind,
    id: at.id,
    type: at.type,
    field: at.field ?? null,
    code: reason,
    message: `Archive restore would skip ${message}.`,
  });
}

/** Under SQLite's limit on bound parameters in one statement. */
const PARAMETERS_PER_STATEMENT = 480;

function* chunks<T>(rows: readonly T[], width: number): Generator<T[]> {
  const size = Math.max(1, Math.floor(PARAMETERS_PER_STATEMENT / width));
  for (let at = 0; at < rows.length; at += size)
    yield rows.slice(at, at + size);
}

const SCHEMA = [
  "CREATE TABLE check_items (id TEXT PRIMARY KEY, type TEXT NOT NULL, state TEXT NOT NULL) WITHOUT ROWID",
  "CREATE TABLE check_unique (key TEXT PRIMARY KEY) WITHOUT ROWID",
  "CREATE TABLE check_edges (source TEXT NOT NULL, type TEXT NOT NULL, target TEXT NOT NULL, ord INTEGER NOT NULL, id TEXT, PRIMARY KEY (source, type, target)) WITHOUT ROWID",
  "CREATE INDEX check_edges_target ON check_edges (target, type)",
];

/**
 * The judged rows as the edge checks read a graph. Cycles are left to one
 * pass over every edge once all are judged (`assertAcyclic`), where a walk
 * per edge would cost the square of a chain's length.
 */
class JudgedGraph implements EdgeGraph {
  constructor(private readonly database: Client) {}

  readonly items: EdgeGraph["items"] = {
    getMany: async (ids) => {
      const found = new Map<string, Pick<Item, "type" | "state">>();
      for (const slice of chunks(ids, 1)) {
        const { rows } = await this.database.execute({
          sql: `SELECT id, type, state FROM check_items WHERE id IN (${slice.map(() => "?").join(",")})`,
          args: slice,
        });
        for (const row of rows)
          found.set(row.id as string, {
            type: row.type as string,
            state: row.state as Item["state"],
          });
      }
      return found;
    },
  };

  readonly edges: EdgeGraph["edges"] = {
    existsExactBatch: async (edges) => {
      const found = new Set<string>();
      for (const slice of chunks(edges, 3)) {
        const { rows } = await this.database.execute({
          sql: `SELECT source, target, type FROM check_edges WHERE (source, type, target) IN (VALUES ${slice.map(() => "(?, ?, ?)").join(",")})`,
          args: slice.flatMap((edge) => [
            edge.source_id,
            edge.edge_type,
            edge.target_id,
          ]),
        });
        for (const row of rows)
          found.add(
            `${row.source as string}|${row.target as string}|${row.type as string}`,
          );
      }
      return found;
    },
    countsBySourceBatch: (pairs) =>
      this.counts(
        "source",
        pairs.map((pair) => [pair.source_id, pair.edge_type]),
      ),
    countsByTargetBatch: (pairs) =>
      this.counts(
        "target",
        pairs.map((pair) => [pair.target_id, pair.edge_type]),
      ),
    wouldCreateCycle: () => Promise.resolve(false),
  };

  private async counts(
    end: "source" | "target",
    pairs: [string, string][],
  ): Promise<Map<string, number>> {
    const counted = new Map<string, number>();
    for (const [id, type] of pairs) counted.set(`${id}|${type}`, 0);
    for (const slice of chunks(pairs, 2)) {
      const { rows } = await this.database.execute({
        sql: `SELECT ${end} AS id, type, count(*) AS n FROM check_edges WHERE (${end}, type) IN (VALUES ${slice.map(() => "(?, ?)").join(",")}) GROUP BY ${end}, type`,
        args: slice.flat(),
      });
      for (const row of rows)
        counted.set(`${row.id as string}|${row.type as string}`, Number(row.n));
    }
    return counted;
  }
}

/** Refuses the selection a restore into an empty instance would not take whole. */
export async function runArchiveValidation(
  input: ArchiveValidationInput,
  reserve: DiskReserve,
  signal: AbortSignal,
): Promise<void> {
  const { database } = input;
  const cancellable = async (work: Promise<void>) => {
    signal.throwIfAborted();
    await new Promise<void>((resolve, reject) => {
      const abort = () => {
        reject(
          signal.reason instanceof Error
            ? signal.reason
            : new Error(String(signal.reason)),
        );
      };
      signal.addEventListener("abort", abort, { once: true });
      work.then(resolve, reject).finally(() => {
        signal.removeEventListener("abort", abort);
      });
    });
  };
  // Other writers can fill the volume while this runs, and an export whose
  // spool then sits inside the reserve stops here.
  const turn = async () => {
    signal.throwIfAborted();
    await yieldBulkWork();
    await cancellable(reserve.look());
  };
  let lines = 0;
  let bytes = 0;
  /** Whether a page of lines has been read since the last turn. */
  const paged = (lineBytes: number) => {
    signal.throwIfAborted();
    lines += 1;
    bytes += lineBytes;
    return lines >= RESTORE_BATCH_LINES || bytes >= RESTORE_BATCH_BYTES;
  };
  const pace = async (lineBytes: number) => {
    if (!paged(lineBytes)) return;
    lines = 0;
    bytes = 0;
    await turn();
  };

  // What the refusal names if a check that knows no row throws.
  let at: RowAt = { kind: "type", id: null, type: null };
  const frame: RegistryFrame = {
    mode: "write",
    active: true,
    sealed: false,
    reachDirty: false,
    dirty: false,
    itemDirty: false,
    view: registrySnapshotView({
      platform: shippedPlatformTypes(),
      custom: [],
      edges: [],
    }),
  };
  try {
    for (const [name, file] of Object.entries(input.lineFiles)) {
      at = {
        kind:
          name === "types.ndjson"
            ? "type"
            : name === "items.ndjson"
              ? "item"
              : "edge",
        id: null,
        type: null,
      };
      if (name === "types.ndjson")
        assertArchiveTextSize((await stat(file)).size, name);
      await pipeline(
        createReadStream(file),
        new LineLengthGuard(name),
        new Writable({
          write(_chunk, _encoding, done) {
            done();
          },
        }),
        { signal },
      );
    }
    await database.batch(SCHEMA, "write");

    await registryContext.run(frame, async () => {
      at = { kind: "type", id: null, type: null };
      const typePlan = await planArchiveTypes(
        {
          types: { listRegistered: () => Promise.resolve([]) },
          edgeTypes: { list: () => Promise.resolve([]) },
        },
        await archiveTypeEntries(input.lineFiles["types.ndjson"], pace),
      );
      await stageArchiveTypes(typePlan, {
        createType: (entry) => {
          stageTypeRegistration(entry.schema, entry.provenance.origin);
          return Promise.resolve();
        },
        updateType: (entry, schema) => {
          stageTypeRegistration(schema, entry.provenance.origin);
          return Promise.resolve();
        },
        createEdgeType: (schema, claim) => {
          claim();
          registerEdgeTypeSchema(schema);
          return Promise.resolve();
        },
      });
      if (faultsArmed()) await cancellable(holdAt("export-validation"));
      await turn();

      const items = new ItemCheck(database, input.maxRowBytes, (row) => {
        at = row;
      });
      for await (const { value, bytes: lineBytes } of itemLines(
        input.lineFiles["items.ndjson"],
      )) {
        at = { kind: "item", id: null, type: null };
        if (value === null)
          throw skipped(at, "malformed", "an item line it cannot read");
        items.add(value);
        if (paged(lineBytes)) {
          lines = 0;
          bytes = 0;
          await items.flush();
          await turn();
        }
      }
      await items.flush();

      const graph = new JudgedGraph(database);
      const edges = new EdgeCheck(database, graph, input.maxRowBytes, (row) => {
        at = row;
      });
      for await (const { value, bytes: lineBytes } of edgeLines(
        input.lineFiles["edges.ndjson"],
      )) {
        at = { kind: "edge", id: null, type: null };
        if (value === null)
          throw skipped(at, "malformed", "an edge line it cannot read");
        edges.add(value);
        if (paged(lineBytes)) {
          lines = 0;
          bytes = 0;
          await edges.flush();
          await turn();
        }
      }
      await edges.flush();
      at = { kind: "edge", id: null, type: null };
      await assertAcyclic(database, turn, (row) => {
        at = row;
      });
    });
  } catch (error) {
    if (
      error instanceof MarfaError &&
      error.code !== ErrorCode.INSUFFICIENT_STORAGE
    )
      throw refusalAt(at, error);
    throw error;
  } finally {
    discardRegistryFrame(frame);
  }
}

/** The items of a page, judged as a restore creates them. */
class ItemCheck {
  private page: ArchivedItemLine[] = [];
  private index = 0;

  constructor(
    private readonly database: Client,
    private readonly maxRowBytes: number,
    private readonly judging: (row: RowAt) => void,
  ) {}

  add(entry: ArchivedItemLine): void {
    this.page.push(entry);
  }

  async flush(): Promise<void> {
    const page = this.page;
    this.page = [];
    if (page.length === 0) return;
    const judged: {
      at: RowAt;
      id: string | undefined;
      type: string;
      state: string;
      claims: { key: string; field: string; what: string }[];
    }[] = [];
    for (const entry of page) {
      const { item } = entry;
      const id = typeof item.id === "string" ? item.id : undefined;
      const type = typeof item.type === "string" ? item.type : null;
      const at: RowAt = { kind: "item", id: id ?? null, type };
      this.judging(at);
      // Snapshot ids are unique across the archive, which `check_unique`
      // answers for the lines before this one.
      const refusal = itemRefusal(
        entry,
        this.index++,
        new Set(),
        this.maxRowBytes,
      );
      if (refusal) throw refusal;
      if (type === null)
        throw skipped(
          { ...at, field: "type" },
          "malformed",
          "an item with no type",
        );
      const { properties } = restoredItem({
        ...(id !== undefined && { id }),
        type,
        properties: restoredProperties(item),
        occurred_at: item.occurred_at as string | undefined,
      });
      const claims: { key: string; field: string; what: string }[] = [];
      const source = restoredSource(item.source);
      if (source && item.source_id) {
        const key = JSON.stringify([source, item.source_id]);
        claims.push({
          key: `n:${key}`,
          field: "source_id",
          what: `a second item with the natural key ${key}`,
        });
      }
      const link = linkOf(type, properties);
      if (link) {
        const key = JSON.stringify([type, link.value]);
        claims.push({
          key: `l:${key}`,
          field: `properties.${link.field}`,
          what: `a second item with the link ${key}`,
        });
      }
      if (Array.isArray(entry.versions))
        entry.versions.forEach((snapshot: { id: string }, at) => {
          claims.push({
            key: `s:${snapshot.id}`,
            field: `versions.${String(at)}.id`,
            what: `a second snapshot with the id ${snapshot.id}`,
          });
        });
      judged.push({
        at,
        id,
        type,
        state:
          typeof item.state === "string" ? item.state : SYSTEM_DEFAULT_STATE,
        claims,
      });
    }

    const ids = judged.flatMap((row) => (row.id === undefined ? [] : [row.id]));
    const heldIds = await held(this.database, "check_items", "id", ids);
    const heldKeys = await held(
      this.database,
      "check_unique",
      "key",
      judged.flatMap((row) => row.claims.map((one) => one.key)),
    );
    for (const row of judged) {
      if (row.id !== undefined) {
        if (heldIds.has(row.id))
          throw skipped(
            { ...row.at, field: "id" },
            "already_present",
            `a second item with the id ${row.id}`,
          );
        heldIds.add(row.id);
      }
      for (const { key, field, what } of row.claims) {
        if (heldKeys.has(key))
          throw skipped({ ...row.at, field }, "already_present", what);
        heldKeys.add(key);
      }
    }

    const writes: InStatement[] = [];
    const rows = judged.filter((row) => row.id !== undefined);
    for (const slice of chunks(rows, 3))
      writes.push({
        sql: `INSERT INTO check_items (id, type, state) VALUES ${slice.map(() => "(?, ?, ?)").join(",")}`,
        args: slice.flatMap((row) => [row.id ?? "", row.type, row.state]),
      });
    const claimed = judged.flatMap((row) => row.claims.map((one) => one.key));
    for (const slice of chunks(claimed, 1))
      writes.push({
        sql: `INSERT INTO check_unique (key) VALUES ${slice.map(() => "(?)").join(",")}`,
        args: slice,
      });
    if (writes.length > 0) await this.database.batch(writes, "write");
  }
}

/** The edges of a page, judged as a restore creates them, one at a time. */
class EdgeCheck {
  private page: ArchivedEdgeLine[] = [];
  private index = 0;

  constructor(
    private readonly database: Client,
    private readonly graph: JudgedGraph,
    private readonly maxRowBytes: number,
    private readonly judging: (row: RowAt) => void,
  ) {}

  add(line: ArchivedEdgeLine): void {
    this.page.push(line);
  }

  async flush(): Promise<void> {
    const page = this.page;
    this.page = [];
    if (page.length === 0) return;
    const proposals: (EdgeProposal & { at: RowAt; id: string | undefined })[] =
      [];
    for (const line of page) {
      const { edge } = line;
      const id = typeof edge.id === "string" ? edge.id : undefined;
      const edgeType =
        typeof edge.edge_type === "string" ? edge.edge_type : null;
      const at: RowAt = { kind: "edge", id: id ?? null, type: edgeType };
      this.judging(at);
      const refusal = edgeRefusal(line, this.index++, this.maxRowBytes);
      if (refusal) throw refusal;
      const { source_id: sourceId, target_id: targetId } = edge;
      if (
        typeof sourceId !== "string" ||
        typeof targetId !== "string" ||
        edgeType === null
      )
        throw skipped(at, "malformed", "a malformed edge");
      proposals.push({
        at,
        id,
        source_id: sourceId,
        target_id: targetId,
        edge_type: edgeType,
        properties: (edge.properties ?? {}) as Record<string, unknown>,
      });
    }

    const ends = await this.graph.items.getMany(
      proposals.flatMap((edge) => [edge.source_id, edge.target_id]),
      { includeTrashed: true },
    );
    const heldIds = await held(
      this.database,
      "check_unique",
      "key",
      proposals.flatMap((edge) =>
        edge.id === undefined ? [] : [`e:${edge.id}`],
      ),
    );
    for (const edge of proposals) {
      for (const end of ["source_id", "target_id"] as const)
        if (!ends.has(edge[end]))
          throw skipped(
            { ...edge.at, field: end },
            "endpoint_missing",
            "an edge whose endpoint it does not carry",
          );
      if (edge.id !== undefined) {
        if (heldIds.has(`e:${edge.id}`))
          throw skipped(
            { ...edge.at, field: "id" },
            "already_present",
            `a second edge with the id ${edge.id}`,
          );
        heldIds.add(`e:${edge.id}`);
      }
    }

    // The batch counts each earlier proposal as stored, as a restore that
    // writes them one at a time does. Only a refused page is judged again,
    // an edge at a time, to name the edge.
    const judge = (upTo: number) =>
      assertEdgesFitGraph(this.graph, proposals.slice(0, upTo), () => true, {
        replay: true,
      });
    try {
      await judge(proposals.length);
    } catch (error) {
      if (!(error instanceof MarfaError)) throw error;
      for (const [at, edge] of proposals.entries()) {
        this.judging(edge.at);
        await judge(at + 1);
      }
      throw error;
    }

    const first = this.index - proposals.length;
    const writes: InStatement[] = [];
    for (const slice of chunks(
      proposals.map((edge, at) => ({ edge, ord: first + at })),
      5,
    ))
      writes.push({
        sql: `INSERT INTO check_edges (source, type, target, ord, id) VALUES ${slice.map(() => "(?, ?, ?, ?, ?)").join(",")}`,
        args: slice.flatMap(({ edge, ord }) => [
          edge.source_id,
          edge.edge_type,
          edge.target_id,
          ord,
          edge.id ?? null,
        ]),
      });
    const ids = proposals.flatMap((edge) =>
      edge.id === undefined ? [] : [`e:${edge.id}`],
    );
    for (const slice of chunks(ids, 1))
      writes.push({
        sql: `INSERT INTO check_unique (key) VALUES ${slice.map(() => "(?)").join(",")}`,
        args: slice,
      });
    await this.database.batch(writes, "write");
  }
}

/** Which of `values` the table holds. */
async function held(
  database: Client,
  table: "check_items" | "check_unique",
  column: "id" | "key",
  values: string[],
): Promise<Set<string>> {
  const found = new Set<string>();
  for (const slice of chunks([...new Set(values)], 1)) {
    const { rows } = await database.execute({
      sql: `SELECT ${column} AS key FROM ${table} WHERE ${column} IN (${slice.map(() => "?").join(",")})`,
      args: slice,
    });
    for (const row of rows) found.add(row.key as string);
  }
  return found;
}

/**
 * Refuses the edges that a restore, writing them in order, would skip for
 * closing a cycle, naming the one it skips.
 *
 * Kahn's algorithm: an acyclic graph is the one whose every edge is reached
 * by peeling the nodes nothing points at. The edge types that can close a
 * longer cycle are those whose cardinality lets a target have one inbound
 * edge, so a node is peeled as soon as its one parent is, and the peel is
 * one walk down from the roots, which SQLite runs as one recursive query.
 * Every edge is reached once, so the graph is acyclic exactly when the walk
 * reaches as many nodes as there are roots and edges.
 */
async function assertAcyclic(
  database: Client,
  turn: () => Promise<void>,
  judging: (row: RowAt) => void,
): Promise<void> {
  const types = [...CYCLE_RISK_EDGE_TYPES];
  for (const type of types) {
    const cardinality = getEdgeTypeSchema(type)?.cardinality;
    if (cardinality !== "one-to-one" && cardinality !== "one-to-many")
      throw new Error(
        `The cycle check needs at most one inbound "${type}" edge per item, and the edge type is ${String(cardinality)}`,
      );
  }
  const among = `type IN (${types.map(() => "?").join(",")})`;
  const roots = `SELECT source AS node, type FROM check_edges e WHERE e.${among} AND NOT EXISTS (SELECT 1 FROM check_edges i WHERE i.target = e.source AND i.type = e.type) GROUP BY source, type`;
  const walk = `WITH RECURSIVE reached(node, type) AS (${roots} UNION ALL SELECT e.target, e.type FROM reached r JOIN check_edges e ON e.source = r.node AND e.type = r.type)`;
  const count = async (sql: string) =>
    Number((await database.execute({ sql, args: types })).rows[0]?.n);
  const reached = await count(`${walk} SELECT count(*) AS n FROM reached`);
  await turn();
  const expected =
    (await count(`SELECT count(*) AS n FROM (${roots})`)) +
    (await count(`SELECT count(*) AS n FROM check_edges WHERE ${among}`));
  if (reached === expected) return;

  // A node the walk did not reach has one parent and no root above it, so
  // climbing from it comes round to a node it has climbed through.
  await database.batch(
    [
      "CREATE TABLE check_reached (node TEXT NOT NULL, type TEXT NOT NULL, PRIMARY KEY (node, type)) WITHOUT ROWID",
      "CREATE TABLE check_climb (node TEXT PRIMARY KEY, step INTEGER NOT NULL, source TEXT NOT NULL, ord INTEGER NOT NULL, id TEXT) WITHOUT ROWID",
      {
        sql: `INSERT INTO check_reached ${walk} SELECT node, type FROM reached`,
        args: types,
      },
    ],
    "write",
  );
  const start = (
    await database.execute({
      sql: `SELECT source, type FROM check_edges e WHERE e.${among} AND NOT EXISTS (SELECT 1 FROM check_reached r WHERE r.node = e.source AND r.type = e.type) LIMIT 1`,
      args: types,
    })
  ).rows[0];
  if (!start) throw new Error("The cycle check found no unreached edge");
  const type = start.type as string;
  let node = start.source as string;
  for (let step = 0; ; step++) {
    if (step % RESTORE_BATCH_LINES === 0) await turn();
    const seen = (
      await database.execute({
        sql: "SELECT step FROM check_climb WHERE node = ?",
        args: [node],
      })
    ).rows[0];
    if (seen) {
      const closing = (
        await database.execute({
          sql: "SELECT source, node AS target, id FROM check_climb WHERE step >= ? ORDER BY ord DESC LIMIT 1",
          args: [Number(seen.step)],
        })
      ).rows[0];
      if (!closing) throw new Error("The cycle check lost the cycle it found");
      judging({
        kind: "edge",
        id: (closing.id as string | null) ?? null,
        type,
        field: null,
      });
      throw new MarfaError(
        ErrorCode.EDGE_CYCLE,
        `Edge "${type}" would close a cycle`,
        {
          edge_type: type,
          source_id: closing.source,
          target_id: closing.target,
        },
      );
    }
    const parent = (
      await database.execute({
        sql: "SELECT source, ord, id FROM check_edges WHERE target = ? AND type = ?",
        args: [node, type],
      })
    ).rows[0];
    if (!parent) throw new Error("The cycle check climbed to a root");
    await database.execute({
      sql: "INSERT INTO check_climb (node, step, source, ord, id) VALUES (?, ?, ?, ?, ?)",
      args: [
        node,
        step,
        parent.source as string,
        Number(parent.ord),
        (parent.id as string | null) ?? null,
      ],
    });
    node = parent.source as string;
  }
}
