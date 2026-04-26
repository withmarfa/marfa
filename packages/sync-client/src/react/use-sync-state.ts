import { useEffect, useState } from "react";
import type { SyncStateInfo } from "../sync/state.js";
import { useMymeSyncClient } from "./provider.js";

/**
 * Subscribe to sync-state transitions. Returns the latest snapshot;
 * re-renders when the engine moves between idle / syncing / offline /
 * error / starting.
 */
export function useSyncState(): SyncStateInfo {
  const client = useMymeSyncClient();
  const [info, setInfo] = useState<SyncStateInfo>(client.syncState);
  useEffect(() => {
    return client.observeSyncState((next) => {
      setInfo(next);
    });
  }, [client]);
  return info;
}
