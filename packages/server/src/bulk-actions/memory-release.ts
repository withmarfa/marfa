import { Session } from "node:inspector";
import { getHeapStatistics } from "node:v8";

// A burst of writes grows V8's heap to several times the data it holds, and V8
// keeps those pages until a later collection that, on a server that is never
// idle, can be minutes away. The process then sits at its peak: one
// 5,000-entry page took a started server from 320 MB to over 600 MB, and it
// stayed there. `gc()` does not hand the pages back; the low-memory
// notification the inspector's `HeapProfiler.collectGarbage` sends does, and
// the inspector is the one way to send it from JavaScript.

/** How long bulk work must have stopped before the heap is collected. */
const QUIET_MS = 2_000;
/** The heap growth during a burst below which a collection is not worth its pause. */
const GROWTH_BYTES = 64 * 1024 * 1024;

let timer: ReturnType<typeof setTimeout> | undefined;
/** The committed heap when the current burst began. */
let heapAtStart = 0;

/**
 * Notes that bulk work has just run. The heap is collected once none has run
 * for a short while, so a client sending pages back to back is collected after
 * its last page and not between them.
 */
export function noteBulkWork(): void {
  if (timer) clearTimeout(timer);
  else heapAtStart = getHeapStatistics().total_heap_size;
  timer = setTimeout(releaseMemory, QUIET_MS);
  // A collection is never a reason to keep a stopping process alive.
  timer.unref();
}

function releaseMemory(): void {
  timer = undefined;
  if (getHeapStatistics().total_heap_size - heapAtStart < GROWTH_BYTES) return;
  const session = new Session();
  try {
    session.connect();
    // The command runs after this call returns, so the session stays open
    // until it answers. Disconnecting inside the answer's own callback stalls
    // the process, so it waits for the next turn of the loop.
    session.post("HeapProfiler.collectGarbage", () => {
      setImmediate(() => {
        session.disconnect();
      });
    });
  } catch {
    // Handing memory back is an optimization, and a runtime without the
    // inspector simply keeps it.
    session.disconnect();
  }
}
