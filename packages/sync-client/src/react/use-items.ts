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

    const run = async () => {
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

        // Live subscription — PGlite's live.changes fires when any row
        // in `items` changes. We don't bother filtering at this layer;
        // the refetch is cheap and the filter is reapplied there.
        const liveQuery = await client.db.live.query<Item>(
          `SELECT id FROM items LIMIT 1`,
          [],
          () => {
            void refetch();
          },
        );
        unsubscribe = () => {
          liveQuery.unsubscribe();
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

    const run = async () => {
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
            void refetch();
          },
        );
        unsubscribe = () => {
          liveQuery.unsubscribe();
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
