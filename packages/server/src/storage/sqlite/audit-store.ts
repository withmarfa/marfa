import { auditActor } from "../../auth/audit-actor.js";
import { inProcessCaller } from "../../middleware/in-process-caller.js";
import { archivedWriter } from "../../auth/version-writer.js";
import {
  eq,
  and,
  desc,
  gt,
  lt,
  or,
  sql,
  type SQL,
  type SQLWrapper,
} from "drizzle-orm";
import {
  DEFAULT_PAGE_LIMIT,
  MAX_PAGE_LIMIT,
  MIN_PAGE_LIMIT,
} from "../../page-limits.js";
import { generateId } from "@withmarfa/shared";
import type { PaginatedResult } from "@withmarfa/shared";
import type { AuditEntry, AuditLogEntry, AuditStore } from "../interface.js";
import {
  AUDIT_CURSOR_KEY,
  encodeKeyedCursor,
  decodeKeyedCursor,
  normalizeTimeBound,
} from "../interface.js";
import { safeJsonParse } from "../json-utils.js";
import {
  ACCESS_FAMILIES,
  HOUSEKEEPING_ACTIONS,
  SETTINGS_ACTIONS,
  SETTINGS_FAMILIES,
  auditSearchWords,
  type AuditKind,
} from "../audit-kinds.js";
import { auditLog } from "./schema.js";
import type { DrizzleDb } from "./connection.js";
import * as clock from "../../clock.js";

function rowToEntry(row: typeof auditLog.$inferSelect): AuditEntry {
  const details = safeJsonParse<Record<string, unknown>>(
    row.details,
    {},
    "audit_log.details",
  );
  const { _actor, ...visibleDetails } = details;
  const recorded = archivedWriter(_actor, "actor");
  const server =
    typeof _actor === "object" &&
    _actor !== null &&
    "kind" in _actor &&
    _actor.kind === "server" &&
    "id" in _actor &&
    _actor.id === "server" &&
    "name" in _actor &&
    _actor.name === "Marfa";
  return {
    actor: server
      ? { kind: "server", id: "server", name: "Marfa" }
      : "writer" in recorded
        ? recorded.writer
        : null,
    id: row.id,
    created_at: row.created_at,
    key_id: row.key_id ?? null,
    action: row.action,
    resource_type: row.resource_type,
    resource_id: row.resource_id ?? null,
    client_ip: row.client_ip ?? null,
    details: visibleDetails,
  };
}

/** The part of `action` before its first dot, or all of it when it has none. */
const family = sql`(CASE WHEN instr(${auditLog.action}, '.') > 0 THEN substr(${auditLog.action}, 1, instr(${auditLog.action}, '.') - 1) ELSE ${auditLog.action} END)`;

const inList = (values: readonly string[]): SQL =>
  sql.join(
    values.map((value) => sql`${value}`),
    sql`, `,
  );

function kindClause(kind: AuditKind): SQL {
  const housekeeping = sql`${auditLog.action} IN (${inList(HOUSEKEEPING_ACTIONS)})`;
  const settings = sql`(${auditLog.action} IN (${inList(SETTINGS_ACTIONS)}) OR ${family} IN (${inList(SETTINGS_FAMILIES)}))`;
  const access = sql`${family} IN (${inList(ACCESS_FAMILIES)})`;
  switch (kind) {
    case "housekeeping":
      return housekeeping;
    case "settings":
      return sql`(NOT ${housekeeping} AND ${settings})`;
    case "access":
      return sql`(NOT ${housekeeping} AND NOT ${settings} AND ${access})`;
    case "data":
      return sql`(NOT ${housekeeping} AND NOT ${settings} AND NOT ${access})`;
  }
}

/** Every word is somewhere in the entry's text, in any order, ignoring ASCII case. */
function searchClause(q: string): SQL | undefined {
  const words = auditSearchWords(q);
  if (words.length === 0) return undefined;
  return and(
    ...words.map((word) => {
      const holds = (column: SQLWrapper): SQL =>
        sql`instr(lower(coalesce(${column}, '')), ${word}) > 0`;
      return or(
        holds(auditLog.action),
        holds(auditLog.resource_type),
        holds(auditLog.resource_id),
        holds(auditLog.key_id),
        holds(auditLog.client_ip),
        holds(auditLog.details),
      );
    }),
  );
}

export class SqliteAuditStore implements AuditStore {
  constructor(private db: DrizzleDb) {}

  private buildRow(
    entry: AuditLogEntry,
    id = generateId(),
  ): typeof auditLog.$inferInsert {
    // A row the server writes for itself, from work a request set off, is
    // not the caller's.
    const via =
      entry.actor?.kind === "server" ? undefined : inProcessCaller()?.via;
    return {
      id,
      created_at: clock.now().toISOString(),
      key_id: entry.key_id ?? null,
      action: entry.action,
      resource_type: entry.resource_type,
      resource_id: entry.resource_id ?? null,
      client_ip: entry.client_ip ?? null,
      details: JSON.stringify({
        ...entry.details,
        ...(via !== undefined && { via }),
        _actor: entry.actor ?? null,
      }),
    };
  }

  /** Awaited strict insertion; serialization and database failures reach the caller. */
  async log(entry: AuditLogEntry, id?: string): Promise<void> {
    const actor = entry.actor === undefined ? await auditActor() : entry.actor;
    await this.db
      .insert(auditLog)
      .values(this.buildRow({ ...entry, actor }, id))
      .run();
  }

  async has(id: string): Promise<boolean> {
    return (
      (await this.db
        .select({ id: auditLog.id })
        .from(auditLog)
        .where(eq(auditLog.id, id))
        .get()) !== undefined
    );
  }

  async list(filters: {
    action?: string;
    resource_type?: string;
    resource_id?: string;
    kind?: AuditKind;
    q?: string;
    created_after?: string;
    created_before?: string;
    limit?: number;
    cursor?: string;
  }): Promise<PaginatedResult<AuditEntry>> {
    const limit = Math.max(
      MIN_PAGE_LIMIT,
      Math.min(filters.limit ?? DEFAULT_PAGE_LIMIT, MAX_PAGE_LIMIT),
    );
    const conditions = [];

    if (filters.action) {
      conditions.push(eq(auditLog.action, filters.action));
    }
    if (filters.resource_type) {
      conditions.push(eq(auditLog.resource_type, filters.resource_type));
    }
    if (filters.resource_id) {
      conditions.push(eq(auditLog.resource_id, filters.resource_id));
    }
    if (filters.kind) conditions.push(kindClause(filters.kind));
    if (filters.q) {
      const clause = searchClause(filters.q);
      if (clause) conditions.push(clause);
    }
    // Re-spelled to the width the column is stamped at, like every other
    // bounded door. The comparison is lexical against text, so a bound
    // written at second precision names a different string than the
    // millisecond-wide value stored: `.` sorts below `Z`, which drops the
    // whole second from a lower bound and keeps it in an upper one. Both
    // answers are a well-formed 200. This also refuses a bound that is not
    // an instant, which otherwise reached the comparison as an ordinary
    // string and answered either the empty trail or the whole one.
    const createdAfter = normalizeTimeBound(
      filters.created_after,
      "created_after",
    );
    const createdBefore = normalizeTimeBound(
      filters.created_before,
      "created_before",
    );
    if (createdAfter !== undefined) {
      conditions.push(gt(auditLog.created_at, createdAfter));
    }
    if (createdBefore !== undefined) {
      conditions.push(lt(auditLog.created_at, createdBefore));
    }
    // The cursor is not a bound a caller chose: it is the last row already
    // delivered, so it is excluded to advance the page rather than to
    // answer a question about an instant.
    if (filters.cursor) {
      const { v, id } = decodeKeyedCursor(filters.cursor, AUDIT_CURSOR_KEY);
      const cursorClause = or(
        lt(auditLog.created_at, v),
        and(eq(auditLog.created_at, v), lt(auditLog.id, id)),
      );
      if (cursorClause) conditions.push(cursorClause);
    }

    let query = this.db
      .select()
      .from(auditLog)
      .orderBy(desc(auditLog.created_at), desc(auditLog.id))
      .limit(limit + 1)
      .$dynamic();

    if (conditions.length > 0) {
      query = query.where(and(...conditions));
    }

    const rows = await query.all();
    const hasMore = rows.length > limit;
    const data = rows.slice(0, limit).map(rowToEntry);
    let nextCursor: string | null = null;
    if (hasMore) {
      const last = data.at(-1);
      if (!last) throw new Error("unreachable: hasMore but data is empty");
      nextCursor = encodeKeyedCursor(
        last.created_at,
        last.id,
        AUDIT_CURSOR_KEY,
      );
    }

    return { data, next_cursor: nextCursor };
  }

  async cleanup(retentionDays: number): Promise<number> {
    const cutoff = new Date(
      clock.nowMs() - retentionDays * 24 * 60 * 60 * 1000,
    ).toISOString();
    const result = await this.db
      .delete(auditLog)
      .where(lt(auditLog.created_at, cutoff))
      .run();
    return result.rowsAffected;
  }
}
