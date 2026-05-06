import { eq, and, desc, lt, or, gte, lte, isNull } from "drizzle-orm";
import { generateId } from "@mymehq/shared";
import type { PaginatedResult } from "@mymehq/shared";
import type { AuditStore, AuditEntry } from "../interface.js";
import { encodeCursor, decodeCursor } from "../interface.js";
import { safeJsonParse } from "../json-utils.js";
import { auditLog } from "./schema.js";
import type { PgDb } from "./connection.js";

function rowToEntry(row: typeof auditLog.$inferSelect): AuditEntry {
  const details = safeJsonParse<Record<string, unknown>>(
    row.details,
    {},
    "audit_log.details",
  );
  // T-027: client_ip is persisted alongside the rest of details for
  // schema compatibility (audit_log.details is JSON, no migration); the
  // typed interface lifts it back to a top-level field on the read path.
  const ipRaw = details.client_ip;
  const client_ip =
    typeof ipRaw === "string" && ipRaw.length > 0 ? ipRaw : null;
  return {
    id: row.id,
    timestamp: row.timestamp,
    key_id: row.key_id ?? null,
    tenant_id: row.tenant_id ?? null,
    action: row.action,
    resource_type: row.resource_type,
    resource_id: row.resource_id ?? null,
    client_ip,
    details,
  };
}

export class PgAuditStore implements AuditStore {
  constructor(private db: PgDb) {}

  async log(entry: {
    key_id?: string;
    tenant_id?: string | null;
    action: string;
    resource_type: string;
    resource_id?: string;
    client_ip?: string | null;
    details?: Record<string, unknown>;
  }): Promise<void> {
    // T-027: fold the typed `client_ip` into the JSON `details` blob.
    // Persisting alongside the existing details keeps the schema stable
    // (no migration needed) while exposing IP as a typed field on read.
    const detailsBlob: Record<string, unknown> = { ...(entry.details ?? {}) };
    if (entry.client_ip !== undefined && entry.client_ip !== null) {
      detailsBlob.client_ip = entry.client_ip;
    }
    await this.db.insert(auditLog).values({
      id: generateId(),
      timestamp: new Date().toISOString(),
      key_id: entry.key_id ?? null,
      tenant_id: entry.tenant_id ?? null,
      action: entry.action,
      resource_type: entry.resource_type,
      resource_id: entry.resource_id ?? null,
      details: JSON.stringify(detailsBlob),
    });
  }

  async list(filters: {
    action?: string;
    resource_type?: string;
    resource_id?: string;
    since?: string;
    until?: string;
    limit?: number;
    cursor?: string;
    tenant_id?: string | null;
  }): Promise<PaginatedResult<AuditEntry>> {
    const limit = Math.max(1, Math.min(filters.limit ?? 50, 200));
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
    if (filters.since) {
      conditions.push(gte(auditLog.timestamp, filters.since));
    }
    if (filters.until) {
      conditions.push(lte(auditLog.timestamp, filters.until));
    }
    // T-041: tenant scope. When the caller is tenant-scoped (filter
    // explicitly set), restrict to rows with matching `tenant_id`. When
    // omitted, no tenant filter is applied — bootstrap-admin reads on
    // self-hosted, plus the cleanup job which is currently global.
    if (filters.tenant_id !== undefined && filters.tenant_id !== null) {
      conditions.push(eq(auditLog.tenant_id, filters.tenant_id));
    }

    if (filters.cursor) {
      const { v, id } = decodeCursor(filters.cursor);
      const cursorClause = or(
        lt(auditLog.timestamp, v),
        and(eq(auditLog.timestamp, v), lt(auditLog.id, id)),
      );
      if (cursorClause) conditions.push(cursorClause);
    }

    let query = this.db
      .select()
      .from(auditLog)
      .orderBy(desc(auditLog.timestamp), desc(auditLog.id))
      .limit(limit + 1)
      .$dynamic();

    if (conditions.length > 0) {
      query = query.where(and(...conditions));
    }

    const rows = await query;
    const hasMore = rows.length > limit;
    const data = rows.slice(0, limit).map(rowToEntry);
    let nextCursor: string | null = null;
    if (hasMore) {
      const last = data.at(-1);
      if (!last) throw new Error("unreachable: hasMore but data is empty");
      nextCursor = encodeCursor(last.timestamp, last.id);
    }

    return { data, cursor: nextCursor, has_more: hasMore };
  }

  async cleanup(
    retentionDays: number,
    tenantId?: string | null,
  ): Promise<number> {
    const cutoff = new Date(
      Date.now() - retentionDays * 24 * 60 * 60 * 1000,
    ).toISOString();
    // T-050 — three filter shapes:
    //   undefined → every row older than cutoff
    //   string    → tenant_id = X
    //   null      → tenant_id IS NULL
    const tenantClause =
      tenantId === undefined
        ? undefined
        : tenantId === null
          ? isNull(auditLog.tenant_id)
          : eq(auditLog.tenant_id, tenantId);
    const where =
      tenantClause === undefined
        ? lt(auditLog.timestamp, cutoff)
        : and(lt(auditLog.timestamp, cutoff), tenantClause);
    const rows = await this.db
      .delete(auditLog)
      .where(where)
      .returning({ id: auditLog.id });
    return rows.length;
  }
}
