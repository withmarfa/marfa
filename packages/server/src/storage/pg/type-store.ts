import {
  listTypes,
  getTypeSchema,
  registerTypeSchema,
  unregisterTypeSchema,
  MarfaError,
  ErrorCode,
} from "@withmarfa/shared";
import type { SeededPlatformType, TypeSchema } from "@withmarfa/shared";
import { and, eq, ne, sql } from "drizzle-orm";
import type { LoadedType, TypeProvenance, TypeStore } from "../interface.js";
import { safeJsonParse } from "../json-utils.js";
import { customTypes } from "./schema.js";
import type { PgDb } from "./connection.js";

export class PgTypeStore implements TypeStore {
  constructor(private db: PgDb) {}

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
      await this.db
        .insert(customTypes)
        .values({
          id: schema.id,
          space_id: spaceId ?? "",
          schema: JSON.stringify(schema),
          origin: provenance?.origin ?? "user",
          family: provenance?.family ?? null,
          owner_integration: provenance?.owner_integration ?? null,
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
    registerTypeSchema(schema, spaceId);
    return schema;
  }

  async update(
    id: string,
    schema: TypeSchema,
    spaceId?: string,
  ): Promise<TypeSchema> {
    const now = new Date().toISOString();
    await this.db
      .update(customTypes)
      .set({ schema: JSON.stringify(schema), updated_at: now })
      .where(
        and(eq(customTypes.id, id), eq(customTypes.space_id, spaceId ?? "")),
      )
      .execute();
    registerTypeSchema(schema, spaceId);
    return schema;
  }

  async delete(id: string, spaceId?: string): Promise<void> {
    await this.db
      .delete(customTypes)
      .where(
        and(eq(customTypes.id, id), eq(customTypes.space_id, spaceId ?? "")),
      )
      .execute();
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
      .where(
        and(
          eq(customTypes.space_id, spaceId ?? ""),
          ne(customTypes.origin, "platform"),
        ),
      )
      .execute();
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
    const rows = await this.db.select().from(customTypes).execute();
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
    // Upsert rather than insert-if-absent: a redeploy carrying a changed
    // shipped schema has to move the row, or the instance keeps resolving
    // whatever it was first seeded with.
    for (const { schema, family } of seeded) {
      await this.db
        .insert(customTypes)
        .values({
          id: schema.id,
          space_id: "",
          schema: JSON.stringify(schema),
          origin: "platform",
          family,
          owner_integration: null,
          created_at: now,
          updated_at: now,
        })
        .onConflictDoUpdate({
          target: [customTypes.space_id, customTypes.id],
          set: {
            schema: JSON.stringify(schema),
            origin: "platform",
            family,
            updated_at: now,
          },
        })
        .execute();
    }
  }

  async countCustom(): Promise<number> {
    const [row] = await this.db
      .select({ count: sql<number>`count(*)::int` })
      .from(customTypes)
      .where(ne(customTypes.origin, "platform"));
    return row?.count ?? 0;
  }
}
