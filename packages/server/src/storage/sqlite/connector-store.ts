import { and, desc, eq, lt, or, sql } from "drizzle-orm";
import { generateId } from "@withmarfa/shared";
import type { PaginatedResult } from "@withmarfa/shared";
import type {
  Connector,
  ConnectorRun,
  ConnectorRunInput,
  ConnectorStore,
} from "../interface.js";
import {
  CONNECTOR_RUNS_CURSOR_KEY,
  decodeKeyedCursor,
  encodeKeyedCursor,
} from "../interface.js";
import { connectorRuns, connectors } from "./schema.js";
import type { DrizzleDb } from "./connection.js";

/** Runs kept per connector: a bound on the table, not a retention. */
export const RUNS_KEPT_PER_CONNECTOR = 100;

type ConnectorRow = typeof connectors.$inferSelect;
type RunRow = typeof connectorRuns.$inferSelect;

function toRun(row: RunRow): ConnectorRun {
  return {
    id: row.id,
    connector_id: row.connector_id,
    outcome: row.outcome as ConnectorRun["outcome"],
    started_at: row.started_at,
    finished_at: row.finished_at,
    summary: row.summary,
    error: row.error,
    reported_at: row.reported_at,
  };
}

export class SqliteConnectorStore implements ConnectorStore {
  constructor(private db: DrizzleDb) {}

  private async withLastRun(row: ConnectorRow): Promise<Connector> {
    const last = await this.db
      .select()
      .from(connectorRuns)
      .where(eq(connectorRuns.connector_id, row.id))
      .orderBy(desc(connectorRuns.reported_at), desc(connectorRuns.id))
      .limit(1)
      .get();
    return {
      id: row.id,
      key_id: row.key_id,
      source: row.source,
      name: row.name,
      description: row.description,
      registered_at: row.registered_at,
      updated_at: row.updated_at,
      last_heartbeat_at: row.last_heartbeat_at,
      last_run: last ? toRun(last) : null,
    };
  }

  async register(
    key: { id: string; source: string },
    name: string,
    description: string | null,
  ): Promise<{ connector: Connector; created: boolean }> {
    const now = new Date().toISOString();
    // One statement decides who registers first: two first registrations by
    // one key race on the UNIQUE, and the loser takes the update path below
    // rather than surfacing the constraint as an error nothing names.
    const inserted = await this.db
      .insert(connectors)
      .values({
        id: generateId(),
        key_id: key.id,
        source: key.source,
        name,
        description,
        registered_at: now,
        updated_at: now,
        last_heartbeat_at: null,
      })
      .onConflictDoNothing({ target: connectors.key_id })
      .returning()
      .all();
    if (inserted[0]) {
      return { connector: await this.withLastRun(inserted[0]), created: true };
    }
    const updated = await this.db
      .update(connectors)
      .set({ name, description, updated_at: now })
      .where(eq(connectors.key_id, key.id))
      .returning()
      .all();
    // The row went between the two statements, a removal landing in the
    // gap: this call registers afresh.
    if (!updated[0]) return this.register(key, name, description);
    return { connector: await this.withLastRun(updated[0]), created: false };
  }

  async list(): Promise<Connector[]> {
    const rows = await this.db
      .select()
      .from(connectors)
      .orderBy(desc(connectors.registered_at), desc(connectors.id))
      .all();
    const out: Connector[] = [];
    for (const row of rows) out.push(await this.withLastRun(row));
    return out;
  }

  async get(id: string): Promise<Connector | null> {
    const row = await this.db
      .select()
      .from(connectors)
      .where(eq(connectors.id, id))
      .get();
    return row ? this.withLastRun(row) : null;
  }

  async remove(id: string): Promise<boolean> {
    const rows = await this.db
      .delete(connectors)
      .where(eq(connectors.id, id))
      .returning({ id: connectors.id })
      .all();
    return rows.length > 0;
  }

  async heartbeat(id: string): Promise<string | null> {
    const now = new Date().toISOString();
    const rows = await this.db
      .update(connectors)
      .set({ last_heartbeat_at: now })
      .where(eq(connectors.id, id))
      .returning({ at: connectors.last_heartbeat_at })
      .all();
    return rows[0]?.at ?? null;
  }

  async recordRun(id: string, input: ConnectorRunInput): Promise<ConnectorRun> {
    const row: RunRow = {
      id: generateId(),
      connector_id: id,
      outcome: input.outcome,
      started_at: input.started_at,
      finished_at: input.finished_at,
      summary: input.summary ?? null,
      error: input.error ?? null,
      reported_at: new Date().toISOString(),
    };
    await this.db.insert(connectorRuns).values(row).run();
    // Trimmed on every insert: the bound is a property of the table, and
    // a sweep that ran later would let the excess stand until it did.
    const keep = this.db
      .select({ id: connectorRuns.id })
      .from(connectorRuns)
      .where(eq(connectorRuns.connector_id, id))
      .orderBy(desc(connectorRuns.reported_at), desc(connectorRuns.id))
      .limit(RUNS_KEPT_PER_CONNECTOR);
    await this.db
      .delete(connectorRuns)
      .where(
        and(
          eq(connectorRuns.connector_id, id),
          sql`${connectorRuns.id} NOT IN (${keep})`,
        ),
      )
      .run();
    return toRun(row);
  }

  async listRuns(
    id: string,
    page: { limit: number; cursor?: string },
  ): Promise<PaginatedResult<ConnectorRun>> {
    const after =
      page.cursor === undefined
        ? undefined
        : decodeKeyedCursor(page.cursor, CONNECTOR_RUNS_CURSOR_KEY);
    const rows = await this.db
      .select()
      .from(connectorRuns)
      .where(
        and(
          eq(connectorRuns.connector_id, id),
          after === undefined
            ? undefined
            : or(
                lt(connectorRuns.reported_at, after.v),
                and(
                  eq(connectorRuns.reported_at, after.v),
                  lt(connectorRuns.id, after.id),
                ),
              ),
        ),
      )
      .orderBy(desc(connectorRuns.reported_at), desc(connectorRuns.id))
      .limit(page.limit + 1)
      .all();
    const slice = rows.slice(0, page.limit);
    const last = slice.at(-1);
    return {
      data: slice.map(toRun),
      next_cursor:
        rows.length > page.limit && last
          ? encodeKeyedCursor(
              last.reported_at,
              last.id,
              CONNECTOR_RUNS_CURSOR_KEY,
            )
          : null,
    };
  }
}
