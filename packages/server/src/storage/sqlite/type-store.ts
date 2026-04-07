import {
  TYPE_REGISTRY,
  getTypeSchema,
  registerTypeSchema,
  unregisterTypeSchema,
  isCoreType,
  MymeError,
  ErrorCode,
} from "@mymehq/shared";
import type { TypeSchema } from "@mymehq/shared";
import { sql } from "drizzle-orm";
import type { TypeStore } from "../interface.js";
import { safeJsonParse } from "../json-utils.js";
import { customTypes } from "./schema.js";
import type { DrizzleDb, RawDb } from "./connection.js";

export class SqliteTypeStore implements TypeStore {
  constructor(
    private db: DrizzleDb,
    private raw: RawDb,
  ) {
    // Load custom types synchronously at startup using raw better-sqlite3
    const rows = this.raw
      .prepare("SELECT id, schema FROM custom_types")
      .all() as { id: string; schema: string }[];
    for (const row of rows) {
      if (isCoreType(row.id)) continue;
      const parsed = safeJsonParse<TypeSchema | null>(
        row.schema,
        null,
        `custom_types.schema[${row.id}]`,
      );
      if (parsed) {
        registerTypeSchema(parsed);
      }
    }
  }

  list(): Promise<TypeSchema[]> {
    return Promise.resolve(Array.from(TYPE_REGISTRY.values()));
  }

  get(id: string): Promise<TypeSchema | undefined> {
    return Promise.resolve(getTypeSchema(id));
  }

  create(schema: TypeSchema, tenantId?: string): Promise<TypeSchema> {
    const now = new Date().toISOString();
    try {
      this.raw
        .prepare(
          "INSERT INTO custom_types (id, tenant_id, schema, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
        )
        .run(schema.id, tenantId ?? null, JSON.stringify(schema), now, now);
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
    return Promise.resolve(schema);
  }

  update(id: string, schema: TypeSchema): Promise<TypeSchema> {
    const now = new Date().toISOString();
    this.raw
      .prepare(
        "UPDATE custom_types SET schema = ?, updated_at = ? WHERE id = ?",
      )
      .run(JSON.stringify(schema), now, id);
    registerTypeSchema(schema);
    return Promise.resolve(schema);
  }

  delete(id: string): Promise<void> {
    this.raw.prepare("DELETE FROM custom_types WHERE id = ?").run(id);
    unregisterTypeSchema(id);
    return Promise.resolve();
  }

  loadCustomTypes(): Promise<TypeSchema[]> {
    const rows = this.db.select().from(customTypes).all() as {
      id: string;
      schema: string;
    }[];
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
    return Promise.resolve(results);
  }

  countCustom(): Promise<number> {
    const row = this.db
      .select({ count: sql<number>`count(*)` })
      .from(customTypes)
      .get();
    return Promise.resolve(row?.count ?? 0);
  }
}
