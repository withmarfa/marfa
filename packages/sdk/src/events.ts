/**
 * Typed subscription to the server's `GET /events` stream.
 *
 * The stream is Server-Sent Events, but `EventSource` cannot carry an
 * `Authorization` header, so every client that reaches for the obvious API
 * has to fall back to a query-string credential or a cookie. This helper
 * streams the response through `fetch` instead, which keeps the credential in
 * the header where it belongs and lets the transport's own 401-refresh path
 * apply.
 *
 * Three details are what make a hand-rolled subscriber wrong rather than
 * merely verbose, and they are the reason this exists:
 *
 *  - **Frames split across chunks.** A `ReadableStream` chunk boundary falls
 *    wherever the network puts it, routinely mid-frame and even mid-UTF-8
 *    sequence. Parsing per chunk drops or corrupts events under exactly the
 *    load that makes them matter.
 *  - **`catchup_too_old` is terminal and means "your cursor is unusable".**
 *    The server sends it when the requested `Last-Event-ID` predates the
 *    retention window, then closes. Reconnecting with the same cursor loops
 *    forever; reconnecting silently without one looks fine and quietly skips
 *    every event in the gap. The only correct response is to re-read state and
 *    resume from nothing, so this surfaces as its own callback rather than an
 *    error the caller is likely to swallow.
 *  - **The cursor advances when a frame is accounted for, not when it
 *    arrives.** A frame is accounted for once `onEvent` has resolved, or once
 *    the subscriber has decided not to deliver it: an empty payload, or one
 *    that would not parse and was reported instead. A frame whose handler
 *    rejected is not accounted for, so a reconnect replays it.
 *
 *    That makes delivery at-least-once, and the asymmetry is what decides it:
 *    a caller who wants at-most-once writes a `try`/`catch` inside their
 *    handler, one line, visible where they read it. A caller who wants
 *    at-least-once out of an at-most-once subscriber cannot express it at all,
 *    because the cursor has already moved by the time they see the failure.
 */

import type { Edge, Item, Metadata } from "@withmarfa/shared";
import type { HttpTransport } from "./transport.js";

/** An item-shaped event. `metadata.changed` carries the sidecar too. */
export interface MarfaItemEvent {
  type:
    | "item.created"
    | "item.updated"
    | "item.deleted"
    | "item.restored"
    | "item.state_changed"
    | "metadata.changed";
  item: Item;
  metadata?: Metadata;
}

/** An edge lifecycle event. */
export interface MarfaEdgeEvent {
  type: "edge.created" | "edge.deleted";
  edge: Edge;
}

export type MarfaEvent = MarfaItemEvent | MarfaEdgeEvent;

/** Why the stream ended, when it ended for a reason worth naming. */
export interface CatchupTooOld {
  /** Oldest event id the server can still serve. */
  min_retained_id: string;
  /** The cursor that was asked for. */
  requested: string;
}

export interface SubscribeOptions {
  /** Server-side type filter, matching `GET /events?type=`. */
  type?: string;
  /**
   * Resume cursor. Pass the last `eventId` seen in a previous run to replay
   * everything since. Omit to receive only events from now on.
   */
  lastEventId?: string;
  /**
   * Called for each event, in stream order. Awaited before the next frame is
   * read, so a slow handler applies backpressure rather than interleaving,
   * and awaited before the cursor advances, so a handler that rejects has its
   * event replayed on the next connection. Catch inside the handler if you
   * would rather drop it.
   */
  onEvent: (
    event: MarfaEvent,
    eventId: string | undefined,
  ) => void | Promise<void>;
  /** Called once per successful connection, including reconnections. */
  onOpen?: () => void;
  /**
   * Called when the cursor is too old to serve. The subscription has stopped.
   * Re-read the state you care about, then subscribe again without a
   * `lastEventId`. If omitted, this is escalated to `onError` rather than
   * being passed over in silence.
   */
  onCatchupTooOld?: (info: CatchupTooOld) => void;
  /**
   * Called on a connection failure, on a handler that rejected, and on a
   * frame whose payload would not parse. The first two reconnect afterwards
   * unless `reconnect` is false or the signal has aborted; an unparseable
   * frame is skipped and the same connection carries on, because replaying it
   * could only fail in the same place.
   */
  onError?: (error: unknown) => void;
  /** Reconnect with exponential backoff. `false` stops at the first failure.
   *  Defaults to enabled. */
  reconnect?: boolean;
  /** First backoff delay in ms. Default 500. */
  initialRetryMs?: number;
  /** Backoff ceiling in ms. Default 30000. */
  maxRetryMs?: number;
  /** Cancels the subscription. */
  signal?: AbortSignal;
}

export interface Subscription {
  /** Resolves once the stream has stopped for good. Rejects only if a
   *  non-reconnecting subscription failed. */
  closed: Promise<void>;
  /** Stops the subscription. Idempotent. */
  close: () => void;
  /** The most recent event id accounted for. Persist it to resume later. */
  readonly lastEventId: string | undefined;
}

const DEFAULT_INITIAL_RETRY_MS = 500;
const DEFAULT_MAX_RETRY_MS = 30_000;

/** Thrown when the stream ends because the resume cursor predates retention
 *  and the caller supplied no `onCatchupTooOld` to handle it. */
export class CatchupTooOldError extends Error {
  readonly code = "catchup_too_old";
  readonly minRetainedId: string;
  readonly requested: string;
  constructor(info: CatchupTooOld) {
    super(
      `Resume cursor ${info.requested} is older than the retained event log ` +
        `(oldest is ${info.min_retained_id}). Re-read state and resubscribe ` +
        `without a lastEventId.`,
    );
    this.name = "CatchupTooOldError";
    this.minRetainedId = info.min_retained_id;
    this.requested = info.requested;
  }
}

/** One decoded SSE frame. */
interface SseFrame {
  id?: string;
  event?: string;
  data: string;
}

/**
 * Incremental SSE frame parser.
 *
 * Fed arbitrary string slices, it yields whole frames only. Exported for the
 * tests, which is the point: chunk-boundary handling is the part most likely
 * to be wrong and the part least likely to fail visibly in normal use.
 */
export class SseParser {
  private buffer = "";

  push(chunk: string): SseFrame[] {
    this.buffer += chunk;
    const frames: SseFrame[] = [];
    // Frames are separated by a blank line. Normalize CRLF first so a server
    // or proxy using \r\n does not leave a stray \r on every field value.
    this.buffer = this.buffer.replace(/\r\n/g, "\n");
    let sep = this.buffer.indexOf("\n\n");
    while (sep !== -1) {
      const raw = this.buffer.slice(0, sep);
      this.buffer = this.buffer.slice(sep + 2);
      const frame = parseFrame(raw);
      if (frame) frames.push(frame);
      sep = this.buffer.indexOf("\n\n");
    }
    return frames;
  }
}

function parseFrame(raw: string): SseFrame | null {
  let id: string | undefined;
  let event: string | undefined;
  const dataLines: string[] = [];
  for (const line of raw.split("\n")) {
    // Comments carry the keep-alive pings and nothing else. Treating one as a
    // field would produce a frame with no data on every ping.
    if (line.startsWith(":")) continue;
    const colon = line.indexOf(":");
    const field = colon === -1 ? line : line.slice(0, colon);
    // A single leading space after the colon is part of the framing, not the value.
    let value = colon === -1 ? "" : line.slice(colon + 1);
    if (value.startsWith(" ")) value = value.slice(1);
    if (field === "id") id = value;
    else if (field === "event") event = value;
    else if (field === "data") dataLines.push(value);
  }
  if (dataLines.length === 0 && id === undefined) return null;
  return { id, event, data: dataLines.join("\n") };
}

/**
 * Subscribe to the change stream.
 *
 * Not exported at the package root as a bare function: reach it through
 * `client.events.subscribe`.
 */
export function subscribeToEvents(
  transport: HttpTransport,
  options: SubscribeOptions,
): Subscription {
  const {
    type,
    onEvent,
    onOpen,
    onCatchupTooOld,
    onError,
    reconnect = true,
    initialRetryMs = DEFAULT_INITIAL_RETRY_MS,
    maxRetryMs = DEFAULT_MAX_RETRY_MS,
    signal,
  } = options;

  const controller = new AbortController();
  if (signal) {
    if (signal.aborted) controller.abort();
    else
      signal.addEventListener("abort", () => {
        controller.abort();
      });
  }

  let lastEventId = options.lastEventId;

  // The controller is the single record of whether this subscription is still
  // running. An extra boolean beside it would be a second source of truth for
  // one fact, and the two can disagree: the caller's own signal aborts the
  // controller without passing through anything the subscription runs.
  const close = (): void => {
    controller.abort();
  };
  const stopped = (): boolean => controller.signal.aborted;

  const closed = (async (): Promise<void> => {
    let retryMs = initialRetryMs;

    while (!stopped()) {
      // Where the cursor stood when this attempt began, so the backoff can be
      // reset on progress rather than on connect. A connection that opened,
      // delivered nothing and died is not evidence the endpoint is healthy;
      // one that moved the cursor is.
      const cursorAtConnect = lastEventId;
      const acknowledge = (id: string | undefined): void => {
        if (id !== undefined) lastEventId = id;
      };

      try {
        const headers: Record<string, string> = { Accept: "text/event-stream" };
        if (lastEventId !== undefined) headers["Last-Event-ID"] = lastEventId;

        const response = await transport.rawRequest("GET", "/events", {
          query: type === undefined ? undefined : { type },
          headers,
          signal: controller.signal,
        });

        if (!response.ok || !response.body) {
          throw new Error(
            `Event stream failed: HTTP ${String(response.status)}`,
          );
        }

        onOpen?.();

        const terminal = await readStream(response.body, {
          onFrame: async (frame) => {
            if (frame.event === "catchup_too_old") {
              // Not acknowledged: the cursor is about to be thrown away, and
              // pointing it at the frame that said it was unusable would be
              // the one value guaranteed to fail again.
              return JSON.parse(frame.data) as CatchupTooOld;
            }

            if (frame.data !== "") {
              let parsed: MarfaEvent;
              try {
                parsed = JSON.parse(frame.data) as MarfaEvent;
              } catch (err) {
                // A payload that will not parse now will not parse on a
                // replay either, so leaving the cursor behind it means
                // reconnecting into the same failure for ever. Report it and
                // move past it: skipping one unreadable frame is recoverable,
                // and a stream that can never advance is not.
                onError?.(err);
                acknowledge(frame.id);
                return undefined;
              }
              // Awaited before the cursor moves. A handler that rejects
              // leaves the cursor behind this frame, so the reconnect
              // replays it.
              await onEvent(parsed, frame.id);
            }

            acknowledge(frame.id);
            return undefined;
          },
        });

        if (terminal) {
          // Terminal by definition: the cursor cannot be served, so retrying
          // with it loops and retrying without it skips the gap silently.
          // Drop the cursor so nothing can accidentally resume from it.
          lastEventId = undefined;
          controller.abort();
          if (onCatchupTooOld) onCatchupTooOld(terminal);
          else throw new CatchupTooOldError(terminal);
          return;
        }

        // The stream ended cleanly without a terminal event, which means the
        // server or an intermediary closed it. Reconnect if allowed.
        if (!reconnect || stopped()) return;
      } catch (err) {
        // Checked before the stopped guard below: reaching this point aborts
        // the controller first, so testing that guard first would swallow the
        // very error the caller has to see.
        if (err instanceof CatchupTooOldError) throw err;
        if (stopped()) return;
        onError?.(err);
        if (!reconnect) throw err;
      }

      if (stopped()) return;
      if (lastEventId !== cursorAtConnect) retryMs = initialRetryMs;
      await sleep(jitter(retryMs), controller.signal);
      retryMs = Math.min(retryMs * 2, maxRetryMs);
    }
  })();

  return {
    closed,
    close,
    get lastEventId(): string | undefined {
      return lastEventId;
    },
  };
}

async function readStream(
  body: ReadableStream<Uint8Array>,
  handlers: {
    onFrame: (frame: SseFrame) => Promise<CatchupTooOld | undefined>;
  },
): Promise<CatchupTooOld | undefined> {
  const reader = body.getReader();
  // `stream: true` is what makes a multi-byte character split across a chunk
  // boundary decode correctly instead of becoming a replacement character.
  const decoder = new TextDecoder("utf-8");
  const parser = new SseParser();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return undefined;
      const frames = parser.push(decoder.decode(value, { stream: true }));
      for (const frame of frames) {
        const terminal = await handlers.onFrame(frame);
        if (terminal) return terminal;
      }
    }
  } finally {
    try {
      await reader.cancel();
    } catch {
      // Already closed by the abort that brought us here.
    }
  }
}

/** Spread reconnect attempts so a server restart does not bring every client
 *  back in the same millisecond. */
function jitter(ms: number): number {
  return ms / 2 + Math.random() * (ms / 2);
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(finish, ms);
    function finish(): void {
      clearTimeout(timer);
      signal.removeEventListener("abort", finish);
      resolve();
    }
    signal.addEventListener("abort", finish);
  });
}
