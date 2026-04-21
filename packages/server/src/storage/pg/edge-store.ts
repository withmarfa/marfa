import { eq, and, or, desc, inArray, lt, sql, count } from "drizzle-orm";
import { generateId } from "@mymehq/shared";
import type { Edge, CreateEdgeInput, PaginatedResult } from "@mymehq/shared";
import type { EdgeStore, EdgeListFilters } from "../interface.js";
import { encodeCursor, decodeCursor } from "../interface.js";
import { rowToEdge } from "../edge-constraints.js";
import { edges } from "./schema.js";
import type { PgDb } from "./connection.js";

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

  async createRaw(input: CreateEdgeInput, tenantId?: string): Promise<Edge> {
    const now = new Date().toISOString();
    const id = input.id ?? generateId();
    const properties = input.properties ?? {};
    const row = {
      id,
      tenant_id: tenantId ?? null,
      source_id: input.source_id,
      target_id: input.target_id,
      edge_type: input.edge_type,
      properties: JSON.stringify(properties),
      created_at: now,
      updated_at: now,
    };
    await this.db.insert(edges).values(row);
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
    filters?: EdgeListFilters & { tenantId?: string },
  ): Promise<PaginatedResult<Edge>> {
    const limit = clampLimit(filters?.limit);
    const conditions = [];
    if (filters?.tenantId) {
      conditions.push(eq(edges.tenant_id, filters.tenantId));
    }
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
      .where(conditions.length ? and(...conditions) : undefined)
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

  async updateProperties(
    id: string,
    properties: Record<string, unknown>,
  ): Promise<Edge> {
    const now = new Date().toISOString();
    const [row] = await this.db
      .update(edges)
      .set({ properties: JSON.stringify(properties), updated_at: now })
      .where(eq(edges.id, id))
      .returning();
    if (!row) throw new Error(`edge ${id} not found`);
    return rowToEdge(row);
  }

  async delete(id: string): Promise<void> {
    await this.db.delete(edges).where(eq(edges.id, id));
  }

  async deleteBySource(sourceId: string, edgeType?: string): Promise<void> {
    const where = edgeType
      ? and(eq(edges.source_id, sourceId), eq(edges.edge_type, edgeType))
      : eq(edges.source_id, sourceId);
    await this.db.delete(edges).where(where);
  }

  async deleteByTarget(targetId: string, edgeType?: string): Promise<void> {
    const where = edgeType
      ? and(eq(edges.target_id, targetId), eq(edges.edge_type, edgeType))
      : eq(edges.target_id, targetId);
    await this.db.delete(edges).where(where);
  }

  async countBySource(sourceId: string, edgeType: string): Promise<number> {
    const [row] = await this.db
      .select({ c: count() })
      .from(edges)
      .where(and(eq(edges.source_id, sourceId), eq(edges.edge_type, edgeType)));
    return row?.c ?? 0;
  }

  async countByTarget(targetId: string, edgeType: string): Promise<number> {
    const [row] = await this.db
      .select({ c: count() })
      .from(edges)
      .where(and(eq(edges.target_id, targetId), eq(edges.edge_type, edgeType)));
    return row?.c ?? 0;
  }

  async existsExact(
    sourceId: string,
    targetId: string,
    edgeType: string,
  ): Promise<boolean> {
    const [row] = await this.db
      .select({ id: edges.id })
      .from(edges)
      .where(
        and(
          eq(edges.source_id, sourceId),
          eq(edges.target_id, targetId),
          eq(edges.edge_type, edgeType),
        ),
      )
      .limit(1);
    return !!row;
  }

  async countsBySourceBatch(
    pairs: { source_id: string; edge_type: string }[],
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
      const rows = await this.db
        .select({
          source_id: edges.source_id,
          c: count(),
        })
        .from(edges)
        .where(
          and(eq(edges.edge_type, edgeType), inArray(edges.source_id, ids)),
        )
        .groupBy(edges.source_id);
      for (const row of rows) {
        out.set(`${row.source_id}|${edgeType}`, row.c);
      }
    }
    return out;
  }

  async countsByTargetBatch(
    pairs: { target_id: string; edge_type: string }[],
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
      const rows = await this.db
        .select({
          target_id: edges.target_id,
          c: count(),
        })
        .from(edges)
        .where(
          and(eq(edges.edge_type, edgeType), inArray(edges.target_id, ids)),
        )
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
      const rows = await this.db
        .select({
          source_id: edges.source_id,
          target_id: edges.target_id,
        })
        .from(edges)
        .where(
          and(
            eq(edges.edge_type, edgeType),
            inArray(edges.source_id, sourceIds),
            inArray(edges.target_id, targetIds),
          ),
        );
      for (const row of rows) {
        const key = `${row.source_id}|${row.target_id}`;
        if (wanted.has(key)) {
          out.add(`${row.source_id}|${row.target_id}|${edgeType}`);
        }
      }
    }
    return out;
  }

  async listOutboundOfType(
    sourceId: string,
    edgeType: string,
  ): Promise<Edge[]> {
    const rows = await this.db
      .select()
      .from(edges)
      .where(and(eq(edges.source_id, sourceId), eq(edges.edge_type, edgeType)));
    return rows.map(rowToEdge);
  }

  async listAllByItem(
    itemId: string,
  ): Promise<{ outbound: Edge[]; inbound: Edge[] }> {
    const rows = await this.db
      .select()
      .from(edges)
      .where(or(eq(edges.source_id, itemId), eq(edges.target_id, itemId)));
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
      tenant_id: string | null;
      source_id: string;
      target_id: string;
      edge_type: string;
      properties: string;
      created_at: string;
      updated_at: string;
    }>(
      sql`
        SELECT id, tenant_id, source_id, target_id, edge_type, properties,
               created_at, updated_at
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
}
