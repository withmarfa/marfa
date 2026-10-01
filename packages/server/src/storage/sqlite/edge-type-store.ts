import { eq } from "drizzle-orm";
import { ErrorCode, MarfaError } from "@withmarfa/shared";
import type { EdgeTypeSchema } from "@withmarfa/shared";
import type { EdgeTypeStore } from "../interface.js";
import { edgeTypes } from "./schema.js";
import type { DrizzleDb } from "./connection.js";

function parseRow(row: typeof edgeTypes.$inferSelect): EdgeTypeSchema {
  return JSON.parse(row.schema) as EdgeTypeSchema;
}

export class SqliteEdgeTypeStore implements EdgeTypeStore {
  constructor(private db: DrizzleDb) {}

  async list(): Promise<EdgeTypeSchema[]> {
    const rows = await this.db.select().from(edgeTypes).all();
    return rows.map(parseRow);
  }

  async get(id: string): Promise<EdgeTypeSchema | undefined> {
    const row = await this.db
      .select()
      .from(edgeTypes)
      .where(eq(edgeTypes.id, id))
      .get();
    return row ? parseRow(row) : undefined;
  }

  async create(schema: EdgeTypeSchema): Promise<EdgeTypeSchema> {
    const existing = await this.get(schema.id);
    if (existing) {
      throw new MarfaError(
        ErrorCode.CONFLICT,
        `Edge type ${schema.id} already exists`,
        { edge_type: schema.id },
      );
    }
    const now = new Date().toISOString();
    await this.db
      .insert(edgeTypes)
      .values({
        id: schema.id,
        schema: JSON.stringify(schema),
        created_at: now,
        updated_at: now,
      })
      .run();
    return schema;
  }

  async delete(id: string): Promise<void> {
    await this.db.delete(edgeTypes).where(eq(edgeTypes.id, id)).run();
  }
}
