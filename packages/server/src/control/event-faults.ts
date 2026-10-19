import type { EdgeEvent } from "../pubsub.js";
import type { EventLogStore, PersistedEvent } from "../storage/interface.js";
import { failRead } from "../storage/sqlite/injected-failure.js";
import { failAt, holdAt } from "./faults.js";

/** Construct only while faults are armed: the ordinary stream needs no wrapper. */
export function createFaultedHeadRead(
  store: EventLogStore,
): () => Promise<bigint | null> {
  return async () => {
    await holdAt("stream-head");
    failRead("stream-head");
    return await store.getMaxId();
  };
}

/** Corrupt only this replay read; the stored row and its live twin stay intact. */
export function replayRowsUnderFaults(
  rows: PersistedEvent[],
): PersistedEvent[] {
  return rows.map((row) =>
    failAt("stream-replay-row") ? { ...row, payload: "not json" } : row,
  );
}

/** The same unclassifiable event must reach persistence and live announcement. */
export function edgeUnderFaults(event: EdgeEvent): EdgeEvent {
  if (!failAt("edge-source-type")) return event;
  const untyped = { ...event };
  delete untyped.sourceType;
  return untyped;
}
