import {
  listTypes,
  getTypeSchema,
  registerTypeSchema,
  unregisterTypeSchema,
  MarfaError,
  ErrorCode,
} from "@withmarfa/shared";
import type { TypeSchema } from "@withmarfa/shared";
import { sql } from "drizzle-orm";
import type { LoadedType, TypeStore } from "../interface.js";
import { safeJsonParse } from "../json-utils.js";
import { customTypes } from "./schema.js";
import type { DrizzleDb } from "./connection.js";

export class SqliteTypeStore implements TypeStore {
  constructor(private db: DrizzleDb) {}

  list(spaceId?: string): Promise<TypeSchema[]> {
    return Promise.resolve(listTypes(spaceId));
  }

  get(id: string, spaceId?: string): Promise<TypeSchema | undefined> {
    return Promise.resolve(getTypeSchema(id, spaceId));
  }

  async create(schema: TypeSchema, spaceId?: string): Promise<TypeSchema> {
    const now = new Date().toISOString();
    try {
      await this.db.run(sql`
        INSERT INTO custom_types (id, space_id, schema, created_at, updated_at)
        VALUES (${schema.id}, ${spaceId ?? ""}, ${JSON.stringify(schema)}, ${now}, ${now})
      `);
    } catch (err: unknown) {
      if (
        err instanceof Error &&
        err.message.includes("UNIQUE constraint failed")
      ) {
        throw new MarfaError(
          ErrorCode.TYPE_ALREADY_EXISTS,
          `Type "${schema.id}" already exists`,
        );
      }
      throw err;
    }
    registerTypeSchema(schema, spaceId);
    return schema;
  }

  async update(
    id: string,
    schema: TypeSchema,
    spaceId?: string,
  ): Promise<TypeSchema> {
    const now = new Date().toISOString();
    await this.db.run(sql`
      UPDATE custom_types SET schema = ${JSON.stringify(schema)}, updated_at = ${now}
      WHERE id = ${id} AND space_id = ${spaceId ?? ""}
    `);
    registerTypeSchema(schema, spaceId);
    return schema;
  }

  async delete(id: string, spaceId?: string): Promise<void> {
    await this.db.run(
      sql`DELETE FROM custom_types WHERE id = ${id} AND space_id = ${spaceId ?? ""}`,
    );
    unregisterTypeSchema(id, spaceId);
  }

  async loadCustomTypes(): Promise<LoadedType[]> {
    const rows = await this.db.select().from(customTypes).all();
    const results: LoadedType[] = [];
    for (const row of rows) {
      const parsed = safeJsonParse<TypeSchema | null>(
        row.schema,
        null,
        `custom_types.schema[${row.id}]`,
      );
      if (parsed) {
        results.push({ space_id: row.space_id, schema: parsed });
      }
    }
    return results;
  }

  async countCustom(): Promise<number> {
    const row = await this.db
      .select({ count: sql<number>`count(*)` })
      .from(customTypes)
      .get();
    return row?.count ?? 0;
  }
}
