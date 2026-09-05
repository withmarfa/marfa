import { and, eq } from "drizzle-orm";
import { spaceSentinelCondition } from "../space-condition.js";
import { ErrorCode, MarfaError } from "@withmarfa/shared";
import type { EdgeTypeSchema } from "@withmarfa/shared";
import type { EdgeTypeStore, LoadedEdgeType } from "../interface.js";
import { customEdgeTypes } from "./schema.js";
import type { PgDb } from "./connection.js";

function parseRow(row: typeof customEdgeTypes.$inferSelect): EdgeTypeSchema {
  return JSON.parse(row.schema) as EdgeTypeSchema;
}

export class PgEdgeTypeStore implements EdgeTypeStore {
  constructor(private db: PgDb) {}

  async list(spaceId?: string): Promise<EdgeTypeSchema[]> {
    const rows = await this.db
      .select()
      .from(customEdgeTypes)
      .where(spaceSentinelCondition(customEdgeTypes.space_id, spaceId));
    return rows.map(parseRow);
  }

  async get(id: string, spaceId?: string): Promise<EdgeTypeSchema | undefined> {
    const [row] = await this.db
      .select()
      .from(customEdgeTypes)
      .where(
        and(
          eq(customEdgeTypes.id, id),
          spaceSentinelCondition(customEdgeTypes.space_id, spaceId),
        ),
      );
    return row ? parseRow(row) : undefined;
  }

  async create(
    schema: EdgeTypeSchema,
    spaceId?: string,
  ): Promise<EdgeTypeSchema> {
    const existing = await this.get(schema.id, spaceId);
    if (existing) {
      throw new MarfaError(
        ErrorCode.CONFLICT,
        `Edge type ${schema.id} already exists`,
        { edge_type: schema.id },
      );
    }
    const now = new Date().toISOString();
    await this.db.insert(customEdgeTypes).values({
      id: schema.id,
      space_id: spaceId ?? "",
      schema: JSON.stringify(schema),
      created_at: now,
      updated_at: now,
    });
    return schema;
  }

  async delete(id: string, spaceId?: string): Promise<void> {
    await this.db
      .delete(customEdgeTypes)
      .where(
        and(
          eq(customEdgeTypes.id, id),
          spaceSentinelCondition(customEdgeTypes.space_id, spaceId),
        ),
      );
  }

  async loadCustomEdgeTypes(): Promise<LoadedEdgeType[]> {
    const rows = await this.db.select().from(customEdgeTypes);
    return rows.map((row) => ({
      space_id: row.space_id,
      schema: parseRow(row),
    }));
  }
}
