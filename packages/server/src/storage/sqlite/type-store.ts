import {
  TYPE_REGISTRY,
  getTypeSchema,
  registerTypeSchema,
  unregisterTypeSchema,
  MymeError,
  ErrorCode,
} from "@mymehq/shared";
import type { TypeSchema } from "@mymehq/shared";
import { sql } from "drizzle-orm";
import type { TypeStore } from "../interface.js";
import { safeJsonParse } from "../json-utils.js";
import { customTypes } from "./schema.js";
import type { DrizzleDb } from "./connection.js";

export class SqliteTypeStore implements TypeStore {
  constructor(private db: DrizzleDb) {}

  list(): Promise<TypeSchema[]> {
    return Promise.resolve(Array.from(TYPE_REGISTRY.values()));
  }

  get(id: string): Promise<TypeSchema | undefined> {
    return Promise.resolve(getTypeSchema(id));
  }

  async create(schema: TypeSchema, tenantId?: string): Promise<TypeSchema> {
    const now = new Date().toISOString();
    try {
      await this.db.run(sql`
        INSERT INTO custom_types (id, tenant_id, schema, created_at, updated_at)
        VALUES (${schema.id}, ${tenantId ?? null}, ${JSON.stringify(schema)}, ${now}, ${now})
      `);
    } catch (err: unknown) {
      if (
        err instanceof Error &&
        err.message.includes("UNIQUE constraint failed")
      ) {
        throw new MymeError(
          ErrorCode.TYPE_ALREADY_EXISTS,
          `Type "${schema.id}" already exists`,
        );
      }
      throw err;
    }
    registerTypeSchema(schema);
    return schema;
  }

  async update(id: string, schema: TypeSchema): Promise<TypeSchema> {
    const now = new Date().toISOString();
    await this.db.run(sql`
      UPDATE custom_types SET schema = ${JSON.stringify(schema)}, updated_at = ${now}
      WHERE id = ${id}
    `);
    registerTypeSchema(schema);
    return schema;
  }

  async delete(id: string): Promise<void> {
    await this.db.run(sql`DELETE FROM custom_types WHERE id = ${id}`);
    unregisterTypeSchema(id);
  }

  async loadCustomTypes(): Promise<TypeSchema[]> {
    const rows = await this.db.select().from(customTypes).all();
    const results: TypeSchema[] = [];
    for (const row of rows) {
      const parsed = safeJsonParse<TypeSchema | null>(
        row.schema,
        null,
        `custom_types.schema[${row.id}]`,
      );
      if (parsed) {
        results.push(parsed);
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
