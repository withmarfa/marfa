import {
  listTypes,
  getTypeSchema,
  registerTypeSchema,
  unregisterTypeSchema,
  MarfaError,
  ErrorCode,
} from "@withmarfa/shared";
import type { SeededPlatformType, TypeSchema } from "@withmarfa/shared";
import { sql } from "drizzle-orm";
import type { LoadedType, TypeProvenance, TypeStore } from "../interface.js";
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

  async create(
    schema: TypeSchema,
    spaceId?: string,
    provenance?: TypeProvenance,
  ): Promise<TypeSchema> {
    const now = new Date().toISOString();
    try {
      await this.db.run(sql`
        INSERT INTO custom_types (id, space_id, schema, origin, family, owner_integration, created_at, updated_at)
        VALUES (${schema.id}, ${spaceId ?? ""}, ${JSON.stringify(schema)}, ${provenance?.origin ?? "user"}, ${provenance?.family ?? null}, ${provenance?.owner_integration ?? null}, ${now}, ${now})
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

  async listCustom(spaceId?: string): Promise<TypeSchema[]> {
    // `origin != 'platform'` is load-bearing, not a tidy-up. The shipped
    // vocabulary lives in this table now, so "the space's own registrations"
    // has to say so explicitly. Without it an archive would carry the platform
    // set as if the space had registered it, and the restore that replayed it
    // would be refused for trying to register a locked type.
    const rows = await this.db
      .select()
      .from(customTypes)
      .where(sql`space_id = ${spaceId ?? ""} AND origin != 'platform'`)
      .all();
    const results: TypeSchema[] = [];
    for (const row of rows) {
      const parsed = safeJsonParse<TypeSchema | null>(
        row.schema,
        null,
        `custom_types.schema[${row.id}]`,
      );
      if (parsed) results.push(parsed);
    }
    return results;
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
        results.push({
          space_id: row.space_id,
          schema: parsed,
          origin: (row.origin as LoadedType["origin"] | null) ?? "user",
          ...(row.family !== null && {
            family: row.family as LoadedType["family"],
          }),
          ...(row.owner_integration !== null && {
            owner_integration: row.owner_integration,
          }),
        });
      }
    }
    return results;
  }

  async seedPlatformTypes(
    seeded: readonly SeededPlatformType[],
  ): Promise<void> {
    const now = new Date().toISOString();
    for (const { schema, family } of seeded) {
      // Upsert rather than insert-if-absent: a redeploy carrying a changed
      // shipped schema has to move the row, or the instance keeps resolving
      // whatever it was first seeded with.
      await this.db.run(sql`
        INSERT INTO custom_types (id, space_id, schema, origin, family, owner_integration, created_at, updated_at)
        VALUES (${schema.id}, '', ${JSON.stringify(schema)}, 'platform', ${family}, NULL, ${now}, ${now})
        ON CONFLICT (space_id, id) DO UPDATE SET
          schema = excluded.schema,
          origin = 'platform',
          family = excluded.family,
          updated_at = ${now}
      `);
    }
  }

  async countCustom(): Promise<number> {
    const row = await this.db
      .select({ count: sql<number>`count(*)` })
      .from(customTypes)
      .where(sql`origin != 'platform'`)
      .get();
    return row?.count ?? 0;
  }
}
