/**
 * The event streams open on this process, so a stop can end each with its
 * closing frame instead of cutting the connection.
 *
 * Module state, as the event log's is: one process serves one instance, and
 * the stop is a property of the process.
 */
type EndStream = () => void;

const open = new Set<EndStream>();
let stopping = false;

/**
 * Registers a stream. The returned function takes it out again, and a
 * stream that ends by any other means calls it. A stream that opens once
 * the stop has begun is ended at once.
 */
export function trackStream(end: EndStream): () => void {
  if (stopping) {
    queueMicrotask(end);
    return () => undefined;
  }
  open.add(end);
  return () => {
    open.delete(end);
  };
}

/**
 * Ends every open stream, each with `stream_incomplete` and the reason
 * `server_stopping`, and answers how many it ended. One that cannot be
 * ended leaves the others alone.
 */
export function endOpenStreams(): number {
  stopping = true;
  const streams = [...open];
  open.clear();
  for (const end of streams) {
    try {
      end();
    } catch {
      // A stream whose connection is already gone has nothing to be told.
    }
  }
  return streams.length;
}

/** Forgets that a stop began, so a test can open streams again. */
export function resetOpenStreamsForTesting(): void {
  stopping = false;
  open.clear();
}
