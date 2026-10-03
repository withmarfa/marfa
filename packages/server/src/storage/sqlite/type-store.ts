import { projectPlatformRows } from "../platform-family.js";
import {
  markStructuralReadChange,
  listTypes,
  getTypeSchema,
  registerTypeSchema,
  unregisterTypeSchema,
  removePlatformRegistryType,
  stagePlatformRegistryType,
  MarfaError,
  ErrorCode,
} from "@withmarfa/shared";
import type { SeededPlatformType, TypeSchema } from "@withmarfa/shared";
import { and, eq, inArray, ne, sql } from "drizzle-orm";
import type { LoadedType, TypeProvenance, TypeStore } from "../interface.js";
import { safeJsonParse } from "../json-utils.js";
import { types } from "./schema.js";
import type { DrizzleDb } from "./connection.js";
import { toLoadedTypes } from "../loaded-types.js";
import { buildTypeLinks, forgetType, rebuildTypeLinks } from "./item-links.js";
import { reindexTypeRows } from "./search-store.js";

export class SqliteTypeStore implements TypeStore {
  constructor(private db: DrizzleDb) {}

  list(): Promise<TypeSchema[]> {
    return Promise.resolve(listTypes());
  }

  get(id: string): Promise<TypeSchema | undefined> {
    return Promise.resolve(getTypeSchema(id));
  }

  async create(
    schema: TypeSchema,
    provenance?: TypeProvenance,
  ): Promise<TypeSchema> {
    const now = new Date().toISOString();
    await this.db.transaction(async (tx) => {
      try {
        await tx.run(sql`
          INSERT INTO types (id, schema, origin, created_at, updated_at)
          VALUES (${schema.id}, ${JSON.stringify(schema)}, ${provenance?.origin ?? "user"}, ${now}, ${now})
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
      markStructuralReadChange();
      // Rows a forced delete left are this type's again; the tombstones their
      // purges left were the deleted type's.
      await forgetType(tx, schema.id);
      await buildTypeLinks(tx, schema.id, schema.link_field);
      if (provenance?.origin === "platform") {
        for (const row of projectPlatformRows([{ schema, origin: "platform" }]))
          stagePlatformRegistryType(schema, row.family);
      } else registerTypeSchema(schema);
      await reindexTypeRows(tx, schema.id);
    });
    return schema;
  }

  async update(id: string, schema: TypeSchema): Promise<TypeSchema> {
    const now = new Date().toISOString();
    await this.db.transaction(async (tx) => {
      const stored = await tx
        .select({
          origin: types.origin,
          family: types.family,
          schema: types.schema,
        })
        .from(types)
        .where(eq(types.id, id))
        .get();
      const written = await tx.run(sql`
        UPDATE types SET schema = ${JSON.stringify(schema)}, updated_at = ${now}
        WHERE id = ${id}
      `);
      // A type deleted since the caller looked is not brought back by
      // registering the replacement for a row that is no longer there.
      if (written.rowsAffected === 0) {
        throw new MarfaError(
          ErrorCode.TYPE_NOT_FOUND,
          `Type "${id}" not found`,
        );
      }
      if (
        stored &&
        (JSON.parse(stored.schema) as TypeSchema).parent !== schema.parent
      )
        markStructuralReadChange();
      if (getTypeSchema(id)?.link_field !== schema.link_field) {
        await rebuildTypeLinks(tx, id, schema.link_field);
      }
      if (stored?.origin === "platform") {
        for (const row of projectPlatformRows([
          {
            schema,
            origin: "platform",
            family: stored.family as LoadedType["family"],
          },
        ]))
          stagePlatformRegistryType(schema, row.family);
      } else registerTypeSchema(schema);
      await reindexTypeRows(tx, id);
    });
    return schema;
  }

  async delete(id: string): Promise<void> {
    await this.db.transaction(async (tx) => {
      const deleted = await tx.run(sql`DELETE FROM types WHERE id = ${id}`);
      if (deleted.rowsAffected > 0) {
        markStructuralReadChange();
        unregisterTypeSchema(id);
      }
      await forgetType(tx, id);
      await reindexTypeRows(tx, id);
    });
  }

  async listRegistered(): Promise<TypeSchema[]> {
    // `origin != 'platform'` is load-bearing, not a tidy-up. The shipped
    // vocabulary lives in this table now, so "the instance's own
    // registrations" has to say so explicitly. Without it an archive would
    // carry the platform set as if the instance had registered it, and the
    // restore that replayed it would be refused for trying to register a
    // locked type.
    const rows = await this.db
      .select()
      .from(types)
      .where(sql`origin != 'platform'`)
      .all();
    const results: TypeSchema[] = [];
    for (const row of rows) {
      const parsed = safeJsonParse<TypeSchema | null>(
        row.schema,
        null,
        `types.schema[${row.id}]`,
      );
      if (parsed) results.push(parsed);
    }
    return results;
  }

  async listRegisteredWithProvenance(): Promise<LoadedType[]> {
    // Same row set as `listRegistered`, carrying the provenance columns. The
    // `origin != 'platform'` filter is load-bearing for the same reason
    // it is there: the shipped vocabulary shares this table, so "the
    // instance's own registrations" has to say so explicitly.
    const rows = await this.db
      .select()
      .from(types)
      .where(sql`origin != 'platform'`)
      .all();
    return toLoadedTypes(rows);
  }

  async loadAll(): Promise<LoadedType[]> {
    const rows = await this.db.select().from(types).all();
    return toLoadedTypes(rows);
  }

  async seedPlatformTypes(
    seeded: readonly SeededPlatformType[],
  ): Promise<string[]> {
    const now = new Date().toISOString();
    return this.db.transaction(async (tx) => {
      for (const { schema, family } of seeded) {
        const previous = await tx
          .select()
          .from(types)
          .where(eq(types.id, schema.id))
          .get();
        // Upsert rather than insert-if-absent: a redeploy carrying a changed
        // shipped schema has to move the row, or the instance keeps resolving
        // whatever it was first seeded with.
        //
        // **The `WHERE` is the guard.** `POST /types` stores a registration in
        // this same table. Without it, a build that starts shipping an
        // identifier somebody already registered rewrote their schema
        // unattended on the next boot.
        const written = await tx.run(sql`
        INSERT INTO types (id, schema, origin, family, created_at, updated_at)
        VALUES (${schema.id}, ${JSON.stringify(schema)}, 'platform', ${family}, ${now}, ${now})
        ON CONFLICT (id) DO UPDATE SET
          schema = excluded.schema,
          origin = 'platform',
          family = excluded.family,
          updated_at = ${now}
        WHERE types.origin = 'platform'
      `);
        if (written.rowsAffected > 0) {
          const previousParent = previous
            ? (JSON.parse(previous.schema) as TypeSchema).parent
            : undefined;
          if (previous?.family !== family || previousParent !== schema.parent)
            markStructuralReadChange();
          stagePlatformRegistryType(schema, family);
        }
      }
      const rows = await tx
        .select({ id: types.id })
        .from(types)
        .where(
          and(
            ne(types.origin, "platform"),
            inArray(
              types.id,
              seeded.map(({ schema }) => schema.id),
            ),
          ),
        )
        .all();
      return rows.map((r) => r.id);
    });
  }

  async deletePlatformType(id: string): Promise<boolean> {
    return this.db.transaction(async (tx) => {
      const deleted = await tx
        .delete(types)
        .where(and(eq(types.id, id), eq(types.origin, "platform")))
        .returning({ id: types.id });
      if (deleted.length > 0) {
        markStructuralReadChange();
        removePlatformRegistryType(id);
      }
      return deleted.length > 0;
    });
  }

  async countRegistered(): Promise<number> {
    const row = await this.db
      .select({ count: sql<number>`count(*)` })
      .from(types)
      .where(sql`origin != 'platform'`)
      .get();
    return row?.count ?? 0;
  }
}
