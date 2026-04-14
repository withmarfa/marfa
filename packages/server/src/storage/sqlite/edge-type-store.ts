import { eq } from "drizzle-orm";
import { ErrorCode, MymeError } from "@mymehq/shared";
import type { EdgeTypeSchema } from "@mymehq/shared";
import type { EdgeTypeStore } from "../interface.js";
import { customEdgeTypes } from "./schema.js";
import type { DrizzleDb } from "./connection.js";

function parseRow(row: typeof customEdgeTypes.$inferSelect): EdgeTypeSchema {
  return JSON.parse(row.schema) as EdgeTypeSchema;
}

export class SqliteEdgeTypeStore implements EdgeTypeStore {
  constructor(private db: DrizzleDb) {}

  async list(): Promise<EdgeTypeSchema[]> {
    const rows = this.db.select().from(customEdgeTypes).all();
    return rows.map(parseRow);
  }

  async get(id: string): Promise<EdgeTypeSchema | undefined> {
    const row = this.db
      .select()
      .from(customEdgeTypes)
      .where(eq(customEdgeTypes.id, id))
      .get();
    return row ? parseRow(row) : undefined;
  }

  async create(
    schema: EdgeTypeSchema,
    tenantId?: string,
  ): Promise<EdgeTypeSchema> {
    const existing = await this.get(schema.id);
    if (existing) {
      throw new MymeError(
        ErrorCode.CONFLICT,
        `Edge type ${schema.id} already exists`,
        { edge_type: schema.id },
      );
    }
    const now = new Date().toISOString();
    this.db
      .insert(customEdgeTypes)
      .values({
        id: schema.id,
        tenant_id: tenantId ?? null,
        schema: JSON.stringify(schema),
        created_at: now,
        updated_at: now,
      })
      .run();
    return schema;
  }

  async delete(id: string): Promise<void> {
    this.db.delete(customEdgeTypes).where(eq(customEdgeTypes.id, id)).run();
  }

  async loadCustomEdgeTypes(): Promise<EdgeTypeSchema[]> {
    return this.list();
  }
}
