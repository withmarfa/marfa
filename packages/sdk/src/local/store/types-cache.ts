import { sql } from "drizzle-orm";
import type { TypeSchema } from "@withmarfa/shared";
import type { Executor } from "./executor.js";
import { cachedTypes } from "./schema.js";

/**
 * The custom types this store holds, as rows.
 *
 * Only the rows: registering them into `@withmarfa/shared`'s registry is
 * `type-graph.ts`'s job, and reading `GET /types` is the client's. Kept
 * apart because the cache has to be readable with no network at all — a
 * store that opens on a plane validates against what it wrote down last
 * time, and nothing about that path should be able to reach a transport.
 */
export interface TypeCacheLayer {
  /** Every custom type held, in the order they were written. */
  list(): Promise<TypeSchema[]>;
  count(): Promise<number>;
  /**
   * Replace the whole cache with this listing.
   *
   * Replace rather than merge: `GET /types` answers with the whole
   * vocabulary, so anything absent from the payload is a type the server
   * no longer has. Merged in, it would stay behind and go on accepting
   * writes locally that the server refuses.
   */
  replace(types: readonly TypeSchema[], now: string): Promise<void>;
}

export function createTypeCacheLayer(exec: Executor): TypeCacheLayer {
  return {
    list: async () => {
      const rows = await exec
        .select({ payload: cachedTypes.payload })
        .from(cachedTypes);
      return rows.map((row) => JSON.parse(row.payload) as TypeSchema);
    },

    count: async () => {
      const rows = await exec
        .select({ total: sql<number>`count(*)` })
        .from(cachedTypes);
      return rows[0]?.total ?? 0;
    },

    replace: async (types, now) => {
      await exec.delete(cachedTypes);
      if (types.length === 0) return;
      await exec.insert(cachedTypes).values(
        types.map((schema) => ({
          id: schema.id,
          payload: JSON.stringify(schema),
          cachedAt: now,
        })),
      );
    },
  };
}
