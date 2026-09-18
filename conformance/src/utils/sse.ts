import { Agent, fetch as undiciFetch } from "undici";

/**
 * An open `GET /events` subscription plus the handle that tears it down.
 *
 * `response` is a standard `Response`; read live events off
 * `response.body`. Always `await close()` when done. It aborts the request
 * and disposes the stream's private connection pool, so a test file cannot
 * leak a socket into the next one.
 */
export interface EventStream {
  response: Response;
  close(): Promise<void>;
}

export interface OpenEventStreamOptions {
  /** Sent as the `Last-Event-ID` request header when set. */
  lastEventId?: string;
  /**
   * Give up if the server has not sent response headers within this many
   * milliseconds, rejecting instead of waiting indefinitely.
   *
   * Worth setting anywhere a hung subscribe would take down more than itself:
   * a caller in a `beforeAll` otherwise burns the whole hook timeout before
   * reporting anything useful.
   */
  connectTimeoutMs?: number;
  /**
   * Query parameters appended to `/events`.
   *
   * A repeated key is sent repeatedly rather than collapsed, because whether
   * the server reads one or all of them is a thing tests here ask about.
   */
  query?: Array<[string, string]>;
}

/**
 * Open the server's SSE event stream on a connection pool of its own.
 *
 * The dedicated pool is the whole point. Route a subscription through the
 * default pool instead and every test that writes while subscribed hangs.
 *
 * Node's built-in `fetch` negotiates HTTP/2 whenever the origin offers it,
 * and multiplexes every request to that origin onto one shared session.
 * Its dispatcher refuses to open a second stream for a request whose body
 * is a stream or async iterable while any other request on the session is
 * still in flight, because such a body cannot be replayed if the session
 * errors; it serializes the request behind whatever is already running.
 * `fetch` always presents a request body as an async iterable, and a
 * subscription counts as in flight for as long as it stays open. The two
 * combine into a deadlock: once a stream is open, every later `fetch`
 * carrying a body (so every POST, PUT and PATCH) queues behind it and
 * never departs the process. Bodyless GETs are exempt and keep working,
 * which is what makes the failure read as a server stall rather than a
 * client one.
 *
 * Giving the subscription its own `Agent` with HTTP/2 disabled keeps it on
 * a private HTTP/1.1 socket that nothing else shares, leaving the default
 * dispatcher idle and free to dispatch. The constraint is client-side
 * only: the server serves reads and writes concurrently over a single
 * HTTP/2 connection perfectly well, as a raw `node:http2` session against
 * the same host shows.
 */
export async function openEventStream(
  apiUrl: string,
  apiKey: string,
  options: OpenEventStreamOptions = {},
): Promise<EventStream> {
  const agent = new Agent({ allowH2: false, connect: { timeout: 30_000 } });
  const controller = new AbortController();
  const headers: Record<string, string> = {
    Authorization: `Bearer ${apiKey}`,
  };
  if (options.lastEventId !== undefined) {
    headers["Last-Event-ID"] = options.lastEventId;
  }
  const connectGuard =
    options.connectTimeoutMs === undefined
      ? undefined
      : setTimeout(() => controller.abort(), options.connectTimeoutMs);
  const search = new URLSearchParams();
  for (const [key, value] of options.query ?? []) search.append(key, value);
  const url = search.size
    ? `${apiUrl}/events?${search.toString()}`
    : `${apiUrl}/events`;
  let response: Response;
  try {
    response = (await undiciFetch(url, {
      headers,
      dispatcher: agent,
      signal: controller.signal,
    })) as unknown as Response;
  } catch (err) {
    await agent.close().catch(() => {
      /* pool already gone */
    });
    throw err;
  } finally {
    // Only the connect is bounded. Once headers are in, the caller owns the
    // stream for as long as it wants it.
    clearTimeout(connectGuard);
  }

  return {
    response,
    async close() {
      controller.abort();
      // destroy(), not close(): close() waits for in-flight requests to
      // settle, and the abort above may not have landed yet.
      await agent.destroy().catch(() => {
        /* pool already gone */
      });
    },
  };
}

/**
 * Minimal SSE (Server-Sent Events) stream parser for conformance tests.
 *
 * Splits a raw SSE text blob on blank-line boundaries and extracts the
 * `id:`, `event:`, and `data:` lines. Events without an `event:` line are
 * skipped — the conformance suite only exercises typed events. `data` is
 * JSON-parsed when possible, otherwise surfaced as the raw string.
 */
export interface SseEvent {
  id?: string;
  event: string;
  data: unknown;
}

export function parseSse(raw: string): SseEvent[] {
  const events: SseEvent[] = [];
  for (const block of raw.split(/\n\n/)) {
    const lines = block.split("\n");
    const id = (lines.find((l) => l.startsWith("id:")) ?? "")
      .replace("id:", "")
      .trim();
    const event = (lines.find((l) => l.startsWith("event:")) ?? "")
      .replace("event:", "")
      .trim();
    const data = (lines.find((l) => l.startsWith("data:")) ?? "")
      .replace("data:", "")
      .trim();
    if (!event) continue;
    let parsed: unknown = data;
    try {
      parsed = JSON.parse(data);
    } catch {
      /* leave as raw string */
    }
    const out: SseEvent = { event, data: parsed };
    if (id) out.id = id;
    events.push(out);
  }
  return events;
}
