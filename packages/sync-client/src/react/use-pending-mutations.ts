import { useEffect, useState } from "react";
import { useMymeSyncClient } from "./provider.js";

export interface PendingMutationsInfo {
  count: number;
  oldest: Date | null;
}

/**
 * Track the durable mutation queue. The hook polls every 500 ms by
 * default — the queue is small enough that polling beats wiring an
 * event-driven path through PGlite triggers; revisit if profiling
 * shows pressure.
 */
export function usePendingMutations(
  pollIntervalMs = 500,
): PendingMutationsInfo {
  const client = useMymeSyncClient();
  const [info, setInfo] = useState<PendingMutationsInfo>({
    count: 0,
    oldest: null,
  });

  useEffect(() => {
    let cancelled = false;
    const tick = async () => {
      try {
        const count = await client.pendingMutationCount();
        if (!cancelled) {
          setInfo({ count, oldest: null });
        }
      } catch {
        // ignore — reads on a closed PGlite are expected during teardown
      }
    };
    void tick();
    const handle = setInterval(() => {
      void tick();
    }, pollIntervalMs);
    return () => {
      cancelled = true;
      clearInterval(handle);
    };
  }, [client, pollIntervalMs]);

  return info;
}
