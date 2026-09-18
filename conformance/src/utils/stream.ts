import { openEventStream, parseSse, type EventStream } from "./sse.js";
import type { SseEvent } from "./sse.js";

/**
 * Event names the server emits for a data mutation.
 *
 * Used to tell a mutation event apart from any other typed frame the server
 * may send. The announced-cursor probe leans on that distinction: other files
 * in the run write to the same server, so a stream carries their mutations
 * too and "a typed frame arrived" cannot mean "the server announced
 * something", while "a typed frame arrived that is not a mutation" can.
 *
 * A server growing a new mutation event is the one way this list goes stale,
 * and the failure it produces is a loud one — the cursor probe reports
 * `present` against a server that announces nothing — rather than a quiet
 * one. That is the right direction for a list nobody will remember to update.
 */
export const MUTATION_EVENT_NAMES = new Set([
  "item.created",
  "item.updated",
  "item.deleted",
  "item.purged",
  "item.restored",
  "item.state_changed",
  "edge.created",
  "edge.updated",
  "edge.deleted",
  "metadata.changed",
]);

export interface CollectResult {
  events: SseEvent[];
  raw: string;
}

/**
 * Read an open stream until `done` says enough has arrived.
 *
 * The deadline belongs to the test runner, not to this helper. A hand-rolled
 * `Date.now()` bound re-emits a timeout as a logic failure: the assertion
 * below it reads `expected false to be true` with no elapsed figure and no
 * budget named, and the next reader studies a diff that is fine. The runner's
 * budget at least says `Test timed out` and names the file.
 *
 * What this does add is the missing half of that message. Pass the test's
 * `signal` and a timeout arrives here as an abort, so the throw can name what
 * the stream was waiting for and list what it actually received — which the
 * runner's own timeout cannot do.
 */
export async function collectUntil(
  stream: EventStream,
  done: (events: SseEvent[], raw: string) => boolean,
  waitingFor: string,
  signal?: AbortSignal,
): Promise<CollectResult> {
  const body = stream.response.body;
  if (!body) {
    throw new Error(
      `event stream for "${waitingFor}" returned no body (status ${stream.response.status})`,
    );
  }
  const reader = body.getReader();
  const decoder = new TextDecoder();
  const chunks: string[] = [];
  const onAbort = () => void reader.cancel().catch(() => undefined);
  signal?.addEventListener("abort", onAbort, { once: true });

  try {
    for (;;) {
      const { done: finished, value } = await reader.read();
      if (value) chunks.push(decoder.decode(value, { stream: true }));
      const raw = chunks.join("");
      const events = parseSse(raw);
      if (done(events, raw)) return { events, raw };
      if (finished) {
        throw new Error(
          `event stream closed before ${waitingFor}; saw ${describe(events)}`,
        );
      }
    }
  } catch (err) {
    // Never swallow this. A stream that ends for any reason other than the
    // predicate being met is a diagnosis, and discarding it leaves a test
    // reporting an empty event list with no account of why it is empty.
    const events = parseSse(chunks.join(""));
    if (signal?.aborted) {
      throw new Error(
        `timed out waiting for ${waitingFor}; saw ${describe(events)}`,
        { cause: err },
      );
    }
    throw err instanceof Error
      ? new Error(`${err.message} (while waiting for ${waitingFor})`, {
          cause: err,
        })
      : new Error(`event stream failed while waiting for ${waitingFor}`, {
          cause: err,
        });
  } finally {
    signal?.removeEventListener("abort", onAbort);
    reader.releaseLock();
  }
}

function describe(events: SseEvent[]): string {
  if (events.length === 0) return "no typed events";
  const counts = new Map<string, number>();
  for (const e of events) counts.set(e.event, (counts.get(e.event) ?? 0) + 1);
  return [...counts].map(([name, n]) => `${name} x${n}`).join(", ");
}

/**
 * Read whatever a stream has already delivered, without waiting for more.
 *
 * **A quiet window cannot tell "nothing more is coming" from "not yet", so
 * prefer an observation wherever one is constructible.** That means writing a
 * sentinel row after the one under test and waiting for the sentinel's own
 * event through `collectUntil`: the runner owns the deadline, and a sentinel
 * that has arrived is proof that anything published before it has arrived too.
 *
 * **The proof holds only between frames of the same kind.** Item events and
 * edge events reach a subscriber through independent pipelines, so their
 * relative order is not a guarantee the stream makes — an item sentinel says
 * nothing about whether an edge frame is still to come. Where the frame in
 * question is an edge and the sentinel would have to be an item, or where the
 * rule under test is precisely whether edge frames arrive at all (so a
 * sentinel edge could not arrive either), no such observation exists and this
 * helper's window is what remains. Every caller left on it is one of those,
 * and each says so at its call site.
 *
 * Its other use is the settling window after a `collectUntil`, where an event
 * that follows the one the predicate matched is usually already in the socket
 * buffer and reading it costs a few hundred milliseconds rather than a
 * decision.
 */
export async function drainAvailable(
  stream: EventStream,
  quietMs: number,
  signal?: AbortSignal,
): Promise<CollectResult> {
  const body = stream.response.body;
  if (!body) {
    throw new Error(
      `event stream returned no body (status ${stream.response.status})`,
    );
  }
  const reader = body.getReader();
  const decoder = new TextDecoder();
  const chunks: string[] = [];
  const onAbort = () => void reader.cancel().catch(() => undefined);
  signal?.addEventListener("abort", onAbort, { once: true });

  try {
    for (;;) {
      // Cleared on every path out of the race. Left running, a chatty stream
      // accumulates one live timer per chunk, and the process then waits on
      // them after the suite has finished with the stream.
      let timer: ReturnType<typeof setTimeout> | undefined;
      const quiet = new Promise<"quiet">((resolve) => {
        timer = setTimeout(() => resolve("quiet"), quietMs);
      });
      const next = reader.read();
      const winner = await Promise.race([next, quiet]);
      clearTimeout(timer);
      if (winner === "quiet") {
        // The pending read is abandoned deliberately; cancel() below settles
        // it. Leaving it pending would keep the socket's reader locked.
        void next.catch(() => undefined);
        break;
      }
      if (winner.value) {
        chunks.push(decoder.decode(winner.value, { stream: true }));
      }
      if (winner.done) break;
    }
  } finally {
    signal?.removeEventListener("abort", onAbort);
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
  const raw = chunks.join("");
  return { events: parseSse(raw), raw };
}

/**
 * Open a stream, run `body` with it, and close it however `body` ends.
 *
 * Every subscription in this suite goes through here. An abandoned stream is
 * not merely untidy: `openEventStream` gives each one a connection pool of its
 * own, and a pool that is never destroyed keeps a socket open for the life of
 * the process.
 */
export async function withStream<T>(
  apiUrl: string,
  apiKey: string,
  options: { lastEventId?: string; query?: Array<[string, string]> },
  body: (stream: EventStream) => Promise<T>,
): Promise<T> {
  const stream = await openEventStream(apiUrl, apiKey, {
    connectTimeoutMs: 30_000,
    ...(options.lastEventId === undefined
      ? {}
      : { lastEventId: options.lastEventId }),
    ...(options.query ? { query: options.query } : {}),
  });
  try {
    return await body(stream);
  } finally {
    await stream.close();
  }
}

/**
 * The id of the newest event on the stream, established by writing one.
 *
 * A replay test needs a point to resume from, and the server offers no route
 * that reports its current cursor, so the only way to learn an id is to cause
 * an event and read the id the server gave it.
 *
 * The marker write is a real item, so the caller tracks it for teardown.
 */
export async function baselineEventId(
  apiUrl: string,
  apiKey: string,
  makeMarker: () => Promise<string>,
  signal?: AbortSignal,
): Promise<{ eventId: string; markerId: string }> {
  return withStream(apiUrl, apiKey, {}, async (stream) => {
    // Let the subscription settle before the write, or the event it is meant
    // to observe is published to nobody.
    await new Promise((r) => setTimeout(r, 250));
    const markerId = await makeMarker();
    const { events } = await collectUntil(
      stream,
      (evts) =>
        evts.some(
          (e) => (e.data as { item?: { id?: string } })?.item?.id === markerId,
        ),
      `the marker item ${markerId} to reach the stream`,
      signal,
    );
    const marker = events.find(
      (e) => (e.data as { item?: { id?: string } })?.item?.id === markerId,
    );
    if (!marker?.id) {
      throw new Error(
        `marker event for ${markerId} carried no SSE id, so no replay point can be taken`,
      );
    }
    return { eventId: marker.id, markerId };
  });
}
