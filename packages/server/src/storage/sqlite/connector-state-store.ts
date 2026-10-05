import { and, asc, eq, gt, inArray, or, sql } from "drizzle-orm";
import type { PaginatedResult } from "@withmarfa/shared";
import type {
  ConnectorAgreement,
  ConnectorHeld,
  ConnectorStateStore,
} from "../interface.js";
import {
  CONNECTOR_AGREEMENTS_CURSOR_KEY,
  decodeKeyedCursor,
  encodeKeyedCursor,
} from "../interface.js";
import {
  connectorAgreements,
  connectorHolds,
  connectorStates,
  items,
} from "./schema.js";
import type { DrizzleDb } from "./connection.js";
import type { SqliteTxContext } from "./request-context.js";

type AgreementRow = typeof connectorAgreements.$inferSelect;

function toAgreement(row: AgreementRow): ConnectorAgreement {
  return {
    item_id: row.item_id,
    waiting: row.waiting,
    record: JSON.parse(row.record) as Record<string, unknown>,
    updated_at: row.updated_at,
  };
}

/** Read inside the write's own transaction, so no hold changes between. */
async function unheld(
  tx: SqliteTxContext,
  fence: { connectorId: string; process: string },
  now: string,
): Promise<ConnectorHeld | null> {
  const hold = await tx
    .select()
    .from(connectorHolds)
    .where(eq(connectorHolds.connector_id, fence.connectorId))
    .get();
  const live = hold !== undefined && hold.expires_at > now;
  if (live && hold.process === fence.process) return null;
  return { expires_at: live ? hold.expires_at : null };
}

export class SqliteConnectorStateStore implements ConnectorStateStore {
  constructor(private db: DrizzleDb) {}

  async getState(
    source: string,
  ): Promise<{ state: Record<string, unknown>; updated_at: string | null }> {
    const row = await this.db
      .select()
      .from(connectorStates)
      .where(eq(connectorStates.source, source))
      .get();
    return row === undefined
      ? { state: {}, updated_at: null }
      : {
          state: JSON.parse(row.state) as Record<string, unknown>,
          updated_at: row.updated_at,
        };
  }

  async putState(
    fence: { connectorId: string; process: string },
    source: string,
    state: Record<string, unknown>,
  ): Promise<
    { state: Record<string, unknown>; updated_at: string } | ConnectorHeld
  > {
    return this.db.transaction(async (tx) => {
      const now = new Date().toISOString();
      const refused = await unheld(tx, fence, now);
      if (refused !== null) return refused;
      const serialized = JSON.stringify(state);
      await tx
        .insert(connectorStates)
        .values({ source, state: serialized, updated_at: now })
        .onConflictDoUpdate({
          target: connectorStates.source,
          set: { state: serialized, updated_at: now },
        })
        .run();
      return { state, updated_at: now };
    });
  }

  async writeAgreements(
    fence: { connectorId: string; process: string },
    source: string,
    batch: {
      set: {
        item_id: string;
        waiting: boolean;
        record: Record<string, unknown>;
      }[];
      clear: string[];
    },
    readable: (type: string) => boolean,
  ): Promise<
    { written: number; cleared: number; skipped: string[] } | ConnectorHeld
  > {
    const named = [...batch.set.map((entry) => entry.item_id), ...batch.clear];
    return this.db.transaction(async (tx) => {
      const now = new Date().toISOString();
      const refused = await unheld(tx, fence, now);
      if (refused !== null) return refused;

      // Every state: a trashed row is a stored row.
      const types = new Map<string, string>();
      if (named.length > 0) {
        const rows = await tx
          .select({ id: items.id, type: items.type })
          .from(items)
          .where(inArray(items.id, named))
          .all();
        for (const row of rows) types.set(row.id, row.type);
      }
      const holds = (id: string): boolean => {
        const type = types.get(id);
        return type !== undefined && readable(type);
      };

      const set = batch.set.filter((entry) => holds(entry.item_id));
      if (set.length > 0) {
        await tx
          .insert(connectorAgreements)
          .values(
            set.map((entry) => ({
              source,
              item_id: entry.item_id,
              waiting: entry.waiting,
              record: JSON.stringify(entry.record),
              updated_at: now,
            })),
          )
          .onConflictDoUpdate({
            target: [connectorAgreements.source, connectorAgreements.item_id],
            set: {
              waiting: sql`excluded.waiting`,
              record: sql`excluded.record`,
              updated_at: sql`excluded.updated_at`,
            },
          })
          .run();
      }
      const clear = batch.clear.filter(holds);
      const cleared =
        clear.length === 0
          ? 0
          : (
              await tx
                .delete(connectorAgreements)
                .where(
                  and(
                    eq(connectorAgreements.source, source),
                    inArray(connectorAgreements.item_id, clear),
                  ),
                )
                .run()
            ).rowsAffected;
      return {
        written: set.length,
        cleared,
        skipped: named.filter((id) => !holds(id)),
      };
    });
  }

  async lookupAgreements(
    source: string,
    itemIds: string[],
    readable: (type: string) => boolean,
  ): Promise<ConnectorAgreement[]> {
    const unique = [...new Set(itemIds)];
    const rows = await this.db
      .select({ agreement: connectorAgreements, type: items.type })
      .from(connectorAgreements)
      .innerJoin(items, eq(items.id, connectorAgreements.item_id))
      .where(
        and(
          eq(connectorAgreements.source, source),
          inArray(connectorAgreements.item_id, unique),
        ),
      )
      .all();
    const byId = new Map(
      rows
        .filter((row) => readable(row.type))
        .map((row) => [row.agreement.item_id, row.agreement]),
    );
    return unique.flatMap((id) => {
      const row = byId.get(id);
      return row === undefined ? [] : [toAgreement(row)];
    });
  }

  async listAgreements(
    source: string,
    filter: { waiting?: boolean },
    page: { limit: number; cursor?: string },
    readable: (type: string) => boolean,
  ): Promise<PaginatedResult<ConnectorAgreement>> {
    const after =
      page.cursor === undefined
        ? undefined
        : decodeKeyedCursor(page.cursor, CONNECTOR_AGREEMENTS_CURSOR_KEY);
    const rows = await this.db
      .select({ agreement: connectorAgreements, type: items.type })
      .from(connectorAgreements)
      .innerJoin(items, eq(items.id, connectorAgreements.item_id))
      .where(
        and(
          eq(connectorAgreements.source, source),
          filter.waiting === undefined
            ? undefined
            : eq(connectorAgreements.waiting, filter.waiting),
          after === undefined
            ? undefined
            : or(
                gt(connectorAgreements.updated_at, after.v),
                and(
                  eq(connectorAgreements.updated_at, after.v),
                  gt(connectorAgreements.item_id, after.id),
                ),
              ),
        ),
      )
      .orderBy(
        asc(connectorAgreements.updated_at),
        asc(connectorAgreements.item_id),
      )
      .limit(page.limit + 1)
      .all();
    const slice = rows.slice(0, page.limit);
    const last = slice.at(-1)?.agreement;
    return {
      // Dropped after the page is cut, so the cursor still reaches every
      // row past it.
      data: slice
        .filter((row) => readable(row.type))
        .map((row) => toAgreement(row.agreement)),
      next_cursor:
        rows.length > page.limit && last
          ? encodeKeyedCursor(
              last.updated_at,
              last.item_id,
              CONNECTOR_AGREEMENTS_CURSOR_KEY,
            )
          : null,
    };
  }

  async clear(source: string): Promise<{ state: boolean; agreements: number }> {
    return this.db.transaction(async (tx) => {
      const state = await tx
        .delete(connectorStates)
        .where(eq(connectorStates.source, source))
        .run();
      const agreements = await tx
        .delete(connectorAgreements)
        .where(eq(connectorAgreements.source, source))
        .run();
      return {
        state: state.rowsAffected > 0,
        agreements: agreements.rowsAffected,
      };
    });
  }
}
