import { and, eq } from "drizzle-orm";
import { ErrorCode, MarfaError } from "@withmarfa/shared";
import type { EdgeTypeSchema } from "@withmarfa/shared";
import type { EdgeTypeStore, LoadedEdgeType } from "../interface.js";
import { customEdgeTypes } from "./schema.js";
import type { DrizzleDb } from "./connection.js";

function parseRow(row: typeof customEdgeTypes.$inferSelect): EdgeTypeSchema {
  return JSON.parse(row.schema) as EdgeTypeSchema;
}

export class SqliteEdgeTypeStore implements EdgeTypeStore {
  constructor(private db: DrizzleDb) {}

  async list(tenantId?: string): Promise<EdgeTypeSchema[]> {
    const rows = await this.db
      .select()
      .from(customEdgeTypes)
      .where(eq(customEdgeTypes.tenant_id, tenantId ?? ""))
      .all();
    return rows.map(parseRow);
  }

  async get(
    id: string,
    tenantId?: string,
  ): Promise<EdgeTypeSchema | undefined> {
    const row = await this.db
      .select()
      .from(customEdgeTypes)
      .where(
        and(
          eq(customEdgeTypes.id, id),
          eq(customEdgeTypes.tenant_id, tenantId ?? ""),
        ),
      )
      .get();
    return row ? parseRow(row) : undefined;
  }

  async create(
    schema: EdgeTypeSchema,
    tenantId?: string,
  ): Promise<EdgeTypeSchema> {
    const existing = await this.get(schema.id, tenantId);
    if (existing) {
      throw new MarfaError(
        ErrorCode.CONFLICT,
        `Edge type ${schema.id} already exists`,
        { edge_type: schema.id },
      );
    }
    const now = new Date().toISOString();
    await this.db
      .insert(customEdgeTypes)
      .values({
        id: schema.id,
        tenant_id: tenantId ?? "",
        schema: JSON.stringify(schema),
        created_at: now,
        updated_at: now,
      })
      .run();
    return schema;
  }

  async delete(id: string, tenantId?: string): Promise<void> {
    await this.db
      .delete(customEdgeTypes)
      .where(
        and(
          eq(customEdgeTypes.id, id),
          eq(customEdgeTypes.tenant_id, tenantId ?? ""),
        ),
      )
      .run();
  }

  async loadCustomEdgeTypes(): Promise<LoadedEdgeType[]> {
    const rows = await this.db.select().from(customEdgeTypes).all();
    return rows.map((row) => ({
      tenant_id: row.tenant_id,
      schema: parseRow(row),
    }));
  }
}
