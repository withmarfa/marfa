/* eslint-disable no-restricted-syntax -- Not yet on the shared space
 * fence. `storage/space-condition.ts` is the one spelling of it, and
 * this store predates it; the rule covers every store so a new file is
 * covered by default, which leaves the existing ones needing a line
 * that says so. Normalizing one is a change of its own: an absent space
 * has to be read call site by call site, and reading it wrong is the
 * defect the helper exists for. Delete this line when you do. */
import {
  eq,
  and,
  or,
  asc,
  desc,
  inArray,
  lt,
  gt,
  gte,
  sql,
  count,
} from "drizzle-orm";
import { ErrorCode, MarfaError, generateId } from "@withmarfa/shared";
import type { Edge, PaginatedResult } from "@withmarfa/shared";
import type {
  EdgeStore,
  EdgeListFilters,
  StoredCreateEdgeInput,
} from "../interface.js";
import {
  encodeCursor,
  decodeCursor,
  encodeKeyedCursor,
  decodeKeyedCursor,
  normalizeTimeBound,
} from "../interface.js";
import type { CursorSortKey } from "../interface.js";
import { rowToEdge } from "../edge-constraints.js";
import { edges } from "./schema.js";
import type { PgDb } from "./connection.js";
import { isPrimaryKeyViolation } from "./pk-violation.js";

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 500;

function clampLimit(n: number | undefined): number {
  if (!n || n <= 0) return DEFAULT_LIMIT;
  return Math.min(n, MAX_LIMIT);
}

function typeFilter(value: string | string[] | undefined) {
  if (!value) return undefined;
  if (Array.isArray(value)) {
    if (value.length === 0) return undefined;
    return inArray(edges.edge_type, value);
  }
  return eq(edges.edge_type, value);
}

export class PgEdgeStore implements EdgeStore {
  constructor(private db: PgDb) {}

  async createRaw(
    input: StoredCreateEdgeInput,
    spaceId?: string,
  ): Promise<Edge> {
    const now = new Date().toISOString();
    const id = input.id ?? generateId();
    const properties = input.properties ?? {};
    const row = {
      id,
      space_id: spaceId ?? null,
      source_id: input.source_id,
      target_id: input.target_id,
      edge_type: input.edge_type,
      properties: JSON.stringify(properties),
      created_at: now,
      updated_at: now,
      // Named rather than left to the column default: this row is also
      // what the method returns, so a create that let the database fill
      // the version in would report one it had not read back.
      //
      // A restore recreates an edge under its archived id and carries the
      // version that id had reached; every other create starts at 1.
      version: input.version ?? 1,
    };
    // A client may mint this id, so a collision is a caller error rather
    // than a server fault. Without the trap it surfaced as a 500, which
    // tells a synced client nothing it can act on — and the id it sent is
    // exactly the thing it needs named back.
    try {
      await this.db.insert(edges).values(row);
    } catch (err) {
      if (isPrimaryKeyViolation(err, "edges")) {
        throw new MarfaError(
          ErrorCode.CONFLICT,
          `Edge with id=${id} already exists`,
          { existing_id: id },
        );
      }
      throw err;
    }
    return rowToEdge(row);
  }

  async get(id: string): Promise<Edge | null> {
    const [row] = await this.db.select().from(edges).where(eq(edges.id, id));
    return row ? rowToEdge(row) : null;
  }

  private async listByKey(
    keyColumn: typeof edges.source_id | typeof edges.target_id,
    value: string,
    filters?: EdgeListFilters,
  ): Promise<PaginatedResult<Edge>> {
    const limit = clampLimit(filters?.limit);
    const conditions = [eq(keyColumn, value)];
    const typed = typeFilter(filters?.edge_type);
    if (typed) conditions.push(typed);

    if (filters?.cursor) {
      const { v, id } = decodeCursor(filters.cursor);
      const cursorCondition = or(
        lt(edges.created_at, v),
        and(eq(edges.created_at, v), lt(edges.id, id)),
      );
      if (cursorCondition) conditions.push(cursorCondition);
    }

    const rows = await this.db
      .select()
      .from(edges)
      .where(and(...conditions))
      .orderBy(desc(edges.created_at), desc(edges.id))
      .limit(limit + 1);

    const hasMore = rows.length > limit;
    const slice = rows.slice(0, limit);
    let cursor: string | null = null;
    if (hasMore) {
      const last = slice.at(-1);
      if (last) cursor = encodeCursor(last.created_at, last.id);
    }
    return { data: slice.map(rowToEdge), cursor, has_more: hasMore };
  }

  listFromSource(
    sourceId: string,
    filters?: EdgeListFilters,
  ): Promise<PaginatedResult<Edge>> {
    return this.listByKey(edges.source_id, sourceId, filters);
  }

  listToTarget(
    targetId: string,
    filters?: EdgeListFilters,
  ): Promise<PaginatedResult<Edge>> {
    return this.listByKey(edges.target_id, targetId, filters);
  }

  async list(
    filters?: EdgeListFilters & { spaceId?: string },
  ): Promise<PaginatedResult<Edge>> {
    const limit = clampLimit(filters?.limit);
    // Two orderings over one listing. The default is newest-created
    // first, which is what a person browsing wants; a catch-up needs
    // `(updated_at, id)` ascending, because that is the only order a
    // cursor can advance through as rows keep changing underneath it.
    //
    // The bound is re-spelled to the shape `updated_at` is written in
    // before it reaches the comparison, which is lexical over a text
    // column — see `normalizeTimeBound`.
    const updatedAfter = normalizeTimeBound(
      filters?.updated_after,
      "updated_after",
    );
    const catchUp = updatedAfter !== undefined;
    const key: CursorSortKey = catchUp ? "updated_at" : "created_at";
    const conditions = [];
    if (filters?.spaceId) {
      conditions.push(eq(edges.space_id, filters.spaceId));
    }
    const typed = typeFilter(filters?.edge_type);
    if (typed) conditions.push(typed);
    if (updatedAfter !== undefined) {
      conditions.push(gte(edges.updated_at, updatedAfter));
    }

    if (filters?.cursor) {
      // Keyed, so a cursor issued under the other ordering is refused
      // rather than honoured against the wrong column. Both columns hold
      // ISO timestamps, so the wrong one compares perfectly well and
      // returns a page that is simply not the next page.
      const { v, id } = decodeKeyedCursor(filters.cursor, key);
      const cursorCondition = catchUp
        ? or(
            gt(edges.updated_at, v),
            and(eq(edges.updated_at, v), gt(edges.id, id)),
          )
        : or(
            lt(edges.created_at, v),
            and(eq(edges.created_at, v), lt(edges.id, id)),
          );
      if (cursorCondition) conditions.push(cursorCondition);
    }

    const rows = await this.db
      .select()
      .from(edges)
      .where(conditions.length ? and(...conditions) : undefined)
      .orderBy(
        ...(catchUp
          ? [asc(edges.updated_at), asc(edges.id)]
          : [desc(edges.created_at), desc(edges.id)]),
      )
      .limit(limit + 1);

    const hasMore = rows.length > limit;
    const slice = rows.slice(0, limit);
    let cursor: string | null = null;
    if (hasMore) {
      const last = slice.at(-1);
      if (last)
        cursor = encodeKeyedCursor(
          catchUp ? last.updated_at : last.created_at,
          last.id,
          key,
        );
    }
    return { data: slice.map(rowToEdge), cursor, has_more: hasMore };
  }

  async updateProperties(
    id: string,
    properties: Record<string, unknown>,
    spaceId?: string,
    expectedVersion?: number,
  ): Promise<{ ok: true; edge: Edge } | { ok: false; current: Edge }> {
    const now = new Date().toISOString();
    const identity =
      spaceId !== undefined
        ? and(eq(edges.id, id), eq(edges.space_id, spaceId))
        : eq(edges.id, id);
    // The precondition joins the identity in one predicate rather than
    // replacing it: a caller that names another space's edge must be
    // refused for the space even when it names that edge's real version.
    const where =
      expectedVersion !== undefined
        ? and(identity, eq(edges.version, expectedVersion))
        : identity;
    const [written] = await this.db
      .update(edges)
      .set({
        properties: JSON.stringify(properties),
        updated_at: now,
        version: sql`${edges.version} + 1`,
      })
      .where(where)
      .returning();
    if (written) return { ok: true, edge: rowToEdge(written) };
    // Zero rows is ambiguous: the row is gone, or its version moved. Read
    // it back on identity alone to tell those apart — still space-fenced,
    // so a cross-space id stays absent rather than becoming a conflict.
    const [current] = await this.db.select().from(edges).where(identity);
    // Typed, because this is a race a client hits legitimately: it held a
    // version, somebody else moved the row on and then removed it. A bare
    // Error fails the handler's duck-type and leaves for the caller a 500
    // and an operator alert, for an outcome that is simply the row being
    // gone.
    if (!current) {
      throw new MarfaError(ErrorCode.EDGE_NOT_FOUND, `Edge ${id} not found`);
    }
    return { ok: false, current: rowToEdge(current) };
  }

  async delete(id: string, spaceId?: string): Promise<void> {
    const where =
      spaceId !== undefined
        ? and(eq(edges.id, id), eq(edges.space_id, spaceId))
        : eq(edges.id, id);
    await this.db.delete(edges).where(where);
  }

  async deleteBySource(
    sourceId: string,
    edgeType?: string,
    spaceId?: string,
  ): Promise<Edge[]> {
    const conditions = [eq(edges.source_id, sourceId)];
    if (edgeType) conditions.push(eq(edges.edge_type, edgeType));
    if (spaceId !== undefined) conditions.push(eq(edges.space_id, spaceId));
    const removed = await this.db
      .delete(edges)
      .where(and(...conditions))
      .returning();
    return removed.map(rowToEdge);
  }

  async deleteByTarget(
    targetId: string,
    edgeType?: string,
    spaceId?: string,
  ): Promise<Edge[]> {
    const conditions = [eq(edges.target_id, targetId)];
    if (edgeType) conditions.push(eq(edges.edge_type, edgeType));
    if (spaceId !== undefined) conditions.push(eq(edges.space_id, spaceId));
    const removed = await this.db
      .delete(edges)
      .where(and(...conditions))
      .returning();
    return removed.map(rowToEdge);
  }

  async deleteBySourceBatch(
    sourceIds: string[],
    edgeType?: string,
    spaceId?: string,
  ): Promise<Edge[]> {
    if (sourceIds.length === 0) return [];
    const unique = Array.from(new Set(sourceIds));
    const conditions = [inArray(edges.source_id, unique)];
    if (edgeType) conditions.push(eq(edges.edge_type, edgeType));
    if (spaceId !== undefined) conditions.push(eq(edges.space_id, spaceId));
    const where = and(...conditions);
    const removed = await this.db.delete(edges).where(where).returning();
    return removed.map(rowToEdge);
  }

  async deleteByTargetBatch(
    targetIds: string[],
    edgeType?: string,
    spaceId?: string,
  ): Promise<Edge[]> {
    if (targetIds.length === 0) return [];
    const unique = Array.from(new Set(targetIds));
    const conditions = [inArray(edges.target_id, unique)];
    if (edgeType) conditions.push(eq(edges.edge_type, edgeType));
    if (spaceId !== undefined) conditions.push(eq(edges.space_id, spaceId));
    const where = and(...conditions);
    const removed = await this.db.delete(edges).where(where).returning();
    return removed.map(rowToEdge);
  }

  async countBySource(
    sourceId: string,
    edgeType: string,
    spaceId?: string,
  ): Promise<number> {
    const conditions = [
      eq(edges.source_id, sourceId),
      eq(edges.edge_type, edgeType),
    ];
    if (spaceId !== undefined) conditions.push(eq(edges.space_id, spaceId));
    const [row] = await this.db
      .select({ c: count() })
      .from(edges)
      .where(and(...conditions));
    return row?.c ?? 0;
  }

  async countByTarget(
    targetId: string,
    edgeType: string,
    spaceId?: string,
  ): Promise<number> {
    const conditions = [
      eq(edges.target_id, targetId),
      eq(edges.edge_type, edgeType),
    ];
    if (spaceId !== undefined) conditions.push(eq(edges.space_id, spaceId));
    const [row] = await this.db
      .select({ c: count() })
      .from(edges)
      .where(and(...conditions));
    return row?.c ?? 0;
  }

  async existsExact(
    sourceId: string,
    targetId: string,
    edgeType: string,
    spaceId?: string,
  ): Promise<boolean> {
    const conditions = [
      eq(edges.source_id, sourceId),
      eq(edges.target_id, targetId),
      eq(edges.edge_type, edgeType),
    ];
    if (spaceId !== undefined) conditions.push(eq(edges.space_id, spaceId));
    const [row] = await this.db
      .select({ id: edges.id })
      .from(edges)
      .where(and(...conditions))
      .limit(1);
    return !!row;
  }

  async countsBySourceBatch(
    pairs: { source_id: string; edge_type: string }[],
    spaceId?: string,
  ): Promise<Map<string, number>> {
    const out = new Map<string, number>();
    if (pairs.length === 0) return out;
    const byType = new Map<string, Set<string>>();
    for (const p of pairs) {
      const bucket = byType.get(p.edge_type) ?? new Set<string>();
      bucket.add(p.source_id);
      byType.set(p.edge_type, bucket);
    }
    for (const [edgeType, sourceIds] of byType) {
      const ids = Array.from(sourceIds);
      const conditions = [
        eq(edges.edge_type, edgeType),
        inArray(edges.source_id, ids),
      ];
      if (spaceId !== undefined) conditions.push(eq(edges.space_id, spaceId));
      const rows = await this.db
        .select({
          source_id: edges.source_id,
          c: count(),
        })
        .from(edges)
        .where(and(...conditions))
        .groupBy(edges.source_id);
      for (const row of rows) {
        out.set(`${row.source_id}|${edgeType}`, row.c);
      }
    }
    return out;
  }

  async countsByTargetBatch(
    pairs: { target_id: string; edge_type: string }[],
    spaceId?: string,
  ): Promise<Map<string, number>> {
    const out = new Map<string, number>();
    if (pairs.length === 0) return out;
    const byType = new Map<string, Set<string>>();
    for (const p of pairs) {
      const bucket = byType.get(p.edge_type) ?? new Set<string>();
      bucket.add(p.target_id);
      byType.set(p.edge_type, bucket);
    }
    for (const [edgeType, targetIds] of byType) {
      const ids = Array.from(targetIds);
      const conditions = [
        eq(edges.edge_type, edgeType),
        inArray(edges.target_id, ids),
      ];
      if (spaceId !== undefined) conditions.push(eq(edges.space_id, spaceId));
      const rows = await this.db
        .select({
          target_id: edges.target_id,
          c: count(),
        })
        .from(edges)
        .where(and(...conditions))
        .groupBy(edges.target_id);
      for (const row of rows) {
        out.set(`${row.target_id}|${edgeType}`, row.c);
      }
    }
    return out;
  }

  async existsExactBatch(
    pairs: {
      source_id: string;
      target_id: string;
      edge_type: string;
    }[],
    spaceId?: string,
  ): Promise<Set<string>> {
    const out = new Set<string>();
    if (pairs.length === 0) return out;
    const byType = new Map<string, { s: string; t: string }[]>();
    for (const p of pairs) {
      const bucket = byType.get(p.edge_type) ?? [];
      bucket.push({ s: p.source_id, t: p.target_id });
      byType.set(p.edge_type, bucket);
    }
    for (const [edgeType, entries] of byType) {
      const sourceIds = Array.from(new Set(entries.map((e) => e.s)));
      const targetIds = Array.from(new Set(entries.map((e) => e.t)));
      const wanted = new Set(entries.map((e) => `${e.s}|${e.t}`));
      const conditions = [
        eq(edges.edge_type, edgeType),
        inArray(edges.source_id, sourceIds),
        inArray(edges.target_id, targetIds),
      ];
      if (spaceId !== undefined) conditions.push(eq(edges.space_id, spaceId));
      const rows = await this.db
        .select({
          source_id: edges.source_id,
          target_id: edges.target_id,
        })
        .from(edges)
        .where(and(...conditions));
      for (const row of rows) {
        const key = `${row.source_id}|${row.target_id}`;
        if (wanted.has(key)) {
          out.add(`${row.source_id}|${row.target_id}|${edgeType}`);
        }
      }
    }
    return out;
  }

  async findByTriplesBatch(
    pairs: {
      source_id: string;
      target_id: string;
      edge_type: string;
    }[],
    spaceId?: string,
  ): Promise<Map<string, Edge>> {
    const out = new Map<string, Edge>();
    if (pairs.length === 0) return out;
    const byType = new Map<string, { s: string; t: string }[]>();
    for (const p of pairs) {
      const bucket = byType.get(p.edge_type) ?? [];
      bucket.push({ s: p.source_id, t: p.target_id });
      byType.set(p.edge_type, bucket);
    }
    for (const [edgeType, entries] of byType) {
      const sourceIds = Array.from(new Set(entries.map((e) => e.s)));
      const targetIds = Array.from(new Set(entries.map((e) => e.t)));
      const wanted = new Set(entries.map((e) => `${e.s}|${e.t}`));
      const conditions = [
        eq(edges.edge_type, edgeType),
        inArray(edges.source_id, sourceIds),
        inArray(edges.target_id, targetIds),
      ];
      if (spaceId !== undefined) {
        conditions.push(eq(edges.space_id, spaceId));
      }
      const rows = await this.db
        .select()
        .from(edges)
        .where(and(...conditions));
      for (const row of rows) {
        const key = `${row.source_id}|${row.target_id}`;
        if (wanted.has(key)) {
          out.set(
            `${row.source_id}|${row.target_id}|${edgeType}`,
            rowToEdge(row),
          );
        }
      }
    }
    return out;
  }

  async listOutboundOfType(
    sourceId: string,
    edgeType: string,
    spaceId?: string,
  ): Promise<Edge[]> {
    const conditions = [
      eq(edges.source_id, sourceId),
      eq(edges.edge_type, edgeType),
    ];
    if (spaceId !== undefined) conditions.push(eq(edges.space_id, spaceId));
    const rows = await this.db
      .select()
      .from(edges)
      .where(and(...conditions));
    return rows.map(rowToEdge);
  }

  async listAllByItem(
    itemId: string,
    spaceId?: string,
  ): Promise<{ outbound: Edge[]; inbound: Edge[] }> {
    const touchesItem = or(
      eq(edges.source_id, itemId),
      eq(edges.target_id, itemId),
    );
    const where =
      spaceId !== undefined
        ? and(touchesItem, eq(edges.space_id, spaceId))
        : touchesItem;
    const rows = await this.db.select().from(edges).where(where);
    const outbound: Edge[] = [];
    const inbound: Edge[] = [];
    for (const r of rows) {
      if (r.source_id === itemId) outbound.push(rowToEdge(r));
      else inbound.push(rowToEdge(r));
    }
    return { outbound, inbound };
  }

  async listFromSourcesBatched(
    sourceIds: string[],
    perTypeLimit: number,
  ): Promise<Map<string, Edge[]>> {
    if (sourceIds.length === 0) return new Map();
    // Window function: rank edges per (source_id, edge_type) by created_at desc,
    // keep up to perTypeLimit per bucket.
    const rows = await this.db.execute<{
      id: string;
      space_id: string | null;
      source_id: string;
      target_id: string;
      edge_type: string;
      properties: string;
      created_at: string;
      updated_at: string;
      version: number;
    }>(
      sql`
        SELECT id, space_id, source_id, target_id, edge_type, properties,
               created_at, updated_at, version
        FROM (
          SELECT *,
                 ROW_NUMBER() OVER (
                   PARTITION BY source_id, edge_type
                   ORDER BY created_at DESC, id DESC
                 ) AS rn
          FROM edges
          WHERE source_id IN ${sourceIds}
        ) sub
        WHERE rn <= ${perTypeLimit}
      `,
    );
    const out = new Map<string, Edge[]>();
    for (const r of rows) {
      const list = out.get(r.source_id) ?? [];
      list.push(rowToEdge(r));
      out.set(r.source_id, list);
    }
    return out;
  }

  async listToTargetsBatched(
    targetIds: string[],
    perTypeLimit: number,
  ): Promise<Map<string, Edge[]>> {
    if (targetIds.length === 0) return new Map();
    // Mirror of listFromSourcesBatched: window per (target_id, edge_type),
    // keep up to perTypeLimit per bucket.
    const rows = await this.db.execute<{
      id: string;
      space_id: string | null;
      source_id: string;
      target_id: string;
      edge_type: string;
      properties: string;
      created_at: string;
      updated_at: string;
      version: number;
    }>(
      sql`
        SELECT id, space_id, source_id, target_id, edge_type, properties,
               created_at, updated_at, version
        FROM (
          SELECT *,
                 ROW_NUMBER() OVER (
                   PARTITION BY target_id, edge_type
                   ORDER BY created_at DESC, id DESC
                 ) AS rn
          FROM edges
          WHERE target_id IN ${targetIds}
        ) sub
        WHERE rn <= ${perTypeLimit}
      `,
    );
    const out = new Map<string, Edge[]>();
    for (const r of rows) {
      const list = out.get(r.target_id) ?? [];
      list.push(rowToEdge(r));
      out.set(r.target_id, list);
    }
    return out;
  }
}
