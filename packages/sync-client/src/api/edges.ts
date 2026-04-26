/**
 * Edges API. Mirrors `@mymehq/sdk` edges namespace, with local-first
 * reshaping: reads come from PGlite, writes apply optimistically and
 * queue for drain.
 */

import { uuidv7 } from "uuidv7";
import type { CreateEdgeInput, Edge } from "@mymehq/shared";
import type { PGliteWithSync } from "../storage/pglite.js";
import type { MutationQueue } from "../queue/queue.js";
import type { DrainLoop } from "../queue/drain.js";
import type { SyncEventEmitter } from "../events/emitter.js";

export interface EdgesApiOptions {
  pg: PGliteWithSync;
  queue: MutationQueue;
  drain: DrainLoop;
  emitter: SyncEventEmitter;
}

export interface EdgeFilters {
  edgeType?: string | string[];
  limit?: number;
}

interface EdgeRow {
  id: string;
  source_id: string;
  target_id: string;
  edge_type: string;
  properties: string;
  created_at: string;
  updated_at: string;
  tenant_id: string | null;
}

function rowToEdge(row: EdgeRow): Edge {
  let properties: Record<string, unknown> = {};
  try {
    properties = JSON.parse(row.properties) as Record<string, unknown>;
  } catch {
    // defensive
  }
  return {
    id: row.id,
    source_id: row.source_id,
    target_id: row.target_id,
    edge_type: row.edge_type,
    properties,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

export class EdgesApi {
  constructor(private readonly options: EdgesApiOptions) {}

  async list(filters: EdgeFilters = {}): Promise<Edge[]> {
    return this.queryEdges("", [], filters);
  }

  async listFromSource(sourceId: string, filters: EdgeFilters = {}): Promise<Edge[]> {
    return this.queryEdges("source_id = $1", [sourceId], filters, 2);
  }

  async listToTarget(targetId: string, filters: EdgeFilters = {}): Promise<Edge[]> {
    return this.queryEdges("target_id = $1", [targetId], filters, 2);
  }

  async create(input: CreateEdgeInput): Promise<Edge> {
    const id = input.id ?? uuidv7();
    const now = new Date().toISOString();
    const edge: Edge = {
      id,
      source_id: input.source_id,
      target_id: input.target_id,
      edge_type: input.edge_type,
      properties: input.properties ?? {},
      created_at: now,
      updated_at: now,
    };
    await this.options.pg.query(
      `INSERT INTO edges
         (id, source_id, target_id, edge_type, properties, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (id) DO UPDATE SET
         properties = EXCLUDED.properties,
         updated_at = EXCLUDED.updated_at`,
      [
        edge.id,
        edge.source_id,
        edge.target_id,
        edge.edge_type,
        JSON.stringify(edge.properties),
        edge.created_at,
        edge.updated_at,
      ],
    );
    const writeId = await this.options.queue.enqueue(
      { kind: "createEdge", payload: { input: { ...input, id } } },
      { targetId: id },
    );
    this.options.emitter.emit("mutation.queued", {
      id: writeId,
      kind: "createEdge",
      enqueuedAt: new Date(),
    });
    this.options.drain.wake();
    return edge;
  }

  async update(id: string, properties: Record<string, unknown>): Promise<Edge> {
    const now = new Date().toISOString();
    await this.options.pg.query(
      `UPDATE edges SET properties = $2, updated_at = $3 WHERE id = $1`,
      [id, JSON.stringify(properties), now],
    );
    const writeId = await this.options.queue.enqueue(
      { kind: "updateEdge", payload: { id, properties } },
      { targetId: id },
    );
    this.options.emitter.emit("mutation.queued", {
      id: writeId,
      kind: "updateEdge",
      enqueuedAt: new Date(),
    });
    this.options.drain.wake();
    const fetched = await this.findById(id);
    if (!fetched) throw new Error(`update: edge ${id} disappeared`);
    return fetched;
  }

  async delete(id: string): Promise<void> {
    await this.options.pg.query(`DELETE FROM edges WHERE id = $1`, [id]);
    const writeId = await this.options.queue.enqueue(
      { kind: "deleteEdge", payload: { id } },
      { targetId: id },
    );
    this.options.emitter.emit("mutation.queued", {
      id: writeId,
      kind: "deleteEdge",
      enqueuedAt: new Date(),
    });
    this.options.drain.wake();
  }

  private async findById(id: string): Promise<Edge | null> {
    const r = await this.options.pg.query<EdgeRow>(
      `SELECT * FROM edges WHERE id = $1 LIMIT 1`,
      [id],
    );
    const row = r.rows[0];
    return row ? rowToEdge(row) : null;
  }

  private async queryEdges(
    extraWhere: string,
    extraParams: unknown[],
    filters: EdgeFilters,
    nextParamIdx = 1,
  ): Promise<Edge[]> {
    const conditions: string[] = [];
    const params: unknown[] = [...extraParams];
    if (extraWhere) conditions.push(extraWhere);
    const edgeTypes = Array.isArray(filters.edgeType)
      ? filters.edgeType
      : filters.edgeType
        ? [filters.edgeType]
        : [];
    if (edgeTypes.length > 0) {
      const placeholders = edgeTypes.map((t) => {
        params.push(t);
        return `$${String(params.length + (nextParamIdx - 1) - extraParams.length + extraParams.length)}`;
      });
      conditions.push(`edge_type IN (${placeholders.join(", ")})`);
    }
    const whereSql = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
    const limit = Math.max(1, Math.min(filters.limit ?? 100, 5_000));
    const r = await this.options.pg.query<EdgeRow>(
      `SELECT * FROM edges ${whereSql} ORDER BY updated_at DESC LIMIT ${String(limit)}`,
      params,
    );
    return r.rows.map(rowToEdge);
  }
}
