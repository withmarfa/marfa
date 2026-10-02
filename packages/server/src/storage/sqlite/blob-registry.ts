import {
  and,
  asc,
  eq,
  exists,
  inArray,
  isNull,
  lt,
  not,
  notExists,
  sql,
} from "drizzle-orm";
import type {
  BlobCopyRef,
  BlobLocation,
  BlobOrphanRow,
  BlobRegistry,
  BlobSizedRef,
  BlobStoreKind,
  BlobStoreRow,
} from "../interface.js";
import {
  blobLocations,
  blobOrphans,
  blobStores,
  blobUploaders,
  blobs,
  item_blob_references,
  items,
} from "./schema.js";
import type { DrizzleDb } from "./connection.js";

export class SqliteBlobRegistry implements BlobRegistry {
  constructor(private db: DrizzleDb) {}

  async register(
    hash: string,
    mimeType: string,
    sizeBytes: number,
  ): Promise<void> {
    await this.db
      .insert(blobs)
      .values({
        hash,
        mime_type: mimeType,
        size_bytes: sizeBytes,
        created_at: new Date().toISOString(),
      })
      .onConflictDoNothing()
      .run();
  }

  async get(hash: string): Promise<{
    mime_type: string;
    size_bytes: number;
  } | null> {
    const row = await this.db
      .select({ mime_type: blobs.mime_type, size_bytes: blobs.size_bytes })
      .from(blobs)
      .where(eq(blobs.hash, hash))
      .get();
    return row ?? null;
  }

  async listAll(): Promise<string[]> {
    const rows = await this.db.select({ hash: blobs.hash }).from(blobs).all();
    return rows.map((r) => r.hash);
  }

  async lendingTypes(hash: string): Promise<string[]> {
    const rows = await this.db
      .selectDistinct({ type: items.type })
      .from(item_blob_references)
      .innerJoin(items, eq(items.id, item_blob_references.item_id))
      .innerJoin(
        blobUploaders,
        and(
          eq(blobUploaders.hash, item_blob_references.hash),
          eq(blobUploaders.uploader, item_blob_references.writer),
        ),
      )
      .where(eq(item_blob_references.hash, hash))
      .all();
    return rows.map((r) => r.type);
  }

  async recordUploader(hash: string, uploader: string): Promise<void> {
    await this.db
      .insert(blobUploaders)
      .values({ hash, uploader })
      .onConflictDoNothing()
      .run();
  }

  async remove(hash: string): Promise<void> {
    await this.db.delete(blobs).where(eq(blobs.hash, hash)).run();
  }

  async count(): Promise<{ count: number; total_size_bytes: number }> {
    const row = await this.db
      .select({
        count: sql<number>`count(*)`,
        total_size_bytes: sql<number>`coalesce(sum(${blobs.size_bytes}), 0)`,
      })
      .from(blobs)
      .get();
    return {
      count: row?.count ?? 0,
      total_size_bytes: row?.total_size_bytes ?? 0,
    };
  }

  async attachStore(store: {
    id: string;
    kind: BlobStoreKind;
    locator: string;
  }): Promise<void> {
    const now = new Date().toISOString();
    await this.db
      .insert(blobStores)
      .values({
        id: store.id,
        kind: store.kind,
        locator: store.locator,
        attached_at: now,
        detached_at: null,
      })
      .onConflictDoUpdate({
        target: blobStores.id,
        set: { kind: store.kind, locator: store.locator, detached_at: null },
      })
      .run();
  }

  async detachStoresExcept(ids: readonly string[]): Promise<number> {
    const now = new Date().toISOString();
    const rows = await this.db
      .update(blobStores)
      .set({ detached_at: now })
      .where(
        ids.length > 0
          ? and(
              isNull(blobStores.detached_at),
              not(inArray(blobStores.id, [...ids])),
            )
          : isNull(blobStores.detached_at),
      )
      .returning({ id: blobStores.id })
      .all();
    return rows.length;
  }

  async listStores(): Promise<BlobStoreRow[]> {
    const rows = await this.db
      .select()
      .from(blobStores)
      .orderBy(blobStores.attached_at)
      .all();
    return rows.map((row) => ({
      id: row.id,
      kind: row.kind as BlobStoreKind,
      locator: row.locator,
      policy: row.policy,
      attached_at: row.attached_at,
      detached_at: row.detached_at,
    }));
  }

  async recordLocation(hash: string, storeId: string): Promise<void> {
    await this.db
      .insert(blobLocations)
      .values({
        hash,
        store_id: storeId,
        recorded_at: new Date().toISOString(),
        verified_at: null,
      })
      .onConflictDoNothing()
      .run();
  }

  async removeLocation(hash: string, storeId: string): Promise<boolean> {
    const rows = await this.db
      .delete(blobLocations)
      .where(
        and(eq(blobLocations.hash, hash), eq(blobLocations.store_id, storeId)),
      )
      .returning({ hash: blobLocations.hash })
      .all();
    return rows.length > 0;
  }

  async markVerified(hash: string, storeId: string, at: string): Promise<void> {
    await this.db
      .update(blobLocations)
      .set({ verified_at: at })
      .where(
        and(eq(blobLocations.hash, hash), eq(blobLocations.store_id, storeId)),
      )
      .run();
  }

  /** Registered, held live by an attached store other than `storeId`, and
   *  without a row in `storeId`. */
  private missingFrom(storeId: string) {
    return and(
      notExists(
        this.db
          .select({ one: sql`1` })
          .from(blobLocations)
          .where(
            and(
              eq(blobLocations.hash, blobs.hash),
              eq(blobLocations.store_id, storeId),
            ),
          ),
      ),
      exists(
        this.db
          .select({ one: sql`1` })
          .from(blobLocations)
          .innerJoin(blobStores, eq(blobLocations.store_id, blobStores.id))
          .where(
            and(
              eq(blobLocations.hash, blobs.hash),
              isNull(blobStores.detached_at),
            ),
          ),
      ),
    );
  }

  async listMissingFrom(
    storeId: string,
    limit: number,
  ): Promise<BlobSizedRef[]> {
    return this.db
      .select({ hash: blobs.hash, size_bytes: blobs.size_bytes })
      .from(blobs)
      .where(this.missingFrom(storeId))
      .orderBy(asc(blobs.created_at), asc(blobs.hash))
      .limit(limit)
      .all();
  }

  async countMissingFrom(storeId: string): Promise<number> {
    const row = await this.db
      .select({ count: sql<number>`count(*)` })
      .from(blobs)
      .where(this.missingFrom(storeId))
      .get();
    return row?.count ?? 0;
  }

  async listToVerify(
    storeIds: readonly string[],
    limit: number,
  ): Promise<BlobCopyRef[]> {
    if (storeIds.length === 0) return [];
    return (
      this.db
        .select({
          hash: blobLocations.hash,
          store_id: blobLocations.store_id,
          size_bytes: blobs.size_bytes,
        })
        .from(blobLocations)
        .innerJoin(blobs, eq(blobLocations.hash, blobs.hash))
        .where(inArray(blobLocations.store_id, [...storeIds]))
        // Never checked first (a null sorts before any stamp), then the least
        // recently checked, whichever store holds it.
        .orderBy(
          sql`${blobLocations.verified_at} IS NOT NULL`,
          asc(blobLocations.verified_at),
          asc(blobLocations.hash),
          asc(blobLocations.store_id),
        )
        .limit(limit)
        .all()
    );
  }

  async dropLocationKeeping(
    hash: string,
    storeId: string,
    minCopies: number,
  ): Promise<"dropped" | "below_minimum" | "absent"> {
    // The count of live copies is taken inside the DELETE's own predicate,
    // so the row goes only if the minimum holds at the moment it goes.
    const live = this.db
      .select({ count: sql`count(*)` })
      .from(blobLocations)
      .innerJoin(blobStores, eq(blobLocations.store_id, blobStores.id))
      .where(and(eq(blobLocations.hash, hash), isNull(blobStores.detached_at)));
    const rows = await this.db
      .delete(blobLocations)
      .where(
        and(
          eq(blobLocations.hash, hash),
          eq(blobLocations.store_id, storeId),
          sql`(${live}) - 1 >= ${minCopies}`,
        ),
      )
      .returning({ hash: blobLocations.hash })
      .all();
    if (rows.length > 0) return "dropped";
    const held = await this.db
      .select({ hash: blobLocations.hash })
      .from(blobLocations)
      .innerJoin(blobStores, eq(blobLocations.store_id, blobStores.id))
      .where(
        and(
          eq(blobLocations.hash, hash),
          eq(blobLocations.store_id, storeId),
          isNull(blobStores.detached_at),
        ),
      )
      .get();
    return held ? "below_minimum" : "absent";
  }

  async retainOrphans(hashes: readonly string[], at: string): Promise<number> {
    if (hashes.length === 0) {
      await this.db.delete(blobOrphans).run();
      return 0;
    }
    // The set can be large; the parameter limit is not. Both halves work
    // in slices, which is safe because each is idempotent on its own rows.
    const SLICE = 500;
    const kept = new Set(hashes);
    const reported = await this.db
      .select({ hash: blobOrphans.hash })
      .from(blobOrphans)
      .all();
    const stale = reported.map((r) => r.hash).filter((h) => !kept.has(h));
    for (let i = 0; i < stale.length; i += SLICE) {
      await this.db
        .delete(blobOrphans)
        .where(inArray(blobOrphans.hash, stale.slice(i, i + SLICE)))
        .run();
    }
    for (let i = 0; i < hashes.length; i += SLICE) {
      await this.db
        .insert(blobOrphans)
        .values(
          hashes.slice(i, i + SLICE).map((hash) => ({ hash, reported_at: at })),
        )
        .onConflictDoNothing()
        .run();
    }
    return hashes.length;
  }

  async listOrphans(): Promise<BlobOrphanRow[]> {
    return this.db
      .select({
        hash: blobOrphans.hash,
        mime_type: blobs.mime_type,
        size_bytes: blobs.size_bytes,
        reported_at: blobOrphans.reported_at,
      })
      .from(blobOrphans)
      .innerJoin(blobs, eq(blobOrphans.hash, blobs.hash))
      .orderBy(asc(blobOrphans.reported_at), asc(blobOrphans.hash))
      .all();
  }

  async listOrphansToPurge(
    before: string,
    runStartedAt: string,
  ): Promise<string[]> {
    const rows = await this.db
      .select({ hash: blobOrphans.hash })
      .from(blobOrphans)
      .where(
        and(
          lt(blobOrphans.reported_at, runStartedAt),
          lt(blobOrphans.reported_at, before),
        ),
      )
      .orderBy(asc(blobOrphans.reported_at), asc(blobOrphans.hash))
      .all();
    return rows.map((r) => r.hash);
  }

  async listLocations(hash: string): Promise<BlobLocation[]> {
    const rows = await this.db
      .select({
        store_id: blobLocations.store_id,
        kind: blobStores.kind,
        policy: blobStores.policy,
        detached_at: blobStores.detached_at,
        recorded_at: blobLocations.recorded_at,
        verified_at: blobLocations.verified_at,
      })
      .from(blobLocations)
      .innerJoin(blobStores, eq(blobLocations.store_id, blobStores.id))
      .where(eq(blobLocations.hash, hash))
      .orderBy(blobLocations.recorded_at)
      .all();
    return rows.map((row) => ({
      store_id: row.store_id,
      kind: row.kind as BlobStoreKind,
      policy: row.policy,
      detached: row.detached_at !== null,
      recorded_at: row.recorded_at,
      verified_at: row.verified_at,
    }));
  }
}
