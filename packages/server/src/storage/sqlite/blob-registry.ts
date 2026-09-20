import { and, eq, inArray, isNull, lt, not, sql } from "drizzle-orm";
import type {
  BlobLocation,
  BlobRegistry,
  BlobStoreKind,
  BlobStoreRow,
} from "../interface.js";
import { blobLocations, blobStores, blobs } from "./schema.js";
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

  async listRegisteredBefore(cutoff: string): Promise<string[]> {
    const rows = await this.db
      .select({ hash: blobs.hash })
      .from(blobs)
      .where(lt(blobs.created_at, cutoff))
      .all();
    return rows.map((r) => r.hash);
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

  async recordLocation(
    hash: string,
    storeId: string,
    verifiedAt?: string,
  ): Promise<void> {
    const insert = this.db.insert(blobLocations).values({
      hash,
      store_id: storeId,
      recorded_at: new Date().toISOString(),
      verified_at: verifiedAt ?? null,
    });
    if (verifiedAt === undefined) {
      await insert.onConflictDoNothing().run();
      return;
    }
    await insert
      .onConflictDoUpdate({
        target: [blobLocations.hash, blobLocations.store_id],
        set: { verified_at: verifiedAt },
      })
      .run();
  }

  async removeLocation(hash: string, storeId: string): Promise<void> {
    await this.db
      .delete(blobLocations)
      .where(
        and(eq(blobLocations.hash, hash), eq(blobLocations.store_id, storeId)),
      )
      .run();
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

  async countLiveCopies(hash: string): Promise<number> {
    const row = await this.db
      .select({ count: sql<number>`count(*)` })
      .from(blobLocations)
      .innerJoin(blobStores, eq(blobLocations.store_id, blobStores.id))
      .where(and(eq(blobLocations.hash, hash), isNull(blobStores.detached_at)))
      .get();
    return row?.count ?? 0;
  }
}
