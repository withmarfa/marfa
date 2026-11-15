import {
  openEventStream,
  parseSse,
  type EventStream,
  type OpenEventStreamOptions,
} from "./sse.js";
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
 * Text read off a stream past where a wait stopped, with the decoder that
 * read it.
 *
 * A read returns whatever the socket delivered, which can run past the frame
 * a caller waited for and can end inside a frame, or inside a character. The
 * next wait on the same stream starts from this text and decoder so that no
 * frame is lost between two waits.
 */
const unread = new WeakMap<
  EventStream,
  { text: string; decoder: TextDecoder }
>();

/**
 * Read an open stream until `done` says enough has arrived.
 *
 * **An absence is settled by a later frame, never by a quiet window**, which
 * cannot tell "nothing more is coming" from "not yet". Write a sentinel item or edge
 * after the one under test and wait for the sentinel's own event here: the
 * stream delivers item and edge frames in id order (`events/ids-ascending`), so
 * a sentinel of either kind arriving is proof that everything published before
 * it has arrived or was withheld. Where the rule under test is whether edge
 * frames arrive at all, an item written after the edge is the sentinel, since a
 * sentinel edge could not arrive on a server that fails it.
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
  done: (events: SseEvent[]) => boolean,
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
  const left = unread.get(stream);
  unread.delete(stream);
  const decoder = left?.decoder ?? new TextDecoder();
  const carried = left?.text ?? "";
  const chunks: string[] = carried ? [carried] : [];
  // Parsed as frames complete rather than from the start on every chunk: a
  // replay can carry megabytes, and re-reading all of it per chunk makes a
  // long one slower than any budget.
  const events: SseEvent[] = [];
  let pending = carried;
  const carriedEnd = pending.lastIndexOf("\n\n");
  if (carriedEnd >= 0) {
    events.push(...parseSse(pending.slice(0, carriedEnd + 2)));
    pending = pending.slice(carriedEnd + 2);
  }
  const onAbort = () => void reader.cancel().catch(() => undefined);
  signal?.addEventListener("abort", onAbort, { once: true });

  // What follows the last complete frame stays for the next wait, and the
  // decoder with it, which can hold the first bytes of a character.
  const finish = (): CollectResult => {
    unread.set(stream, { text: pending, decoder });
    return { events, raw: chunks.join("") };
  };

  try {
    if (carried && done(events)) return finish();
    for (;;) {
      const { done: finished, value } = await reader.read();
      if (value) {
        const text = decoder.decode(value, { stream: true });
        chunks.push(text);
        pending += text;
        const end = pending.lastIndexOf("\n\n");
        if (end >= 0) {
          events.push(...parseSse(pending.slice(0, end + 2)));
          pending = pending.slice(end + 2);
        }
      }
      if (done(events)) return finish();
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
 * Read an open stream until its `stream_cursor` frame has arrived, and return
 * the cursor it names.
 *
 * The server sends that frame once it has read the log's head and is following
 * the log from there (`events/stream-cursor-first`), so a write made after it
 * returns is a write the stream sends (`events/stream-sends-after-cursor`).
 * Headers arriving says nothing of the kind: the response can start before the
 * head is read, and a fixed pause is a guess that a loaded runner outruns.
 *
 * The frame is consumed. Anything read past it stays for the next
 * `collectUntil` on the same stream.
 */
export async function awaitStreamCursor(
  stream: EventStream,
  signal?: AbortSignal,
): Promise<string> {
  const body = stream.response.body;
  if (!body) {
    throw new Error(
      `event stream returned no body (status ${stream.response.status})`,
    );
  }
  const reader = body.getReader();
  const left = unread.get(stream);
  unread.delete(stream);
  const decoder = left?.decoder ?? new TextDecoder();
  let text = left?.text ?? "";
  const onAbort = () => void reader.cancel().catch(() => undefined);
  signal?.addEventListener("abort", onAbort, { once: true });
  try {
    for (;;) {
      for (
        let end = text.indexOf("\n\n");
        end >= 0;
        end = text.indexOf("\n\n")
      ) {
        const frame = parseSse(text.slice(0, end + 2))[0];
        text = text.slice(end + 2);
        if (frame?.event === "stream_cursor") {
          const cursor = (frame.data as { cursor?: unknown }).cursor;
          if (typeof cursor !== "string") {
            throw new Error(
              `stream_cursor carried no cursor: ${JSON.stringify(frame.data)}`,
            );
          }
          unread.set(stream, { text, decoder });
          return cursor;
        }
      }
      const { done, value } = await reader.read();
      if (value) text += decoder.decode(value, { stream: true });
      if (done) {
        throw new Error(
          `event stream closed before its stream_cursor; saw ${describe(parseSse(text))}`,
        );
      }
    }
  } catch (err) {
    if (signal?.aborted) {
      throw new Error("timed out waiting for the stream's stream_cursor", {
        cause: err,
      });
    }
    throw err;
  } finally {
    signal?.removeEventListener("abort", onAbort);
    reader.releaseLock();
  }
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
  options: OpenEventStreamOptions,
  body: (stream: EventStream) => Promise<T>,
): Promise<T> {
  const stream = await openEventStream(apiUrl, apiKey, {
    connectTimeoutMs: 30_000,
    ...options,
  });
  try {
    return await body(stream);
  } finally {
    await stream.close();
  }
}

export interface StreamAtCursorOptions extends OpenEventStreamOptions {
  /** The test's `signal`, so an abort names the frame that never came. */
  signal?: AbortSignal;
}

/**
 * Open a stream, wait for its `stream_cursor`, and run `body` with the stream
 * and that cursor. Whatever `body` writes goes to a stream that is already
 * following the log.
 */
export async function withStreamAtCursor<T>(
  apiUrl: string,
  apiKey: string,
  { signal, ...options }: StreamAtCursorOptions,
  body: (stream: EventStream, cursor: string) => Promise<T>,
): Promise<T> {
  return withStream(apiUrl, apiKey, options, async (stream) =>
    body(stream, await awaitStreamCursor(stream, signal)),
  );
}

/**
 * The id of the newest event in the log, which is the cursor a stream
 * announces when it opens (`events/stream-cursor-head`).
 *
 * A replay test resumes from it to see exactly what is written afterwards. On
 * a log that holds no event it is `"0"`.
 */
export async function baselineEventId(
  apiUrl: string,
  apiKey: string,
  signal?: AbortSignal,
): Promise<string> {
  return withStreamAtCursor(
    apiUrl,
    apiKey,
    { signal },
    async (_stream, cursor) => cursor,
  );
}
