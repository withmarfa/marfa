import {
  TYPE_REGISTRY,
  getTypeSchema,
  registerTypeSchema,
  unregisterTypeSchema,
  MarfaError,
  ErrorCode,
} from "@withmarfa/shared";
import type { TypeSchema } from "@withmarfa/shared";
import { eq, sql } from "drizzle-orm";
import type { TypeStore } from "../interface.js";
import { safeJsonParse } from "../json-utils.js";
import { customTypes } from "./schema.js";
import type { PgDb } from "./connection.js";

export class PgTypeStore implements TypeStore {
  constructor(private db: PgDb) {}

  list(): Promise<TypeSchema[]> {
    return Promise.resolve(Array.from(TYPE_REGISTRY.values()));
  }

  get(id: string): Promise<TypeSchema | undefined> {
    return Promise.resolve(getTypeSchema(id));
  }

  async create(schema: TypeSchema, tenantId?: string): Promise<TypeSchema> {
    const now = new Date().toISOString();
    try {
      await this.db
        .insert(customTypes)
        .values({
          id: schema.id,
          tenant_id: tenantId ?? null,
          schema: JSON.stringify(schema),
          created_at: now,
          updated_at: now,
        })
        .execute();
    } catch (err: unknown) {
      if (
        err instanceof Error &&
        (err.message.includes("duplicate key") ||
          err.message.includes("unique constraint"))
      ) {
        throw new MarfaError(
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
    await this.db
      .update(customTypes)
      .set({ schema: JSON.stringify(schema), updated_at: now })
      .where(eq(customTypes.id, id))
      .execute();
    registerTypeSchema(schema);
    return schema;
  }

  async delete(id: string): Promise<void> {
    await this.db.delete(customTypes).where(eq(customTypes.id, id)).execute();
    unregisterTypeSchema(id);
  }

  async loadCustomTypes(): Promise<TypeSchema[]> {
    const rows = await this.db.select().from(customTypes).execute();
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
    const [row] = await this.db
      .select({ count: sql<number>`count(*)::int` })
      .from(customTypes);
    return row?.count ?? 0;
  }
}
