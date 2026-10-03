import { createHash } from "node:crypto";
import { and, asc, desc, eq, gt, inArray, isNull, or, sql } from "drizzle-orm";
import { generateId } from "@withmarfa/shared";
import type { PaginatedResult } from "@withmarfa/shared";
import type {
  InboundDelivery,
  InboundEndpoint,
  InboundOutcome,
  InboundStore,
  InboundTarget,
} from "../interface.js";
import {
  INBOUND_DELIVERIES_CURSOR_KEY,
  decodeKeyedCursor,
  encodeKeyedCursor,
} from "../interface.js";
import {
  apiKeys,
  connectors,
  inboundDeliveries,
  inboundDeliveryBodies,
  inboundEndpoints,
} from "./schema.js";
import type { DrizzleDb } from "./connection.js";

type EndpointRow = typeof inboundEndpoints.$inferSelect;
type DeliveryRow = typeof inboundDeliveries.$inferSelect;

const DAY_MS = 24 * 60 * 60 * 1000;

function toEndpoint(row: EndpointRow): InboundEndpoint {
  return {
    id: row.id,
    connector_id: row.connector_id,
    label: row.label,
    duplicate_header: row.duplicate_header,
    token_last4: row.token_last4,
    created_at: row.created_at,
    retired_at: row.retired_at,
  };
}

export class SqliteInboundStore implements InboundStore {
  constructor(private db: DrizzleDb) {}

  async createEndpoint(
    input: {
      connectorId: string;
      tokenHash: string;
      tokenLast4: string;
      label: string | null;
      duplicateHeader: string | null;
    },
    maxLive: number,
  ): Promise<InboundEndpoint | "limit"> {
    const id = generateId();
    const createdAt = new Date().toISOString();
    // One statement, so two creates at once cannot both slip under the cap.
    const inserted = await this.db.all<EndpointRow>(sql`
      INSERT INTO inbound_endpoints
        (id, connector_id, token_hash, token_last4, label, duplicate_header, created_at, retired_at)
      SELECT ${id}, ${input.connectorId}, ${input.tokenHash}, ${input.tokenLast4},
             ${input.label}, ${input.duplicateHeader}, ${createdAt}, NULL
      WHERE (
        SELECT COUNT(*) FROM inbound_endpoints
        WHERE connector_id = ${input.connectorId} AND retired_at IS NULL
      ) < ${maxLive}
      RETURNING *
    `);
    const row = inserted[0];
    return row === undefined ? "limit" : toEndpoint(row);
  }

  async listEndpoints(connectorId: string): Promise<InboundEndpoint[]> {
    const rows = await this.db
      .select()
      .from(inboundEndpoints)
      .where(eq(inboundEndpoints.connector_id, connectorId))
      .orderBy(desc(inboundEndpoints.created_at), desc(inboundEndpoints.id))
      .all();
    return rows.map(toEndpoint);
  }

  async retireEndpoint(
    connectorId: string,
    endpointId: string,
  ): Promise<{ endpoint: InboundEndpoint; retired: boolean } | null> {
    const mine = and(
      eq(inboundEndpoints.id, endpointId),
      eq(inboundEndpoints.connector_id, connectorId),
    );
    const result = await this.db
      .update(inboundEndpoints)
      .set({ retired_at: new Date().toISOString() })
      .where(and(mine, isNull(inboundEndpoints.retired_at)))
      .run();
    const row = await this.db.select().from(inboundEndpoints).where(mine).get();
    return row === undefined
      ? null
      : { endpoint: toEndpoint(row), retired: result.rowsAffected > 0 };
  }

  async target(tokenHash: string): Promise<InboundTarget | null> {
    return this.liveTarget(this.db, tokenHash, new Date().toISOString());
  }

  private async liveTarget(
    db: Pick<DrizzleDb, "select">,
    tokenHash: string,
    now: string,
  ): Promise<InboundTarget | null> {
    const row = await db
      .select({
        endpoint_id: inboundEndpoints.id,
        connector_id: inboundEndpoints.connector_id,
        duplicate_header: inboundEndpoints.duplicate_header,
      })
      .from(inboundEndpoints)
      .innerJoin(connectors, eq(connectors.id, inboundEndpoints.connector_id))
      .innerJoin(apiKeys, eq(apiKeys.id, connectors.key_id))
      .where(
        and(
          eq(inboundEndpoints.token_hash, tokenHash),
          isNull(inboundEndpoints.retired_at),
          isNull(apiKeys.revoked_at),
          or(isNull(apiKeys.expires_at), gt(apiKeys.expires_at, now)),
        ),
      )
      .get();
    return row ?? null;
  }

  async backlog(
    connectorId: string,
  ): Promise<{ count: number; bytes: number }> {
    const row = await this.db
      .select({
        count: sql<number>`COUNT(*)`,
        bytes: sql<number>`COALESCE(SUM(${inboundDeliveries.size}), 0)`,
      })
      .from(inboundDeliveries)
      .where(
        and(
          eq(inboundDeliveries.connector_id, connectorId),
          isNull(inboundDeliveries.handled_at),
        ),
      )
      .get();
    return { count: row?.count ?? 0, bytes: row?.bytes ?? 0 };
  }

  async receive(
    input: Parameters<InboundStore["receive"]>[0],
    limits: Parameters<InboundStore["receive"]>[1],
  ): ReturnType<InboundStore["receive"]> {
    const id = generateId();
    const sha256 = createHash("sha256").update(input.body).digest("hex");
    return this.db.transaction(async (tx) => {
      const now = new Date().toISOString();
      const target = await this.liveTarget(tx, input.tokenHash, now);
      if (target === null) return { kind: "not_found" };
      const dedupeKey =
        target.duplicate_header === null
          ? null
          : (input.headers.find(
              ([name]) => name.toLowerCase() === target.duplicate_header,
            )?.[1] ?? null);
      const metadata = {
        id,
        endpoint_id: target.endpoint_id,
        connector_id: target.connector_id,
        received_at: now,
        method: input.method,
        query: input.query,
        headers: input.headers,
        size: input.body.length,
        sha256,
        dedupe_key: dedupeKey,
        handled_at: null,
        outcome: null,
      };
      // Reserve handled_at/outcome growth so handling cannot need capacity.
      const storedBytes =
        input.body.length +
        Buffer.byteLength(JSON.stringify(metadata), "utf8") +
        32;
      if (!Number.isSafeInteger(storedBytes))
        throw new Error("Inbound charge exceeds safe integer range");
      const capacity = await tx.all<{ fits: number }>(sql`
        SELECT
          retained_count < ${limits.retainedDeliveries}
          AND retained_bytes <= ${limits.retainedBytes - storedBytes}
          AND pending_count < ${limits.backlogDeliveries}
          AND pending_bytes <= ${limits.backlogBytes - input.body.length} AS fits
        FROM (
          SELECT COUNT(*) AS retained_count,
            COALESCE(SUM(stored_bytes), 0) AS retained_bytes,
            COUNT(CASE WHEN handled_at IS NULL THEN 1 END) AS pending_count,
            COALESCE(SUM(CASE WHEN handled_at IS NULL THEN size ELSE 0 END), 0) AS pending_bytes
          FROM inbound_deliveries WHERE connector_id = ${target.connector_id}
        )
      `);
      if (capacity[0]?.fits !== 1) return { kind: "capacity" };
      await tx
        .insert(inboundDeliveries)
        .values({
          ...metadata,
          headers: JSON.stringify(input.headers),
          stored_bytes: storedBytes,
        })
        .run();
      await tx
        .insert(inboundDeliveryBodies)
        .values({ delivery_id: id, body: input.body })
        .run();
      return { kind: "accepted", id };
    });
  }

  async listDeliveries(
    connectorId: string,
    filter: { state: "pending" | "handled" | "any"; endpointId?: string },
    page: { limit: number; cursor?: string },
  ): Promise<PaginatedResult<InboundDelivery>> {
    const after =
      page.cursor === undefined
        ? undefined
        : decodeKeyedCursor(page.cursor, INBOUND_DELIVERIES_CURSOR_KEY);
    const rows = await this.db
      .select()
      .from(inboundDeliveries)
      .where(
        and(
          eq(inboundDeliveries.connector_id, connectorId),
          filter.state === "pending"
            ? isNull(inboundDeliveries.handled_at)
            : filter.state === "handled"
              ? sql`${inboundDeliveries.handled_at} IS NOT NULL`
              : undefined,
          filter.endpointId === undefined
            ? undefined
            : eq(inboundDeliveries.endpoint_id, filter.endpointId),
          after === undefined
            ? undefined
            : or(
                gt(inboundDeliveries.received_at, after.v),
                and(
                  eq(inboundDeliveries.received_at, after.v),
                  gt(inboundDeliveries.id, after.id),
                ),
              ),
        ),
      )
      .orderBy(asc(inboundDeliveries.received_at), asc(inboundDeliveries.id))
      .limit(page.limit + 1)
      .all();
    const slice = rows.slice(0, page.limit);
    const last = slice.at(-1);
    return {
      data: await this.withDuplicates(slice),
      next_cursor:
        rows.length > page.limit && last
          ? encodeKeyedCursor(
              last.received_at,
              last.id,
              INBOUND_DELIVERIES_CURSOR_KEY,
            )
          : null,
    };
  }

  async body(connectorId: string, deliveryId: string): Promise<Buffer | null> {
    const row = await this.db
      .select({ body: inboundDeliveryBodies.body })
      .from(inboundDeliveryBodies)
      .innerJoin(
        inboundDeliveries,
        eq(inboundDeliveries.id, inboundDeliveryBodies.delivery_id),
      )
      .where(
        and(
          eq(inboundDeliveries.id, deliveryId),
          eq(inboundDeliveries.connector_id, connectorId),
        ),
      )
      .get();
    return row === undefined ? null : Buffer.from(row.body);
  }

  async markHandled(
    connectorId: string,
    ids: string[],
    outcome: InboundOutcome,
  ): Promise<InboundDelivery[] | null> {
    const unique = [...new Set(ids)];
    const mine = and(
      eq(inboundDeliveries.connector_id, connectorId),
      inArray(inboundDeliveries.id, unique),
    );
    const marked = await this.db.transaction(async (tx) => {
      const found = await tx
        .select({ id: inboundDeliveries.id })
        .from(inboundDeliveries)
        .where(mine)
        .all();
      if (found.length !== unique.length) return false;
      await tx
        .update(inboundDeliveries)
        .set({ handled_at: new Date().toISOString(), outcome })
        .where(and(mine, isNull(inboundDeliveries.handled_at)))
        .run();
      return true;
    });
    if (!marked) return null;
    const rows = await this.db
      .select()
      .from(inboundDeliveries)
      .where(mine)
      .all();
    const byId = new Map(rows.map((row) => [row.id, row]));
    return this.withDuplicates(
      unique.flatMap((id) => {
        const row = byId.get(id);
        return row === undefined ? [] : [row];
      }),
    );
  }

  async cleanup(retention: {
    handledDays: number;
    pendingDays: number;
  }): Promise<{ deleted: number; remaining: boolean }> {
    const now = Date.now();
    const cutoff = (days: number): string =>
      new Date(now - days * DAY_MS).toISOString();
    const handledCutoff =
      retention.handledDays > 0 ? cutoff(retention.handledDays) : null;
    const pendingCutoff =
      retention.pendingDays > 0 ? cutoff(retention.pendingDays) : null;
    if (handledCutoff === null && pendingCutoff === null)
      return { deleted: 0, remaining: false };
    return this.db.transaction(async (tx) => {
      const candidates = await tx.all<{ id: string; stored_bytes: number }>(sql`
        SELECT id, stored_bytes FROM (
          SELECT * FROM (
            SELECT id, stored_bytes, handled_at AS stamp FROM inbound_deliveries
            WHERE handled_at IS NOT NULL AND handled_at < ${handledCutoff}
            ORDER BY handled_at, id LIMIT 500
          )
          UNION ALL
          SELECT * FROM (
            SELECT id, stored_bytes, received_at AS stamp FROM inbound_deliveries
            WHERE handled_at IS NULL AND received_at < ${pendingCutoff}
            ORDER BY received_at, id LIMIT 500
          )
        ) ORDER BY stamp, id LIMIT 500
      `);
      const ids: string[] = [];
      let chargedBytes = 0;
      for (const row of candidates) {
        if (
          ids.length > 0 &&
          row.stored_bytes > 32 * 1024 * 1024 - chargedBytes
        )
          break;
        ids.push(row.id);
        chargedBytes += row.stored_bytes;
      }
      if (ids.length > 0) {
        await tx
          .delete(inboundDeliveries)
          .where(inArray(inboundDeliveries.id, ids))
          .run();
      }
      const remaining = await tx.all<{ present: number }>(sql`
        SELECT 1 AS present FROM (
          SELECT id FROM inbound_deliveries
          WHERE handled_at IS NOT NULL AND handled_at < ${handledCutoff}
          UNION ALL
          SELECT id FROM inbound_deliveries
          WHERE handled_at IS NULL AND received_at < ${pendingCutoff}
        ) LIMIT 1
      `);
      return { deleted: ids.length, remaining: remaining.length > 0 };
    });
  }

  private async withDuplicates(
    rows: DeliveryRow[],
  ): Promise<InboundDelivery[]> {
    const pairs = new Map<string, Set<string>>();
    for (const row of rows) {
      if (row.dedupe_key === null) continue;
      let dedupeKeys = pairs.get(row.endpoint_id);
      if (dedupeKeys === undefined) {
        dedupeKeys = new Set();
        pairs.set(row.endpoint_id, dedupeKeys);
      }
      dedupeKeys.add(row.dedupe_key);
    }
    interface Original {
      id: string;
      outcome: string | null;
    }
    const firsts = new Map<string, Map<string, Original>>();
    if (pairs.size > 0) {
      const requested = [...pairs].flatMap(([endpoint, dedupeKeys]) =>
        [...dedupeKeys].map((key) => sql`(${endpoint}, ${key})`),
      );
      const originals = await this.db.all<
        Original & {
          endpoint_id: string;
          dedupe_key: string;
        }
      >(sql`
        WITH requested(endpoint_id, dedupe_key) AS (
          VALUES ${sql.join(requested, sql`, `)}
        )
        SELECT requested.endpoint_id, requested.dedupe_key, first.id, first.outcome
        FROM requested
        JOIN inbound_deliveries AS first ON first.id = (
          SELECT candidate.id
          FROM inbound_deliveries AS candidate
          WHERE candidate.endpoint_id = requested.endpoint_id
            AND candidate.dedupe_key = requested.dedupe_key
          ORDER BY candidate.received_at, candidate.id
          LIMIT 1
        )
      `);
      for (const original of originals) {
        let dedupeKeys = firsts.get(original.endpoint_id);
        if (dedupeKeys === undefined) {
          dedupeKeys = new Map();
          firsts.set(original.endpoint_id, dedupeKeys);
        }
        dedupeKeys.set(original.dedupe_key, original);
      }
    }
    return rows.map((row) => {
      const first =
        row.dedupe_key === null
          ? undefined
          : firsts.get(row.endpoint_id)?.get(row.dedupe_key);
      return {
        id: row.id,
        endpoint_id: row.endpoint_id,
        received_at: row.received_at,
        method: row.method,
        query: row.query,
        headers: JSON.parse(row.headers) as [string, string][],
        size: row.size,
        sha256: row.sha256,
        duplicate_of:
          first === undefined || first.id === row.id
            ? null
            : {
                id: first.id,
                outcome: first.outcome as InboundOutcome | null,
              },
        handled_at: row.handled_at,
        outcome: row.outcome as InboundOutcome | null,
      };
    });
  }
}
