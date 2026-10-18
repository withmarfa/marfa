import {
  openEventStream,
  parseSse,
  type EventStream,
  type OpenEventStreamOptions,
  type SseEvent,
} from "./sse.js";

/**
 * An open event stream read in the background, so a fixture can hold the
 * server at a point, write, and look at what arrived without a reader of its
 * own waiting on each step. Every frame the stream sends is kept in order.
 */
export interface StreamTap {
  /** Every frame received so far, in order. */
  readonly events: SseEvent[];
  /** The response status. */
  readonly status: number;
  /** Whether the server has closed the body. */
  readonly closed: boolean;
  /** Resolves with every frame once `done` holds of them; rejects after `timeoutMs` or when the stream closes first. */
  until(
    done: (events: SseEvent[]) => boolean,
    waitingFor: string,
    timeoutMs?: number,
  ): Promise<SseEvent[]>;
  /** Resolves once the server has closed the body. */
  untilClosed(timeoutMs?: number): Promise<void>;
  /** Ends the request. */
  close(): Promise<void>;
}

const DEFAULT_WAIT_MS = 30_000;

function names(events: SseEvent[]): string {
  return events.length === 0
    ? "no frames"
    : events.map((event) => event.event).join(", ");
}

/** Opens a stream and reads it until it closes or the fixture closes it. */
export async function tapStream(
  apiUrl: string,
  apiKey: string,
  options: OpenEventStreamOptions = {},
): Promise<StreamTap> {
  const stream: EventStream = await openEventStream(apiUrl, apiKey, {
    connectTimeoutMs: DEFAULT_WAIT_MS,
    ...options,
  });
  const events: SseEvent[] = [];
  const state = { closed: false };
  const listeners = new Set<() => void>();
  const wake = () => {
    for (const listener of [...listeners]) listener();
  };

  void (async () => {
    const body = stream.response.body;
    if (!body) {
      state.closed = true;
      wake();
      return;
    }
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let pending = "";
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (value) {
          pending += decoder.decode(value, { stream: true });
          const end = pending.lastIndexOf("\n\n");
          if (end >= 0) {
            events.push(...parseSse(pending.slice(0, end + 2)));
            pending = pending.slice(end + 2);
            wake();
          }
        }
        if (done) break;
      }
    } catch {
      // The fixture closed the stream, or the server cut it.
    } finally {
      state.closed = true;
      wake();
    }
  })();

  const waitUntil = (
    ready: () => boolean,
    describeWait: string,
    timeoutMs: number,
  ): Promise<void> =>
    new Promise((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const check = () => {
        if (ready()) {
          finish();
          resolve();
        } else if (state.closed) {
          finish();
          reject(
            new Error(
              `the stream closed before ${describeWait}; it carried ${names(events)}`,
            ),
          );
        }
      };
      const finish = () => {
        listeners.delete(check);
        if (timer !== undefined) clearTimeout(timer);
      };
      timer = setTimeout(() => {
        finish();
        reject(
          new Error(
            `timed out after ${String(timeoutMs)}ms waiting for ${describeWait}; the stream carried ${names(events)}`,
          ),
        );
      }, timeoutMs);
      listeners.add(check);
      check();
    });

  return {
    events,
    status: stream.response.status,
    get closed() {
      return state.closed;
    },
    async until(done, waitingFor, timeoutMs = DEFAULT_WAIT_MS) {
      await waitUntil(() => done(events), waitingFor, timeoutMs);
      return events;
    },
    async untilClosed(timeoutMs = DEFAULT_WAIT_MS) {
      await waitUntil(() => state.closed, "the stream to close", timeoutMs);
    },
    close: () => stream.close(),
  };
}

/** The ids of the item a frame carries, or undefined. */
export const itemIdOf = (event: SseEvent): string | undefined =>
  (event.data as { item?: { id?: string } }).item?.id;

/** Whether a frame announces `id`'s item. */
export const announces =
  (id: string) =>
  (event: SseEvent): boolean =>
    itemIdOf(event) === id;

/** The cursor a fresh stream announces: the head of the log as the server reads it now. */
export async function streamHead(
  apiUrl: string,
  apiKey: string,
): Promise<string> {
  const tap = await tapStream(apiUrl, apiKey);
  try {
    const events = await tap.until(
      (seen) => seen.some((event) => event.event === "stream_cursor"),
      "the frame announcing the stream's position",
    );
    return (
      events.find((event) => event.event === "stream_cursor")!.data as {
        cursor: string;
      }
    ).cursor;
  } finally {
    await tap.close();
  }
}
