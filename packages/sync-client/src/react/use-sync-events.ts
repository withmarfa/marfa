import { useEffect, useState } from "react";
import type { SyncEventMap, SyncEventName } from "../events/types.js";
import { useMymeSyncClient } from "./provider.js";

export interface UseSyncEventsResult<K extends SyncEventName> {
  /** Latest event of type `K`, or `null` if none has fired yet. */
  latest: SyncEventMap[K] | null;
}

/**
 * Subscribe to a single sync-event type. Returns the latest payload;
 * re-renders on each new event.
 */
export function useSyncEvents<K extends SyncEventName>(
  event: K,
): UseSyncEventsResult<K> {
  const client = useMymeSyncClient();
  const [latest, setLatest] = useState<SyncEventMap[K] | null>(null);
  useEffect(() => {
    return client.on(event, (payload) => {
      setLatest(payload);
    });
  }, [client, event]);
  return { latest };
}
