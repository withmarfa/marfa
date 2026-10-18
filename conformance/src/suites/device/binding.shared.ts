import { expect, vi } from "vitest";
import type {
  BindingDevice,
  Subscription,
} from "../../device/binding-adapter.js";
import {
  answers,
  connected,
  copyItemEvent,
  copyStreamCursor,
  refusal,
  wireItem,
} from "../../device/marfa-answers.js";
import type {
  Answer,
  RecordedRequest,
  Responder,
  SseFrame,
  StreamFeed,
} from "../../device/scripted-server.js";
import {
  scriptHydration,
  scriptWrites,
  startBindingHarness,
  type BindingHarness,
} from "./harness.js";

/** What the binding fixtures share: a hydrated copy and the scripts around it. */

/** A stream the server holds open and says nothing on. */
export const HELD: Answer = { kind: "sse", frames: [connected], hold: true };

/**
 * A stream the server holds open, saying what `feed` is given to say. It
 * names the cursor it was asked from as its own, as a server at that head
 * does.
 */
export function heldBy(feed: StreamFeed, ...frames: SseFrame[]): Responder {
  return (request) => ({
    kind: "sse",
    frames: [
      connected,
      copyStreamCursor(request.headers["last-event-id"] ?? "10"),
      ...frames,
    ],
    hold: true,
    feed,
  });
}

/** The frame that tells a note was made, at `cursor`. */
export function noteMade(id: string, cursor: string): SseFrame {
  return copyItemEvent(
    cursor,
    "item.created",
    wireItem({ id, properties: { title: id, body: id } }),
  );
}

export const BUSY = refusal(503, "unavailable", "busy");

/**
 * The answers to the streams a follow asks for, taken in order with the last
 * repeating. They are set by the fixture as it goes, which the server's own
 * queue of answers does not allow: one set after a hydration has been through
 * the door queues behind the answer that is still repeating.
 */
export interface Streams {
  set: (...next: Responder[]) => void;
}

export interface Followed extends BindingHarness {
  events: Streams;
}

/**
 * A binding whose copy is hydrated at `head`, or is not hydrated at all where
 * `hydrate` is false, with its streams scripted to be held.
 */
export async function bindingHarness(
  label: string,
  options: {
    head?: string;
    /** Scripted beside the hydration's, before it, for a door the fixture changes as it goes. */
    setup?: (harness: BindingHarness) => void;
    /** Names the instance the copy's stream says it is from. */
    instance?: () => string;
    /** The streams a follow is first given; held ones unless named. */
    streams?: Responder[];
    /**
     * The answers to the hydration's own reads of the log, its head and then
     * its replay, in place of the scripted ones.
     */
    log?: Responder[];
    hydrate?: boolean;
    /** The rows the hydration lists, by type. */
    rows?: Parameters<typeof scriptHydration>[1]["rows"];
  } = {},
): Promise<Followed> {
  const started = await startBindingHarness(label);
  try {
    if (options.log !== undefined) {
      started.server.copyAnswer("GET", "/events", ...options.log);
    }
    scriptHydration(started.server, {
      head: options.head ?? "10",
      instance: options.instance,
      rows: options.rows,
    });
    options.setup?.(started);
    let next: Responder[] = options.streams ?? [HELD];
    // After the hydration's own two reads of the log, which the queue gives
    // first.
    started.server.copyAnswer("GET", "/events", (request) => {
      const one = next.length > 1 ? next.shift()! : next[0]!;
      return typeof one === "function" ? one(request) : one;
    });
    if (options.hydrate !== false) {
      const hydration = await started.device.hydrate(["core.note"], "library");
      expect(hydration.ok, JSON.stringify(hydration)).toBe(true);
    }
    return {
      ...started,
      events: {
        set: (...answers) => {
          next = answers;
        },
      },
    };
  } catch (error) {
    await started.stop();
    throw error;
  }
}

/** The streams the server has been asked for. */
export function streamsAsked(
  server: BindingHarness["server"],
): RecordedRequest[] {
  return server.requests.filter((request) => request.pathname === "/events");
}

/** Waits for the kinds a follow has told to be these. */
export async function untilTold(
  follow: Subscription,
  kinds: string[],
  why: string,
): Promise<void> {
  await vi.waitFor(
    () => {
      expect(follow.kinds, why).toEqual(kinds);
    },
    { timeout: 10_000, interval: 20 },
  );
}

/** The one wait the engine has asked of the manual clock. */
export async function nextWait(device: BindingDevice): Promise<number> {
  let asked = 0;
  await vi.waitFor(
    async () => {
      const waits = await device.clock.waits();
      expect(waits, "the follow asked for no wait").toHaveLength(1);
      asked = waits[0]!.askedMs;
    },
    { timeout: 10_000, interval: 20 },
  );
  return asked;
}

/** Waits for the engine to have reached `point` `count` times. */
export async function untilReached(
  device: BindingDevice,
  point: string,
  count = 1,
): Promise<void> {
  await vi.waitFor(
    async () => {
      expect(
        await device.hooks.reached(point),
        `the engine did not reach ${point}`,
      ).toBeGreaterThanOrEqual(count);
    },
    { timeout: 10_000, interval: 20 },
  );
}

/**
 * Takes every create, answering with the row it was sent, and answers a read
 * of each row it took. The answers `ahead` makes from the taking answer go
 * first, one per create.
 */
export function takeCreates(
  server: BindingHarness["server"],
  ahead: (take: (request: RecordedRequest) => Answer) => Responder[] = () => [],
): (request: RecordedRequest) => Answer {
  const rows = new Map<string, Record<string, unknown>>();
  const take = (request: { body: string }): Answer => {
    const sent = JSON.parse(request.body) as {
      id: string;
      properties: Record<string, unknown>;
    };
    const row = wireItem({ id: sent.id, properties: sent.properties });
    rows.set(sent.id, row);
    return answers.created(row);
  };
  scriptWrites(server, {
    create: [...ahead(take), take],
    read: [
      (request) => {
        const row = rows.get(request.pathname.split("/").at(-1) ?? "");
        return row
          ? answers.updated(row)
          : refusal(404, "item_not_found", "no such item");
      },
    ],
  });
  return take;
}

/** The ids of the creates the server was sent, in the order they came. */
export function createsSent(server: BindingHarness["server"]): string[] {
  return server.requests
    .filter(
      (request) => request.method === "POST" && request.pathname === "/items",
    )
    .map((request) => (JSON.parse(request.body) as { id: string }).id);
}

/** Queues a note for each title, and answers the ids of the rows made. */
export async function queueNotes(
  device: BindingDevice,
  ...titles: string[]
): Promise<string[]> {
  const ids: string[] = [];
  for (const title of titles) {
    const queued = await device.createItem({
      type: "core.note",
      properties: { title, body: title },
    });
    expect(queued.ok, JSON.stringify(queued)).toBe(true);
    if (queued.ok) ids.push(queued.value.itemId ?? "");
  }
  return ids;
}

/** Waits for a call of the engine to be held at `point`. */
export async function untilHeld(
  device: BindingDevice,
  point: string,
): Promise<void> {
  await vi.waitFor(
    async () => {
      expect(
        await device.hooks.waiting(point),
        `no call was held at ${point}`,
      ).toBeGreaterThanOrEqual(1);
    },
    { timeout: 10_000, interval: 20 },
  );
}

/** A stream as an instance other than the scripted one serves it. */
export function servedBy(instance: string, answer: Answer): Answer {
  if (answer.kind !== "sse") return answer;
  return {
    ...answer,
    frames: answer.frames.map((frame) =>
      frame.event === "stream_cursor" || frame.event === "stream_live"
        ? {
            ...frame,
            data: {
              ...(frame.data as Record<string, unknown>),
              instance_id: instance,
            },
          }
        : frame,
    ),
  };
}

/** Waits for `feed` to hold `open` streams. */
export async function untilOpen(feed: StreamFeed, open = 1): Promise<void> {
  await vi.waitFor(
    () => {
      expect(feed.open, "the engine held no stream").toBe(open);
    },
    { timeout: 10_000, interval: 20 },
  );
}

/** Waits a while for something that should not happen, so its absence means something. */
export async function quietly(ms = 400): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

/** Waits for `feed` to have been given `count` streams, open or not. */
export async function untilOpened(
  feed: StreamFeed,
  count: number,
): Promise<void> {
  await vi.waitFor(
    () => {
      expect(feed.opened, "the engine did not hold a stream again").toBe(count);
    },
    { timeout: 10_000, interval: 20 },
  );
}
