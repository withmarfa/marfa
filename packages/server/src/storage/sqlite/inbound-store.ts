import { createHash } from "node:crypto";
import {
  and,
  asc,
  desc,
  eq,
  gt,
  inArray,
  isNull,
  lt,
  or,
  sql,
} from "drizzle-orm";
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
    const row = await this.db
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
          or(
            isNull(apiKeys.expires_at),
            gt(apiKeys.expires_at, new Date().toISOString()),
          ),
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

  async receive(input: {
    endpointId: string;
    connectorId: string;
    method: string;
    query: string;
    headers: [string, string][];
    body: Buffer;
    dedupeKey: string | null;
  }): Promise<string> {
    const id = generateId();
    const sha256 = createHash("sha256").update(input.body).digest("hex");
    await this.db.transaction(async (tx) => {
      await tx
        .insert(inboundDeliveries)
        .values({
          id,
          endpoint_id: input.endpointId,
          connector_id: input.connectorId,
          received_at: new Date().toISOString(),
          method: input.method,
          query: input.query,
          headers: JSON.stringify(input.headers),
          size: input.body.length,
          sha256,
          dedupe_key: input.dedupeKey,
          handled_at: null,
          outcome: null,
        })
        .run();
      await tx
        .insert(inboundDeliveryBodies)
        .values({ delivery_id: id, body: input.body })
        .run();
    });
    return id;
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
  }): Promise<number> {
    const now = Date.now();
    const cutoff = (days: number): string =>
      new Date(now - days * DAY_MS).toISOString();
    // A retention of zero or less keeps that kind whatever its age, as every
    // other retention the instance names does.
    const expired = [
      retention.handledDays > 0
        ? lt(inboundDeliveries.handled_at, cutoff(retention.handledDays))
        : undefined,
      retention.pendingDays > 0
        ? and(
            isNull(inboundDeliveries.handled_at),
            lt(inboundDeliveries.received_at, cutoff(retention.pendingDays)),
          )
        : undefined,
    ].filter((condition) => condition !== undefined);
    if (expired.length === 0) return 0;
    const result = await this.db
      .delete(inboundDeliveries)
      .where(or(...expired))
      .run();
    return result.rowsAffected;
  }

  private async withDuplicates(
    rows: DeliveryRow[],
  ): Promise<InboundDelivery[]> {
    const keyed = rows.filter((row) => row.dedupe_key !== null);
    const firsts = new Map<string, { id: string; outcome: string | null }>();
    for (const row of keyed) {
      const first = await this.db.all<{
        id: string;
        outcome: string | null;
      }>(sql`
        SELECT id, outcome FROM inbound_deliveries
        WHERE endpoint_id = ${row.endpoint_id} AND dedupe_key = ${row.dedupe_key}
        ORDER BY received_at, id
        LIMIT 1
      `);
      const earliest = first[0];
      if (earliest !== undefined && earliest.id !== row.id) {
        firsts.set(row.id, earliest);
      }
    }
    return rows.map((row) => {
      const first = firsts.get(row.id);
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
          first === undefined
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
