import { AsyncResource } from "node:async_hooks";

// Imported at server startup, before requests exist. Capturing at a wake or
// at lazy worker construction would retain the caller's authority and writer.
const background = new AsyncResource("marfa-background");

/** Only server-owned work belongs here; request admission stays in its caller. */
export function runInBackground<T>(work: () => T): T {
  return background.runInAsyncScope(work);
}
