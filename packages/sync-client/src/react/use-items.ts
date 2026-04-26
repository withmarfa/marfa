import { useEffect, useState } from "react";
import type { Item, ItemState } from "@mymehq/shared";
import { useMymeSyncClient } from "./provider.js";

export interface UseItemsFilters {
  type?: string;
  state?: ItemState;
  source?: string;
  library?: boolean;
  /** Default 100; capped at 5_000. */
  limit?: number;
}

export interface UseItemsResult {
  data: Item[];
  isLoading: boolean;
  error: Error | null;
}

/**
 * Live query over the local items table. Re-runs and re-renders when
 * the underlying PGlite rows change — whether from local optimistic
 * writes or Electric-replicated server changes.
 *
 * v0.1 implementation: re-fetches on each change rather than diffing
 * incrementally. Performance is acceptable for the typical app's
 * working set; larger lists should narrow the filter or paginate.
 */
export function useItems(
  type: string | undefined,
  filters: UseItemsFilters = {},
): UseItemsResult {
  const client = useMymeSyncClient();
  const [data, setData] = useState<Item[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);

  useEffect(() => {
    let cancelled = false;
    let unsubscribe: (() => void) | null = null;

    const run = async (): Promise<void> => {
      try {
        const refetch = async () => {
          const list = await client.items.list({ ...filters, type });
          if (!cancelled) {
            setData(list);
            setIsLoading(false);
            setError(null);
          }
        };

        // Initial load.
        await refetch();

        // Live subscription — PGlite's live query fires when any row
        // in `items` changes (canonical layer, written by
        // pglite-sync). Optimistic in-memory writes don't touch
        // PGlite, so the live query alone misses them; subscribe to
        // the optimistic store too. Either signal triggers a
        // refetch; the merged read inside `client.items.list`
        // overlays both layers.
        const liveQuery = await client.db.live.query<Item>(
          `SELECT id FROM items LIMIT 1`,
          [],
          () => {
            refetch().catch(() => {
              // refetch errors are surfaced via setError above; here we
              // just need to satisfy no-floating-promises.
            });
          },
        );
        const unsubscribeOptimistic = client.observeOptimisticItems(() => {
          refetch().catch(() => {
            // surfaced via setError above
          });
        });
        unsubscribe = () => {
          void liveQuery.unsubscribe();
          unsubscribeOptimistic();
        };
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err : new Error(String(err)));
          setIsLoading(false);
        }
      }
    };

    void run();

    return () => {
      cancelled = true;
      unsubscribe?.();
    };
  }, [client, type, JSON.stringify(filters)]);

  return { data, isLoading, error };
}

export interface UseItemResult {
  data: Item | null;
  isLoading: boolean;
  error: Error | null;
}

export function useItem(id: string | undefined): UseItemResult {
  const client = useMymeSyncClient();
  const [data, setData] = useState<Item | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);

  useEffect(() => {
    if (!id) {
      setData(null);
      setIsLoading(false);
      return;
    }
    let cancelled = false;
    let unsubscribe: (() => void) | null = null;

    const run = async (): Promise<void> => {
      try {
        const refetch = async () => {
          const item = await client.items.get(id);
          if (!cancelled) {
            setData(item);
            setIsLoading(false);
            setError(null);
          }
        };
        await refetch();
        const liveQuery = await client.db.live.query<Item>(
          `SELECT id FROM items WHERE id = $1`,
          [id],
          () => {
            refetch().catch(() => {
              // refetch errors are surfaced via setError above; here we
              // just need to satisfy no-floating-promises.
            });
          },
        );
        // Re-render on optimistic changes too. We filter to this id
        // — the optimistic store fires per-id, so no other row's
        // change triggers an unnecessary refetch here.
        const unsubscribeOptimistic = client.observeOptimisticItems(
          (changedId) => {
            if (changedId !== id) return;
            refetch().catch(() => {
              // surfaced via setError above
            });
          },
        );
        unsubscribe = () => {
          void liveQuery.unsubscribe();
          unsubscribeOptimistic();
        };
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err : new Error(String(err)));
          setIsLoading(false);
        }
      }
    };

    void run();
    return () => {
      cancelled = true;
      unsubscribe?.();
    };
  }, [client, id]);

  return { data, isLoading, error };
}
