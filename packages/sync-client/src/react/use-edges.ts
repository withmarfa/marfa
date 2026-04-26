import { useEffect, useState } from "react";
import type { Edge } from "@mymehq/shared";
import { useMymeSyncClient } from "./provider.js";

export interface UseEdgesFilters {
  source?: string;
  target?: string;
  edgeType?: string | string[];
  limit?: number;
}

export interface UseEdgesResult {
  data: Edge[];
  isLoading: boolean;
  error: Error | null;
}

/**
 * Live query over the local edges table. Filters by source, target,
 * and/or edge type; re-runs on any change to `edges`.
 */
export function useEdges(filters: UseEdgesFilters = {}): UseEdgesResult {
  const client = useMymeSyncClient();
  const [data, setData] = useState<Edge[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);

  useEffect(() => {
    let cancelled = false;
    let unsubscribe: (() => void) | null = null;

    const run = async () => {
      try {
        const refetch = async () => {
          let edges: Edge[];
          if (filters.source) {
            edges = await client.edges.listFromSource(filters.source, {
              edgeType: filters.edgeType,
              limit: filters.limit,
            });
          } else if (filters.target) {
            edges = await client.edges.listToTarget(filters.target, {
              edgeType: filters.edgeType,
              limit: filters.limit,
            });
          } else {
            edges = await client.edges.list({
              edgeType: filters.edgeType,
              limit: filters.limit,
            });
          }
          if (!cancelled) {
            setData(edges);
            setIsLoading(false);
            setError(null);
          }
        };

        await refetch();
        const liveQuery = await client.db.live.query<Edge>(
          `SELECT id FROM edges LIMIT 1`,
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
  }, [client, JSON.stringify(filters)]);

  return { data, isLoading, error };
}
