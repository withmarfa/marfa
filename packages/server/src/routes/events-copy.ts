import { EVENT_LIMITS } from "./_event-limits.js";
import type { Context } from "hono";
import { ErrorCode, MarfaError, type Item } from "@withmarfa/shared";
import type { AppEnv } from "../middleware/auth.js";
import {
  checkReachesSomeType,
  mayReadType,
  requireAuth,
} from "../middleware/auth.js";
import {
  invalidReadViewRequest,
  requestReadView,
} from "../middleware/read-view.js";
import { deriveKey, SECRET_INFO } from "../crypto/derive-key.js";
import {
  frameFor,
  storedFrame,
  subscribeAll,
  type LiveFrame,
  wireEventName,
} from "../pubsub.js";
import { withPreparedHeaders } from "../prepared-headers.js";
import {
  itemListed,
  readViewAuthority,
  type ReadViewAuthority,
} from "../storage/read-view.js";
import type { PersistedEvent, Storage } from "../storage/interface.js";
import { announcedEdgeReadable } from "./_edge-visibility.js";
import {
  itemFrameFor,
  decodeStoredEdge,
  type EventRoutesOptions,
} from "./events.js";

const BATCH_SIZE = EVENT_LIMITS.replayBatchSize;
const MAX_HELD_FRAMES = BATCH_SIZE;
const MAX_EVENT_ID = 9223372036854775807n;
const COPY_EVENT_TYPES = new Set(
  (
    [
      "created",
      "updated",
      "deleted",
      "restored",
      "purged",
      "state_changed",
      "metadata_changed",
      "edge_created",
      "edge_updated",
      "edge_deleted",
    ] as const
  ).map(wireEventName),
);
type Incomplete =
  | "replay_failed"
  | "backlog_overflow"
  | "live_delivery_failed"
  | "credential_ended"
  | "reader_behind";

export function copyStreamRequest(c: Context<AppEnv>): {
  after: bigint | null;
  expected?: string;
} {
  const query = new URL(c.req.raw.url).searchParams;
  if (
    query.size !== 2 ||
    query.getAll("edges").length !== 1 ||
    query.get("edges") !== "all" ||
    query.getAll("copy").length !== 1 ||
    query.get("copy") !== "1"
  )
    throw invalidReadViewRequest(
      "Copy streams require exactly edges=all&copy=1",
    );
  const expected = requestReadView(c);
  const raw = c.req.header("Last-Event-ID");
  if ((expected === undefined) !== (raw === undefined))
    throw invalidReadViewRequest(
      "Copy resume requires both Last-Event-ID and X-Marfa-Read-View",
    );
  if (raw === undefined) return { after: null };
  if (!/^(?:0|[1-9][0-9]{0,18})$/.test(raw) || BigInt(raw) > MAX_EVENT_ID)
    throw invalidReadViewRequest(
      "Last-Event-ID must be exactly one canonical decimal event ID",
    );
  return { after: BigInt(raw), expected };
}

function project(
  stored: Record<string, unknown>,
  authority: ReadViewAuthority,
): string | null {
  if (typeof stored.type !== "string" || !COPY_EVENT_TYPES.has(stored.type))
    throw new Error("Unclassifiable event type");
  if (stored.type.startsWith("edge.")) {
    const decoded = decodeStoredEdge(JSON.stringify(stored));
    if (decoded?.sourceType === undefined)
      throw new Error("Unclassifiable edge event");
    return announcedEdgeReadable(
      authority.key,
      decoded.edge,
      decoded.sourceType,
    )
      ? JSON.stringify(
          frameFor(stored, (type) => mayReadType(authority.key, type)),
        )
      : null;
  }
  const item = stored.item;
  if (
    typeof item !== "object" ||
    item === null ||
    typeof (item as Item).type !== "string" ||
    typeof (item as Item).source !== "string"
  )
    throw new Error("Unclassifiable item event");
  if (!mayReadType(authority.key, (item as Item).type)) return null;
  return JSON.stringify({
    ...(JSON.parse(itemFrameFor(stored, authority.key)) as Record<
      string,
      unknown
    >),
    listed: itemListed(authority, item as Item),
  });
}
function projectLive(
  frame: LiveFrame,
  authority: ReadViewAuthority,
): string | null {
  return project(storedFrame(frame.event), authority);
}

/** SQL scopes end before every enqueue, pacing wait, timer or subscription wait. */
export async function buildCopyStream(
  c: Context<AppEnv>,
  storage: Storage,
  options: EventRoutesOptions,
  releaseViewer: () => void,
): Promise<Response> {
  const { after, expected: requested } = copyStreamRequest(c);
  requireAuth(c);
  const bound = c.get("boundCredential");
  if (!bound)
    throw new MarfaError(ErrorCode.UNAUTHORIZED, "Authentication required");
  const signingKey =
    options.readView?.signingKey ??
    deriveKey(c.get("config").authSecret, SECRET_INFO.readView);
  let instanceId = options.readView?.instanceId;
  let expected = requested;
  const abort = new AbortController();
  const frames = subscribeAll({
    signal: abort.signal,
    maxBufferedFrames: BATCH_SIZE,
    onBufferOverflow: () => {
      incomplete("backlog_overflow");
    },
  });
  const state = {
    closed: false,
    holding: true,
    pending: 0,
    replayReach: after,
    cursor: after ?? 0n,
    lastSent: null as bigint | null,
  };
  const isClosed = (): boolean => state.closed;
  const held: LiveFrame[] = [];
  let replayedThrough = after ?? 0n;
  const maxBytes = options.maxUnsentBytes ?? EVENT_LIMITS.maxUnsentBytes;
  const stallMs = options.readerStallMs ?? EVENT_LIMITS.readerStallMs;
  let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
  let keepAlive: ReturnType<typeof setInterval> | undefined;
  let onRoom: (() => void) | undefined;
  let openingFailure: Incomplete | undefined;
  let tail: Promise<void> = Promise.resolve();
  let heartbeatPending = false;
  let head = 0n;
  let initialMin: bigint | null = null;
  const replayTarget = (): bigint => state.replayReach ?? head;
  let openingAuthority: ReadViewAuthority | undefined;
  const encoder = new TextEncoder();

  const cleanup = (): void => {
    if (isClosed()) return;
    state.closed = true;
    releaseViewer();
    if (keepAlive) clearInterval(keepAlive);
    abort.abort();
    c.req.raw.signal.removeEventListener("abort", cleanup);
    onRoom?.();
    void frames.return(undefined);
  };
  const send = (wire: string): void => {
    if (isClosed() || !controller) return;
    try {
      controller.enqueue(encoder.encode(wire));
    } catch {
      cleanup();
    }
  };
  const terminal = (type: string, data: Record<string, unknown>): void => {
    if (isClosed()) return;
    send(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
    const body = controller;
    cleanup();
    held.length = 0;
    if (body) {
      try {
        body.close();
      } catch {
        /* Consumer canceled. */
      }
      setTimeout(() => {
        try {
          body.error(new Error("The reader stopped reading"));
        } catch {
          /* Body closed. */
        }
      }, stallMs).unref();
    }
  };
  const incomplete = (reason: Incomplete): void => {
    if (!controller) {
      openingFailure ??= reason;
      abort.abort();
      return;
    }
    terminal("stream_incomplete", {
      reason,
      cursor: state.lastSent === null ? null : String(state.lastSent),
    });
  };
  const failed = (error: unknown, reason: Incomplete): void => {
    if (isClosed()) return;
    if (
      error instanceof MarfaError &&
      error.code === ErrorCode.READ_VIEW_CHANGED
    )
      terminal("read_view_changed", {});
    else if (
      error instanceof MarfaError &&
      error.code === ErrorCode.UNAUTHORIZED
    )
      incomplete("credential_ended");
    else incomplete(reason);
  };
  const hasRoom = (): boolean => (controller?.desiredSize ?? 0) > 0;
  const paced = async (): Promise<boolean> => {
    if (hasRoom()) return true;
    let room = controller?.desiredSize ?? 0;
    let progressAt = Date.now();
    while (!isClosed()) {
      await new Promise<void>((resolve) => {
        onRoom = resolve;
        const timer = setTimeout(resolve, EVENT_LIMITS.roomPollMs);
        const original = onRoom;
        onRoom = () => {
          clearTimeout(timer);
          original();
        };
      });
      onRoom = undefined;
      if (isClosed()) return false;
      const next = controller?.desiredSize ?? 0;
      if (next > room) progressAt = Date.now();
      room = next;
      if (hasRoom()) return true;
      if (Date.now() - progressAt >= stallMs) {
        incomplete("reader_behind");
        return false;
      }
    }
    return false;
  };
  const decide = <T>(
    read: (authority: ReadViewAuthority) => Promise<T> | T,
    disclose: (value: T) => void,
    reason: Incomplete = "live_delivery_failed",
  ): Promise<void> => {
    const turn = tail.then(async () => {
      if (isClosed()) return;
      try {
        const value = await storage.runInReadSnapshot(
          async (pin) => {
            const authority = await readViewAuthority(
              storage,
              bound,
              pin,
              instanceId ?? pin.instanceId,
              signingKey,
              expected,
            );
            return read(authority);
          },
          { signal: abort.signal },
        );
        if (!isClosed()) disclose(value);
      } catch (error) {
        failed(error, reason);
      }
    });
    tail = turn.catch(() => undefined);
    return turn;
  };
  const enqueueFrame = (id: bigint | undefined, payload: string): void => {
    if (isClosed()) return;
    const type = (JSON.parse(payload) as { type: string }).type;
    send(
      `${id === undefined ? "" : `id: ${String(id)}\n`}event: ${type}\ndata: ${payload}\n\n`,
    );
    if (!isClosed() && id !== undefined) {
      state.lastSent = id;
      if (id > state.cursor) state.cursor = id;
    }
  };
  const hold = (frame: LiveFrame): void => {
    if (held.length >= MAX_HELD_FRAMES && state.replayReach !== null) {
      const all = [...held, frame];
      const ids = all
        .map((carrier) => carrier.event.eventId)
        .filter((id): id is bigint => id !== undefined);
      if (ids.length === all.length) {
        const newest = ids.reduce(
          (latest, id) => (id > latest ? id : latest),
          0n,
        );
        if (newest > state.replayReach) state.replayReach = newest;
        held.length = 0;
        return;
      }
    }
    if (held.length >= MAX_HELD_FRAMES) {
      incomplete("backlog_overflow");
      return;
    }
    held.push(frame);
  };
  // next() attaches the process-local subscription before capture starts.
  const pump = async (): Promise<void> => {
    try {
      for (;;) {
        const next = await frames.next();
        if (next.done || isClosed()) return;
        state.pending += 1;
        for (
          let offset = 0;
          offset < next.value.length && !isClosed();
          offset += BATCH_SIZE
        ) {
          const batch = next.value.slice(offset, offset + BATCH_SIZE);
          await decide(
            (authority) =>
              batch.map((frame) => ({
                frame,
                payload: projectLive(frame, authority),
              })),
            (projected) => {
              for (const { frame, payload } of projected) {
                if (isClosed()) break;
                if (payload === null) continue;
                if (state.holding) hold(frame);
                else if (!hasRoom()) incomplete("reader_behind");
                else enqueueFrame(frame.event.eventId, payload);
              }
            },
          );
        }
        state.pending -= 1;
      }
    } catch (error) {
      failed(error, "live_delivery_failed");
    }
  };
  // Pump decisions queue behind the opening capture via the same turn chain.
  let openingDone: () => void = () => undefined;
  tail = new Promise<void>((resolve) => {
    openingDone = resolve;
  });
  void pump();
  c.req.raw.signal.addEventListener("abort", cleanup, { once: true });
  try {
    const captured = await storage.runInReadSnapshot(
      async (pin) => {
        const authority = await readViewAuthority(
          storage,
          bound,
          pin,
          instanceId ?? pin.instanceId,
          signingKey,
          expected,
        );
        checkReachesSomeType(authority.key);
        const [head, min] = await Promise.all([
          storage.eventLog.getMaxId(),
          storage.eventLog.getMinRetainedId(),
        ]);
        return { authority, head: head ?? 0n, min };
      },
      {
        deadlineAt:
          Date.now() +
          (options.headReadTimeoutMs ?? EVENT_LIMITS.headReadTimeoutMs),
        signal: abort.signal,
      },
    );
    openingAuthority = captured.authority;
    instanceId = captured.authority.instanceId;
    expected = captured.authority.readView;
    head = captured.head;
    initialMin = captured.min;
  } catch (error) {
    if (error instanceof MarfaError) {
      cleanup();
      openingDone();
      throw error;
    }
    openingFailure ??= "replay_failed";
  }

  const replay = async (): Promise<void> => {
    if (after === null) return;
    state.replayReach = head;
    let carriers: PersistedEvent[] = [];
    while (!isClosed()) {
      if (!(await paced())) return;
      await decide(
        async (authority) => {
          const min = await storage.eventLog.getMinRetainedId();
          const batch = carriers.length
            ? carriers
            : await storage.eventLog.getAfter(state.cursor, BATCH_SIZE);
          return {
            min,
            batch,
            projected: batch.map((row) => ({
              row,
              payload: project(
                JSON.parse(row.payload) as Record<string, unknown>,
                authority,
              ),
            })),
          };
        },
        ({ min, batch, projected }) => {
          if (min !== null && state.cursor + 1n < min) {
            terminal("catchup_too_old", {
              min_retained_id: String(min),
              requested: String(after),
            });
            return;
          }
          let consumed = 0;
          for (const { row, payload } of projected) {
            if (payload !== null && !hasRoom()) break;
            if (payload !== null) {
              enqueueFrame(row.id, payload);
            }
            if (isClosed()) return;
            state.cursor = row.id;
            replayedThrough = row.id;
            consumed += 1;
          }
          carriers = batch.slice(consumed);
          if (batch.length === 0 && state.cursor < replayTarget())
            incomplete("replay_failed");
        },
        "replay_failed",
      );
      if (isClosed()) return;
      if (carriers.length === 0 && state.cursor >= replayTarget()) break;
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    state.replayReach = null;
  };
  const release = async (): Promise<void> => {
    for (;;) {
      if (isClosed() || !(await paced())) return;
      await decide(
        (authority) => {
          const batch = held.slice(0, BATCH_SIZE);
          return {
            batch,
            projected: batch.map((frame) => ({
              frame,
              payload: projectLive(frame, authority),
            })),
            authority,
          };
        },
        ({ projected, authority }) => {
          let consumed = 0;
          for (const { frame, payload } of projected) {
            const id = frame.event.eventId;
            const duplicate =
              id !== undefined && after !== null && id <= replayedThrough;
            if (!duplicate && payload !== null && !hasRoom()) break;
            if (!duplicate && payload !== null) enqueueFrame(id, payload);
            if (isClosed()) return;
            consumed += 1;
          }
          held.splice(0, consumed);
          if (held.length === 0 && state.pending === 0 && hasRoom()) {
            if (state.cursor < head) state.cursor = head;
            send(
              `event: stream_live\ndata: ${JSON.stringify({ type: "stream_live", cursor: String(state.cursor), instance_id: authority.instanceId, read_view: authority.readView })}\n\n`,
            );
            state.holding = false;
          }
        },
      );
      if (isClosed() || !state.holding) return;
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
  };
  const stream = new ReadableStream<Uint8Array>(
    {
      start(body) {
        controller = body;
        if (isClosed()) {
          body.close();
          openingDone();
          return;
        }
        if (openingFailure || !openingAuthority) {
          incomplete(openingFailure ?? "replay_failed");
          openingDone();
          return;
        }
        send(": connected\n\n");
        send(
          `event: stream_cursor\ndata: ${JSON.stringify({ type: "stream_cursor", cursor: String(head), instance_id: openingAuthority.instanceId, read_view: openingAuthority.readView })}\n\n`,
        );
        openingDone();
        keepAlive = setInterval(() => {
          if (heartbeatPending || state.closed) return;
          heartbeatPending = true;
          void decide(
            () => undefined,
            () => {
              if (controller?.desiredSize === maxBytes) send(":ping\n\n");
            },
          ).finally(() => {
            heartbeatPending = false;
          });
        }, options.keepAliveMs ?? EVENT_LIMITS.keepAliveMs);
        void (async () => {
          if (
            after !== null &&
            initialMin !== null &&
            after + 1n < initialMin
          ) {
            terminal("catchup_too_old", {
              min_retained_id: String(initialMin),
              requested: String(after),
            });
            return;
          }
          if (after !== null && after > head) {
            terminal("cursor_ahead", {
              requested: String(after),
              head: String(head),
            });
            return;
          }
          await replay();
          if (!isClosed()) await release();
        })().catch((error: unknown) => {
          failed(error, "replay_failed");
        });
      },
      pull() {
        onRoom?.();
      },
      cancel() {
        cleanup();
      },
    },
    { highWaterMark: maxBytes, size: (chunk) => chunk.byteLength },
  );
  return withPreparedHeaders(
    c,
    new Response(stream, {
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-store",
        Connection: "keep-alive",
      },
    }),
  );
}
