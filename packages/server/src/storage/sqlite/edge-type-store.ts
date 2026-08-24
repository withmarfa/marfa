/* eslint-disable no-restricted-syntax -- Not yet on the shared space
 * fence. `storage/space-condition.ts` is the one spelling of it, and
 * this store predates it; the rule covers every store so a new file is
 * covered by default, which leaves the existing ones needing a line
 * that says so. Normalizing one is a change of its own: an absent space
 * has to be read call site by call site, and reading it wrong is the
 * defect the helper exists for. Delete this line when you do. */
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

  async list(spaceId?: string): Promise<EdgeTypeSchema[]> {
    const rows = await this.db
      .select()
      .from(customEdgeTypes)
      .where(eq(customEdgeTypes.space_id, spaceId ?? ""))
      .all();
    return rows.map(parseRow);
  }

  async get(id: string, spaceId?: string): Promise<EdgeTypeSchema | undefined> {
    const row = await this.db
      .select()
      .from(customEdgeTypes)
      .where(
        and(
          eq(customEdgeTypes.id, id),
          eq(customEdgeTypes.space_id, spaceId ?? ""),
        ),
      )
      .get();
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
    await this.db
      .insert(customEdgeTypes)
      .values({
        id: schema.id,
        space_id: spaceId ?? "",
        schema: JSON.stringify(schema),
        created_at: now,
        updated_at: now,
      })
      .run();
    return schema;
  }

  async delete(id: string, spaceId?: string): Promise<void> {
    await this.db
      .delete(customEdgeTypes)
      .where(
        and(
          eq(customEdgeTypes.id, id),
          eq(customEdgeTypes.space_id, spaceId ?? ""),
        ),
      )
      .run();
  }

  async loadCustomEdgeTypes(): Promise<LoadedEdgeType[]> {
    const rows = await this.db.select().from(customEdgeTypes).all();
    return rows.map((row) => ({
      space_id: row.space_id,
      schema: parseRow(row),
    }));
  }
}
