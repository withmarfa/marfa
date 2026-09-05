/* eslint-disable no-restricted-syntax -- Not yet on the shared space
 * fence. `storage/space-condition.ts` is the one spelling of it, and
 * this store predates it; the rule covers every store so a new file is
 * covered by default, which leaves the existing ones needing a line
 * that says so. Normalizing one is a change of its own: an absent space
 * has to be read call site by call site, and reading it wrong is the
 * defect the helper exists for. Delete this line when you do. */
import {
  listTypes,
  getTypeSchema,
  registerTypeSchema,
  unregisterTypeSchema,
  MarfaError,
  ErrorCode,
} from "@withmarfa/shared";
import type { SeededPlatformType, TypeSchema } from "@withmarfa/shared";
import { and, eq, inArray, ne, sql } from "drizzle-orm";
import type { LoadedType, TypeProvenance, TypeStore } from "../interface.js";
import { spaceSentinelCondition } from "../space-condition.js";
import { safeJsonParse } from "../json-utils.js";
import { customTypes } from "./schema.js";
import type { PgDb } from "./connection.js";
import { toLoadedTypes } from "../loaded-types.js";

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

  async listCustomWithProvenance(spaceId?: string): Promise<LoadedType[]> {
    // Same row set as `listCustom`, carrying the provenance columns. The
    // `origin != 'platform'` filter is load-bearing for the same reason
    // it is there: the shipped vocabulary shares this table, so "the
    // space's own registrations" has to say so explicitly.
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
    return toLoadedTypes(rows);
  }

  async loadCustomTypes(): Promise<LoadedType[]> {
    const rows = await this.db.select().from(customTypes).execute();
    return toLoadedTypes(rows);
  }

  async seedPlatformTypes(
    seeded: readonly SeededPlatformType[],
  ): Promise<string[]> {
    const now = new Date().toISOString();
    // Upsert rather than insert-if-absent: a redeploy carrying a changed
    // shipped schema has to move the row, or the instance keeps resolving
    // whatever it was first seeded with.
    //
    // **But only over a row this seed wrote.** `POST /types` stores a
    // registration at `space_id: spaceId ?? ""`, and under `AUTH_MODE=keys` —
    // every self-host — a credential carries no space, so a self-hoster's own
    // type lands in the same primary-key bucket the seed writes to. Without
    // the `setWhere`, a build that starts shipping an identifier somebody
    // already registered rewrote their schema on the next boot, flipped
    // `origin` from `user` to `platform` and stamped a family — unattended,
    // and with every mechanism that would surface it disabled by the same
    // write: `listCustom` filters `origin != 'platform'` so it left their
    // registrations and their archive export, `isLockedPlatformType` then
    // refused both `PUT` and `DELETE`, and `computePlatformDrift` could never
    // report it because the row genuinely matched a shipped id afterwards.
    //
    // A collision is left alone and reported rather than resolved here. The
    // seed runs unattended on every boot of every instance, which is the one
    // place that must not make an irreversible choice about somebody's data.
    const collided: string[] = [];
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
          setWhere: eq(customTypes.origin, "platform"),
        })
        .execute();
    }
    // Anything the guard above declined to overwrite: a shipped id sitting on
    // a row this seed did not write.
    const rows = await this.db
      .select({ id: customTypes.id })
      .from(customTypes)
      .where(
        and(
          // The platform bucket, addressed through the shared helper rather
          // than spelled inline — the stores came to disagree about what an
          // absent space means precisely by spelling it.
          spaceSentinelCondition(customTypes.space_id, ""),
          ne(customTypes.origin, "platform"),
          inArray(
            customTypes.id,
            seeded.map(({ schema }) => schema.id),
          ),
        ),
      )
      .execute();
    collided.push(...rows.map((r) => r.id));
    return collided;
  }

  async deletePlatformType(id: string): Promise<boolean> {
    const deleted = await this.db
      .delete(customTypes)
      .where(
        and(
          eq(customTypes.id, id),
          spaceSentinelCondition(customTypes.space_id, ""),
          eq(customTypes.origin, "platform"),
        ),
      )
      .returning({ id: customTypes.id });
    return deleted.length > 0;
  }

  async countCustom(): Promise<number> {
    const [row] = await this.db
      .select({ count: sql<number>`count(*)::int` })
      .from(customTypes)
      .where(ne(customTypes.origin, "platform"));
    return row?.count ?? 0;
  }
}
