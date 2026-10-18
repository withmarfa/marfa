import { eq } from "drizzle-orm";
import {
  markStructuralReadChange,
  ErrorCode,
  MarfaError,
  registerEdgeTypeSchema,
  unregisterEdgeTypeSchema,
} from "@withmarfa/shared";
import type { EdgeTypeSchema } from "@withmarfa/shared";
import type { EdgeTypeStore } from "../interface.js";
import { edgeTypes } from "./schema.js";
import type { DrizzleDb } from "./connection.js";
import * as clock from "../../clock.js";

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
    return this.db.transaction(async (tx) => {
      const existing = await this.get(schema.id);
      if (existing)
        throw new MarfaError(
          ErrorCode.CONFLICT,
          `Edge type ${schema.id} already exists`,
          { edge_type: schema.id },
        );
      const now = clock.now().toISOString();
      await tx
        .insert(edgeTypes)
        .values({
          id: schema.id,
          schema: JSON.stringify(schema),
          created_at: now,
          updated_at: now,
        })
        .run();
      markStructuralReadChange();
      registerEdgeTypeSchema(schema);
      return schema;
    });
  }

  async replace(schema: EdgeTypeSchema): Promise<EdgeTypeSchema> {
    return this.db.transaction(async (tx) => {
      const changed = await tx
        .update(edgeTypes)
        .set({
          schema: JSON.stringify(schema),
          updated_at: clock.now().toISOString(),
        })
        .where(eq(edgeTypes.id, schema.id))
        .returning({ id: edgeTypes.id });
      if (changed.length === 0)
        throw new MarfaError(
          ErrorCode.EDGE_TYPE_NOT_FOUND,
          `Edge type ${schema.id} not found`,
        );
      markStructuralReadChange();
      registerEdgeTypeSchema(schema);
      return schema;
    });
  }

  async delete(id: string): Promise<void> {
    await this.db.transaction(async (tx) => {
      const deleted = await tx
        .delete(edgeTypes)
        .where(eq(edgeTypes.id, id))
        .returning({ id: edgeTypes.id });
      if (deleted.length > 0) {
        markStructuralReadChange();
        unregisterEdgeTypeSchema(id);
      }
    });
  }
}
