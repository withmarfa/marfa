import { eq, and, desc, gt, lt, or } from "drizzle-orm";
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
import { auditLog } from "./schema.js";
import type { DrizzleDb } from "./connection.js";

function rowToEntry(row: typeof auditLog.$inferSelect): AuditEntry {
  return {
    id: row.id,
    created_at: row.created_at,
    key_id: row.key_id ?? null,
    action: row.action,
    resource_type: row.resource_type,
    resource_id: row.resource_id ?? null,
    client_ip: row.client_ip ?? null,
    details: safeJsonParse<Record<string, unknown>>(
      row.details,
      {},
      "audit_log.details",
    ),
  };
}

export class SqliteAuditStore implements AuditStore {
  constructor(private db: DrizzleDb) {}

  private buildRow(
    entry: AuditLogEntry,
    id = generateId(),
  ): typeof auditLog.$inferInsert {
    return {
      id,
      created_at: new Date().toISOString(),
      key_id: entry.key_id ?? null,
      action: entry.action,
      resource_type: entry.resource_type,
      resource_id: entry.resource_id ?? null,
      client_ip: entry.client_ip ?? null,
      details: JSON.stringify(entry.details ?? {}),
    };
  }

  /** Awaited strict insertion; serialization and database failures reach the caller. */
  async log(entry: AuditLogEntry, id?: string): Promise<void> {
    await this.db.insert(auditLog).values(this.buildRow(entry, id)).run();
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
      Date.now() - retentionDays * 24 * 60 * 60 * 1000,
    ).toISOString();
    const result = await this.db
      .delete(auditLog)
      .where(lt(auditLog.created_at, cutoff))
      .run();
    return result.rowsAffected;
  }
}
