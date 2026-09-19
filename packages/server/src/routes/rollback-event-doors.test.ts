/**
 * A write that is undone tells the stream nothing.
 *
 * A durable client persists what the stream says and moves its cursor past
 * it. An event published for a write that then rolls back becomes a row on
 * that client which nothing will ever correct, short of a full re-import: a
 * cached client forgets on reload, a durable one does not. So the ordering
 * is not a nicety. Publish is downstream of the write landing, or the door
 * can manufacture a phantom.
 *
 * **Scope: the item and edge write doors.** Those are the routes a client
 * writes its own graph through, and they are what this file speaks for.
 * Other code publishes too, and its events are not lesser ones: connection
 * lifecycle, grant projection, the install pipeline, archive restore,
 * sign-up seeding and the enrichment sweeper all put ordinary item events on
 * the same stream a durable client persists. They are outside this file as a
 * boundary decision rather than an oversight, and the census at the bottom
 * names every one of them so the decision stays visible instead of implied.
 *
 * **Both assertions are needed, and which one catches a regression depends
 * on the door.** The `emitter.emit` inside `publish()` is unconditional and
 * synchronous, so a same-process subscriber (SSE viewers, outbound webhook
 * delivery, the reactive bridges) always receives the phantom. The
 * `event_log` row does not always survive to show it, because the log is
 * written through the same transaction-aware db the door writes through:
 *
 *   - On a door that opens a transaction, a publish moved inside it has its
 *     `event_log` row rolled back with everything else. The log then looks
 *     correct and ONLY the subscriber assertion reddens.
 *   - On a door that opens none, a publish moved above the write commits its
 *     log row, so BOTH assertions redden.
 *
 * Both halves were measured rather than reasoned about. A guard written
 * against the log alone would pass every transactional case, which is the
 * half where a rollback is a real event rather than a hypothetical one.
 *
 * **Each door is proved twice.** Once unbroken, so the subscriber is known
 * to hear this door at all — a negative assertion against a probe that could
 * never have seen anything is not evidence — and once with the write forced
 * to come apart. Two shapes of breakage, because the doors are two shapes:
 *
 *   - A door that wraps its write in `storage.runInTransaction` is broken by
 *     rolling that transaction back the instant its last write lands. It is
 *     the only probe that reaches the case where the write really did happen
 *     and really was undone.
 *   - A door that opens no transaction has nothing to roll back. Its write
 *     is a single statement and the property reduces to ordering, so it is
 *     broken by making that write throw. Weaker, and honest about it: it
 *     catches a publish moved above the write and nothing else.
 *
 * How many transactions each door opens is measured rather than assumed. The
 * unbroken run counts them and the table below has to match exactly. A count
 * rather than a yes-or-no, because a door that grew a preflight transaction
 * would take the breakage on that one, never reach its real write, and pass
 * for the wrong reason.
 */
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { generateId } from "@withmarfa/shared";
import { conflictedSiblingId } from "../storage/conflict.js";
import {
  createTestContext,
  request,
  collectEdgeEvents,
  collectItemEvents,
  runBulkActionAsync,
  settle,
} from "../test-utils.js";
import type { TestContext } from "../test-utils.js";
import {
  initEventLog,
  __resetEventLogForTests,
  type EdgeEventWithId,
  type ItemEventWithId,
} from "../pubsub.js";

let ctx: TestContext;

beforeAll(async () => {
  ctx = await createTestContext();
  // Without this `publish` persists nothing, and the event-log half of every
  // assertion below would hold for a reason that has nothing to do with the
  // property under test.
  initEventLog(ctx.storage.eventLog);
});

afterAll(async () => {
  __resetEventLogForTests();
  await ctx.cleanup();
});

// ---------------------------------------------------------------------------
// Breaking a write
// ---------------------------------------------------------------------------

/** Distinguishable in a log from anything the server raises on its own. */
class ForcedFailure extends Error {
  constructor(what: string) {
    super(`forced failure after ${what}`);
    this.name = "ForcedFailure";
  }
}

interface Injection {
  /** How many times the injection actually engaged. A guard whose probe
   *  never fired has proved nothing, so every use asserts on this. */
  fired: () => number;
  restore: () => void;
}

/**
 * Count the transactions a door opens, changing nothing else.
 *
 * The census half of the unbroken run: it is what lets the table below
 * record each door's shape as an observation rather than as a reading of
 * the source.
 */
function countTransactions(): Injection {
  const original = ctx.storage.runInTransaction.bind(ctx.storage);
  let fired = 0;
  ctx.storage.runInTransaction = async <T>(
    fn: () => T | Promise<T>,
  ): Promise<T> => {
    fired += 1;
    return original(fn);
  };
  return {
    fired: () => fired,
    restore: () => {
      ctx.storage.runInTransaction = original;
    },
  };
}

/**
 * Roll a door's own transaction back the instant its last write has landed.
 *
 * The throw goes in after the callback returns rather than in place of part
 * of it, so every write the door meant to make has really been made against
 * the transaction — which is the only position from which a publish inside
 * it would have had something to describe.
 */
function rollBackAfterTheWrite(): Injection {
  const original = ctx.storage.runInTransaction.bind(ctx.storage);
  let fired = 0;
  ctx.storage.runInTransaction = async <T>(
    fn: () => T | Promise<T>,
  ): Promise<T> => {
    return original(async () => {
      await fn();
      fired += 1;
      throw new ForcedFailure("the transaction body");
    });
  };
  return {
    fired: () => fired,
    restore: () => {
      ctx.storage.runInTransaction = original;
    },
  };
}

/**
 * Make one named storage write throw.
 *
 * For the doors that open no transaction. `owner` is the store the method
 * hangs off, so the replacement is installed where the route resolves it:
 * every route reads `storage.<store>.<method>` per call rather than
 * capturing it, which is what makes this reach them.
 */
function breakWrite<O extends object>(owner: O, method: keyof O): Injection {
  const original = owner[method];
  let fired = 0;
  // The stores are plain objects behind an interface, so the replacement is
  // an ordinary assignment; the cast is only to satisfy the indexed type.
  owner[method] = ((...args: unknown[]): never => {
    void args;
    fired += 1;
    throw new ForcedFailure(String(method));
  }) as O[keyof O];
  return {
    fired: () => fired,
    restore: () => {
      owner[method] = original;
    },
  };
}

// ---------------------------------------------------------------------------
// Listening
// ---------------------------------------------------------------------------

interface Heard {
  items: ItemEventWithId[];
  edges: EdgeEventWithId[];
  /** Rows appended to `event_log` while the door ran. */
  logged: number;
}

/** Last `event_log` id this file has accounted for. */
let eventLogCursor = 0n;

async function countLoggedSinceCursor(): Promise<number> {
  let counted = 0;
  for (;;) {
    const rows = await ctx.storage.eventLog.getAfter(eventLogCursor, 200);
    if (rows.length === 0) return counted;
    counted += rows.length;
    eventLogCursor = rows[rows.length - 1]!.id;
  }
}

/**
 * Run `act` with a live subscriber attached, and report everything it heard.
 *
 * `settle` on both sides rather than an awaited arrival, because half of
 * what this file asserts is that nothing came — which cannot be awaited, and
 * so is measured by listening for a bounded moment and finding the
 * collection empty.
 */
async function hear(act: () => Promise<void>): Promise<Heard> {
  await countLoggedSinceCursor();
  const controller = new AbortController();
  const items = collectItemEvents(controller.signal);
  const edges = collectEdgeEvents(controller.signal);
  await settle();
  await act();
  await settle();
  controller.abort();
  await items.done;
  await edges.done;
  return {
    items: items.events,
    edges: edges.events,
    logged: await countLoggedSinceCursor(),
  };
}

// ---------------------------------------------------------------------------
// The doors
// ---------------------------------------------------------------------------

type Family = "item" | "metadata" | "edge" | "bulk";

/**
 * Whatever a door's setup minted, for its own `act` and `landed` to read.
 *
 * Every field is present and every setup fills in the subset it uses, so a
 * door reading one it never minted gets an empty string or a version of 0,
 * and a request that fails visibly — rather than the string `undefined`
 * inside a URL, which routes as a malformed id and reads as a real refusal.
 */
interface DoorState {
  item: string;
  other: string;
  edge: string;
  sourceId: string;
  tag: string;
  /** The version the door's write names, where its setup moved the row on. */
  version: number;
}

const NO_STATE: DoorState = {
  item: "",
  other: "",
  edge: "",
  sourceId: "",
  tag: "",
  version: 0,
};

interface Door {
  name: string;
  family: Family;
  /**
   * How many transactions the door opens through `storage.runInTransaction`,
   * asserted by exact equality against the count taken on the unbroken run.
   *
   * A count rather than a yes-or-no. The breakage throws out of the FIRST
   * transaction it sees, so a door that grew a preflight transaction — a
   * quota reservation, a lock — would be broken there, never reach the write
   * this file is about, and pass while proving nothing. Pinning the number
   * makes that door redden on the unbroken run instead, where the message
   * says what changed.
   */
  transactions: number;
  setup: () => Promise<Partial<DoorState>>;
  /** Drive the door. Resolves to whether it reported success. */
  act: (s: DoorState) => Promise<boolean>;
  /** The events this door's write is answerable for. */
  attributable: (
    h: Heard,
    s: DoorState,
  ) => (ItemEventWithId | EdgeEventWithId)[];
  /**
   * Whether the write is visible in storage. Read on both runs: true after
   * the unbroken one, and compared against `survivesBreakage` after the
   * broken one.
   */
  landed: (s: DoorState) => Promise<boolean>;
  /**
   * Whether any part of the write outlives the forced failure. False
   * everywhere a transaction covers the door. True is a statement about the
   * door rather than about this test: it names a door whose writes are not
   * atomic with each other, so a failure part-way leaves the database
   * changed and the stream silent.
   */
  survivesBreakage: boolean;
  /** How to break a door that opens no transaction. */
  breakage?: () => Injection;
}

const NAMESPACE = "testapp";

/** Far enough from now that a door leaving the row alone cannot match it. */
const RESTAMPED_AT = "2020-01-01T00:00:00.000Z";

function uniq(prefix: string): string {
  return `${prefix}-${Math.random().toString(36).slice(2, 10)}`;
}

async function makeNote(body = "seed"): Promise<string> {
  const res = await request(ctx.app, "POST", "/items", {
    key: ctx.spaceKey,
    body: { type: "core.note", properties: { body }, source_id: uniq("seed") },
  });
  expect(res.status).toBe(201);
  return ((await res.json()) as { item: { id: string } }).item.id;
}

async function makeEdge(source: string, target: string): Promise<string> {
  const res = await request(ctx.app, "POST", "/edges", {
    key: ctx.spaceKey,
    body: { source_id: source, target_id: target, edge_type: "references" },
  });
  expect(res.status).toBe(201);
  return ((await res.json()) as { edge: { id: string } }).edge.id;
}

/** The losing text the conflicted-copy door writes. */
const CONFLICTED_LOSER = "door-conflicted-loser";

/**
 * The idempotency key that door sends, and the sibling id it therefore
 * produces.
 *
 * Derived from the item rather than fixed, for two reasons that both bite.
 * The key must differ per run or the second run replays the first's recorded
 * response and never executes the door at all. And the id must be knowable
 * without a response body, because the broken run has none to read — while
 * searching for the losing text instead would find the *unbroken* run's
 * sibling, which is still in the database, and report a write that came apart
 * as having landed.
 */
function conflictKeyFor(item: string): string {
  return `door-conflict-${item}`;
}

function conflictSiblingFor(item: string): string {
  return conflictedSiblingId({
    itemId: item,
    baseVersion: 1,
    idempotencyKey: conflictKeyFor(item),
  });
}

async function itemBody(id: string): Promise<string | undefined> {
  const row = await ctx.storage.items.getIncludingTrashed(id);
  return row?.properties.body as string | undefined;
}

function itemEventsFor(h: Heard, id: string): ItemEventWithId[] {
  return h.items.filter((e) => e.item.id === id);
}

function edgeEventsTouching(h: Heard, ids: string[]): EdgeEventWithId[] {
  return h.edges.filter(
    (e) => ids.includes(e.edge.source_id) || ids.includes(e.edge.target_id),
  );
}

const doors: Door[] = [
  // --- item ---------------------------------------------------------------
  {
    name: "POST /items creates an item",
    family: "item",
    transactions: 1,
    setup: () => Promise.resolve({ item: generateId() }),
    act: async (s) => {
      const res = await request(ctx.app, "POST", "/items", {
        key: ctx.spaceKey,
        body: {
          id: s.item,
          type: "core.note",
          properties: { body: "created" },
          source_id: uniq("create"),
        },
      });
      return res.status === 201;
    },
    attributable: (h, s) => itemEventsFor(h, s.item),
    landed: async (s) =>
      (await ctx.storage.items.getIncludingTrashed(s.item)) !== null,
    survivesBreakage: false,
  },
  {
    name: "POST /items writes the edges named with the item",
    family: "item",
    transactions: 1,
    setup: async () => ({
      item: generateId(),
      other: await makeNote("target"),
    }),
    act: async (s) => {
      const res = await request(ctx.app, "POST", "/items", {
        key: ctx.spaceKey,
        body: {
          id: s.item,
          type: "core.note",
          properties: { body: "with edges" },
          source_id: uniq("inline"),
          edges: { references: [s.other] },
        },
      });
      return res.status === 201;
    },
    attributable: (h, s) => [
      ...itemEventsFor(h, s.item),
      ...edgeEventsTouching(h, [s.item]),
    ],
    landed: async (s) =>
      (await ctx.storage.edges.listFromSource(s.item)).data.length > 0,
    survivesBreakage: false,
  },
  {
    name: "POST /items upserts on a natural key",
    family: "item",
    transactions: 1,
    setup: async () => {
      const sourceId = uniq("natural");
      const res = await request(ctx.app, "POST", "/items", {
        key: ctx.spaceKey,
        body: {
          type: "core.note",
          properties: { body: "before" },
          source_id: sourceId,
        },
      });
      expect(res.status).toBe(201);
      const id = ((await res.json()) as { item: { id: string } }).item.id;
      return { item: id, sourceId };
    },
    act: async (s) => {
      const res = await request(ctx.app, "POST", "/items", {
        key: ctx.spaceKey,
        body: {
          type: "core.note",
          properties: { body: "after" },
          source_id: s.sourceId,
        },
      });
      return res.status === 200;
    },
    attributable: (h, s) => itemEventsFor(h, s.item),
    landed: async (s) => (await itemBody(s.item)) === "after",
    survivesBreakage: false,
  },
  {
    name: "PATCH /items/{id} updates properties and replaces edges",
    family: "item",
    transactions: 1,
    setup: async () => {
      const item = await makeNote("before");
      const other = await makeNote("new target");
      const stale = await makeNote("stale target");
      const planted = await request(ctx.app, "PATCH", `/items/${item}`, {
        key: ctx.spaceKey,
        body: { edges: { references: [stale] }, version: 1 },
      });
      expect(planted.status).toBe(200);
      const { item: row } = (await planted.json()) as {
        item: { version: number };
      };
      return { item, other, version: row.version };
    },
    act: async (s) => {
      const res = await request(ctx.app, "PATCH", `/items/${s.item}`, {
        key: ctx.spaceKey,
        body: {
          properties: { body: "after" },
          edges: { references: [s.other] },
          version: s.version,
        },
      });
      return res.status === 200;
    },
    attributable: (h, s) => [
      ...itemEventsFor(h, s.item),
      ...edgeEventsTouching(h, [s.item]),
    ],
    landed: async (s) => (await itemBody(s.item)) === "after",
    survivesBreakage: false,
  },
  {
    // Two rows from one door: the original moves on and the losing edit
    // lands on a sibling. Both are written in the same transaction, so a
    // failure part-way must leave neither — and the sibling has to be
    // announced, or the only client that ever learns of it is the writer.
    name: "PATCH /items/{id}?conflict=auto spawns the conflicted copy",
    family: "item",
    transactions: 1,
    setup: async () => {
      const item = await makeNote("shared body");
      // Move it on, so the write below collides on `body` — a keep-both
      // field on `core.note`.
      const res = await request(ctx.app, "PATCH", `/items/${item}`, {
        key: ctx.spaceKey,
        body: { properties: { body: "winner body" }, version: 1 },
      });
      expect(res.status).toBe(200);
      return { item };
    },
    act: async (s) => {
      const res = await request(
        ctx.app,
        "PATCH",
        `/items/${s.item}?conflict=auto`,
        {
          key: ctx.spaceKey,
          headers: { "Idempotency-Key": conflictKeyFor(s.item) },
          body: { properties: { body: CONFLICTED_LOSER }, version: 1 },
        },
      );
      return res.status === 200;
    },
    attributable: (h, s) => [
      ...itemEventsFor(h, s.item),
      ...itemEventsFor(h, conflictSiblingFor(s.item)),
    ],
    landed: async (s) =>
      (await ctx.storage.items.getIncludingTrashed(
        conflictSiblingFor(s.item),
      )) !== null,
    survivesBreakage: false,
  },
  {
    name: "DELETE /items/{id} trashes an item",
    family: "item",
    transactions: 1,
    setup: async () => ({ item: await makeNote("doomed") }),
    act: async (s) => {
      const res = await request(ctx.app, "DELETE", `/items/${s.item}`, {
        key: ctx.spaceKey,
      });
      return res.status === 200;
    },
    attributable: (h, s) => itemEventsFor(h, s.item),
    landed: async (s) =>
      (await ctx.storage.items.getIncludingTrashed(s.item))?.state ===
      "trashed",
    survivesBreakage: false,
  },
  {
    name: "POST /items/{id}/transition moves an item's state",
    family: "item",
    transactions: 0,
    breakage: () => breakWrite(ctx.storage.items, "transition"),
    setup: async () => ({ item: await makeNote("transitioning") }),
    act: async (s) => {
      const res = await request(
        ctx.app,
        "POST",
        `/items/${s.item}/transition`,
        {
          key: ctx.spaceKey,
          body: { state: "archived" },
        },
      );
      return res.status === 200;
    },
    attributable: (h, s) => itemEventsFor(h, s.item),
    landed: async (s) =>
      (await ctx.storage.items.getIncludingTrashed(s.item))?.state ===
      "archived",
    survivesBreakage: false,
  },
  {
    name: "POST /items/{id}/restore brings an item back",
    family: "item",
    transactions: 0,
    breakage: () => breakWrite(ctx.storage.items, "restore"),
    setup: async () => {
      const item = await makeNote("to restore");
      await request(ctx.app, "DELETE", `/items/${item}`, { key: ctx.spaceKey });
      return { item };
    },
    act: async (s) => {
      const res = await request(ctx.app, "POST", `/items/${s.item}/restore`, {
        key: ctx.spaceKey,
      });
      return res.status === 200;
    },
    attributable: (h, s) => itemEventsFor(h, s.item),
    landed: async (s) =>
      (await ctx.storage.items.getIncludingTrashed(s.item))?.state === "active",
    survivesBreakage: false,
  },
  {
    name: "POST /items/{id}/promote copies an integration's row",
    family: "item",
    transactions: 1,
    setup: async () => {
      // Promotion is defined against a row an integration wrote, and no
      // route stamps that source, so the mirror is planted through storage —
      // into the space the caller below is bound to, or the door never
      // resolves it.
      const mirror = await ctx.storage.items.create({
        type: "core.note",
        properties: { body: "upstream copy" },
        source: "integration:promote-fixture",
        source_id: uniq("mirror"),
      });
      return { item: mirror.id };
    },
    act: async (s) => {
      const res = await request(ctx.app, "POST", `/items/${s.item}/promote`, {
        key: ctx.spaceKey,
      });
      return res.status === 201;
    },
    // Both halves. The item is announced first and the edge behind it, so
    // guarding one would leave the other free to move inside the
    // transaction and describe a promotion that rolled back.
    //
    // The copy is identified by elimination rather than by its id, because
    // its id only exists on the successful run — the response carries it and
    // the broken run has no response. Reading it from there left the broken
    // run comparing against an empty string, so a phantom item event was
    // heard and attributed to nothing, and the guard passed while the defect
    // it names was present. Within `act`'s window this door writes exactly
    // one item and never touches the mirror, so an item event that is not
    // the mirror's is the copy's.
    attributable: (h, s) => [
      ...h.items.filter((e) => e.item.id !== s.item),
      ...edgeEventsTouching(h, [s.item]),
    ],
    landed: async (s) =>
      (await ctx.storage.edges.listToTarget(s.item)).data.length > 0,
    survivesBreakage: false,
  },
  {
    name: "DELETE /items/{id}/purge removes an item and its edges",
    family: "item",
    transactions: 1,
    setup: async () => {
      const item = await makeNote("to purge");
      const other = await makeNote("pointing at it");
      const edge = await makeEdge(other, item);
      await request(ctx.app, "DELETE", `/items/${item}`, { key: ctx.spaceKey });
      return { item, other, edge };
    },
    act: async (s) => {
      const res = await request(ctx.app, "DELETE", `/items/${s.item}/purge`, {
        key: ctx.spaceKey,
      });
      return res.status === 200;
    },
    // The item event as well as the cascade. The door announces both, so
    // guarding one would leave the other free to move above the write —
    // and the item event's write is the one being broken here.
    attributable: (h, s) => [
      ...itemEventsFor(h, s.item),
      ...edgeEventsTouching(h, [s.item, s.other]),
    ],
    landed: async (s) => (await ctx.storage.edges.get(s.edge)) === null,
    survivesBreakage: false,
  },

  // --- metadata -----------------------------------------------------------
  {
    name: "PUT /items/{id}/metadata replaces the tags",
    family: "metadata",
    transactions: 0,
    breakage: () => breakWrite(ctx.storage.metadata, "set"),
    setup: async () => ({ item: await makeNote("tagged") }),
    act: async (s) => {
      const res = await request(ctx.app, "PUT", `/items/${s.item}/metadata`, {
        key: ctx.spaceKey,
        body: { tags: ["replaced"] },
      });
      return res.status === 200;
    },
    attributable: (h, s) => itemEventsFor(h, s.item),
    landed: async (s) =>
      (await ctx.storage.metadata.get(s.item)).tags.includes("replaced"),
    survivesBreakage: false,
  },
  {
    name: "PATCH /items/{id}/metadata merges the tags",
    family: "metadata",
    transactions: 0,
    breakage: () => breakWrite(ctx.storage.metadata, "merge"),
    setup: async () => ({ item: await makeNote("tagged") }),
    act: async (s) => {
      const res = await request(ctx.app, "PATCH", `/items/${s.item}/metadata`, {
        key: ctx.spaceKey,
        body: { tags: ["merged"] },
      });
      return res.status === 200;
    },
    attributable: (h, s) => itemEventsFor(h, s.item),
    landed: async (s) =>
      (await ctx.storage.metadata.get(s.item)).tags.includes("merged"),
    survivesBreakage: false,
  },
  {
    name: "POST /items/{id}/tags adds tags",
    family: "metadata",
    transactions: 0,
    breakage: () => breakWrite(ctx.storage.metadata, "addTags"),
    setup: async () => ({ item: await makeNote("tagged") }),
    act: async (s) => {
      const res = await request(ctx.app, "POST", `/items/${s.item}/tags`, {
        key: ctx.spaceKey,
        body: { tags: ["added"] },
      });
      return res.status === 200;
    },
    attributable: (h, s) => itemEventsFor(h, s.item),
    landed: async (s) =>
      (await ctx.storage.metadata.get(s.item)).tags.includes("added"),
    survivesBreakage: false,
  },
  {
    name: "DELETE /items/{id}/tags/{tag} removes a tag",
    family: "metadata",
    transactions: 0,
    breakage: () => breakWrite(ctx.storage.metadata, "removeTag"),
    setup: async () => {
      const item = await makeNote("tagged");
      await request(ctx.app, "POST", `/items/${item}/tags`, {
        key: ctx.spaceKey,
        body: { tags: ["doomed"] },
      });
      return { item };
    },
    act: async (s) => {
      const res = await request(
        ctx.app,
        "DELETE",
        `/items/${s.item}/tags/doomed`,
        { key: ctx.spaceKey },
      );
      return res.status === 200;
    },
    attributable: (h, s) => itemEventsFor(h, s.item),
    landed: async (s) =>
      !(await ctx.storage.metadata.get(s.item)).tags.includes("doomed"),
    survivesBreakage: false,
  },
  {
    name: "PUT /items/{id}/extensions/{namespace} writes a sidecar",
    family: "metadata",
    transactions: 0,
    breakage: () => breakWrite(ctx.storage.metadata, "setExtension"),
    setup: async () => ({ item: await makeNote("with sidecar") }),
    act: async (s) => {
      const res = await request(
        ctx.app,
        "PUT",
        `/items/${s.item}/extensions/${NAMESPACE}`,
        { key: ctx.spaceKey, body: { note: "sidecar" } },
      );
      return res.status === 200;
    },
    attributable: (h, s) => itemEventsFor(h, s.item),
    landed: async (s) =>
      (await ctx.storage.metadata.get(s.item)).extensions[NAMESPACE] !==
      undefined,
    survivesBreakage: false,
  },
  {
    name: "DELETE /items/{id}/extensions/{namespace} drops a sidecar",
    family: "metadata",
    transactions: 0,
    breakage: () => breakWrite(ctx.storage.metadata, "deleteExtension"),
    setup: async () => {
      const item = await makeNote("with sidecar");
      await request(ctx.app, "PUT", `/items/${item}/extensions/${NAMESPACE}`, {
        key: ctx.spaceKey,
        body: { note: "sidecar" },
      });
      return { item };
    },
    act: async (s) => {
      const res = await request(
        ctx.app,
        "DELETE",
        `/items/${s.item}/extensions/${NAMESPACE}`,
        { key: ctx.spaceKey },
      );
      return res.status === 200;
    },
    attributable: (h, s) => itemEventsFor(h, s.item),
    landed: async (s) =>
      (await ctx.storage.metadata.get(s.item)).extensions[NAMESPACE] ===
      undefined,
    survivesBreakage: false,
  },

  // --- edge ---------------------------------------------------------------
  {
    name: "POST /edges creates an edge",
    family: "edge",
    transactions: 1,
    setup: async () => ({
      item: await makeNote("edge source"),
      other: await makeNote("edge target"),
    }),
    act: async (s) => {
      const res = await request(ctx.app, "POST", "/edges", {
        key: ctx.spaceKey,
        body: {
          source_id: s.item,
          target_id: s.other,
          edge_type: "references",
        },
      });
      return res.status === 201;
    },
    attributable: (h, s) => edgeEventsTouching(h, [s.item, s.other]),
    landed: async (s) =>
      (await ctx.storage.edges.listFromSource(s.item)).data.length > 0,
    survivesBreakage: false,
  },
  {
    name: "PATCH /edges/{id} edits an edge's properties",
    family: "edge",
    transactions: 0,
    breakage: () => breakWrite(ctx.storage.edges, "updateProperties"),
    setup: async () => {
      const item = await makeNote("edge source");
      const other = await makeNote("edge target");
      return { item, other, edge: await makeEdge(item, other) };
    },
    act: async (s) => {
      // Each run gets its own setup, so the edge is still at the version it
      // was minted at.
      const res = await request(ctx.app, "PATCH", `/edges/${s.edge}`, {
        key: ctx.spaceKey,
        body: { properties: { note: "edited" }, version: 1 },
      });
      return res.status === 200;
    },
    attributable: (h, s) => edgeEventsTouching(h, [s.item, s.other]),
    landed: async (s) =>
      (await ctx.storage.edges.get(s.edge))?.properties.note === "edited",
    survivesBreakage: false,
  },
  {
    name: "DELETE /edges/{id} removes an edge",
    family: "edge",
    transactions: 0,
    breakage: () => breakWrite(ctx.storage.edges, "delete"),
    setup: async () => {
      const item = await makeNote("edge source");
      const other = await makeNote("edge target");
      return { item, other, edge: await makeEdge(item, other) };
    },
    act: async (s) => {
      const res = await request(ctx.app, "DELETE", `/edges/${s.edge}`, {
        key: ctx.spaceKey,
      });
      return res.status === 200;
    },
    attributable: (h, s) => edgeEventsTouching(h, [s.item, s.other]),
    landed: async (s) => (await ctx.storage.edges.get(s.edge)) === null,
    survivesBreakage: false,
  },

  // --- bulk ---------------------------------------------------------------
  {
    name: "POST /items/bulk writes an atomic batch",
    family: "bulk",
    transactions: 1,
    setup: async () => ({
      item: generateId(),
      other: await makeNote("bulk edge target"),
    }),
    act: async (s) => {
      const res = await request(ctx.app, "POST", "/items/bulk", {
        key: ctx.spaceKey,
        body: {
          atomic: true,
          items: [
            {
              id: s.item,
              type: "core.note",
              properties: { body: "bulk created" },
              source_id: uniq("bulk"),
              edges: { references: [s.other] },
            },
          ],
        },
      });
      return res.status === 200;
    },
    attributable: (h, s) => [
      ...itemEventsFor(h, s.item),
      ...edgeEventsTouching(h, [s.item]),
    ],
    landed: async (s) =>
      (await ctx.storage.items.getIncludingTrashed(s.item)) !== null,
    survivesBreakage: false,
  },
  {
    name: "POST /edges/bulk writes an atomic batch",
    family: "bulk",
    transactions: 1,
    setup: async () => ({
      item: await makeNote("bulk edge source"),
      other: await makeNote("bulk edge target"),
    }),
    act: async (s) => {
      const res = await request(ctx.app, "POST", "/edges/bulk", {
        key: ctx.spaceKey,
        body: {
          atomic: true,
          edges: [
            {
              source_id: s.item,
              target_id: s.other,
              edge_type: "references",
            },
          ],
        },
      });
      return res.status === 200;
    },
    attributable: (h, s) => edgeEventsTouching(h, [s.item, s.other]),
    landed: async (s) =>
      (await ctx.storage.edges.listFromSource(s.item)).data.length > 0,
    survivesBreakage: false,
  },
  {
    name: "POST /items/bulk-actions transitions a filtered set",
    family: "bulk",
    transactions: 1,
    setup: async () => {
      const tag = uniq("action");
      const item = await makeNote("bulk transition");
      await request(ctx.app, "POST", `/items/${item}/tags`, {
        key: ctx.spaceKey,
        body: { tags: [tag] },
      });
      return { item, tag };
    },
    act: async (s) => {
      const { result } = await runBulkActionAsync(
        ctx,
        {
          action: "transition",
          state: "archived",
          filter: { tags: [s.tag] },
        },
        ctx.spaceKey,
      );
      return result?.succeeded === 1;
    },
    attributable: (h, s) => itemEventsFor(h, s.item),
    landed: async (s) =>
      (await ctx.storage.items.getIncludingTrashed(s.item))?.state ===
      "archived",
    survivesBreakage: false,
  },
  {
    name: "POST /items/bulk-actions purges a filtered set",
    family: "bulk",
    transactions: 1,
    setup: async () => {
      const tag = uniq("action");
      const item = await makeNote("bulk purge");
      const other = await makeNote("pointing at it");
      const edge = await makeEdge(other, item);
      await request(ctx.app, "POST", `/items/${item}/tags`, {
        key: ctx.spaceKey,
        body: { tags: [tag] },
      });
      await request(ctx.app, "DELETE", `/items/${item}`, { key: ctx.spaceKey });
      return { item, other, edge, tag };
    },
    act: async (s) => {
      const { result } = await runBulkActionAsync(
        ctx,
        {
          action: "purge",
          confirm: "PURGE",
          filter: { tags: [s.tag], state: "trashed" },
        },
        ctx.spaceKey,
      );
      return result?.succeeded === 1;
    },
    // Both, for the same reason as the single-item door above.
    attributable: (h, s) => [
      ...itemEventsFor(h, s.item),
      ...edgeEventsTouching(h, [s.item, s.other]),
    ],
    landed: async (s) => (await ctx.storage.edges.get(s.edge)) === null,
    survivesBreakage: false,
  },
  {
    // The four arms below announce what they wrote unconditionally. They used
    // to write in silence, so a client rebuilding from the stream never
    // learned about a bulk retag or retier at all. Being announced is what
    // puts them in reach of this file: an announcement that can be wrong is
    // the only kind worth guarding.
    name: "POST /items/bulk-actions retags a filtered set",
    family: "bulk",
    transactions: 1,
    setup: async () => {
      const tag = uniq("action");
      const item = await makeNote("bulk retag");
      await request(ctx.app, "POST", `/items/${item}/tags`, {
        key: ctx.spaceKey,
        body: { tags: [tag] },
      });
      return { item, tag };
    },
    act: async (s) => {
      const { result } = await runBulkActionAsync(
        ctx,
        { action: "update_tags", add: ["retagged"], filter: { tags: [s.tag] } },
        ctx.spaceKey,
      );
      return result?.succeeded === 1;
    },
    attributable: (h, s) => itemEventsFor(h, s.item),
    landed: async (s) =>
      (await ctx.storage.metadata.get(s.item)).tags.includes("retagged"),
    survivesBreakage: false,
  },
  {
    name: "POST /items/bulk-actions retiers a filtered set",
    family: "bulk",
    transactions: 1,
    setup: async () => {
      const tag = uniq("action");
      const item = await makeNote("bulk retier");
      await request(ctx.app, "POST", `/items/${item}/tags`, {
        key: ctx.spaceKey,
        body: { tags: [tag] },
      });
      return { item, tag };
    },
    act: async (s) => {
      const { result } = await runBulkActionAsync(
        ctx,
        { action: "update_tier", tier: "feed", filter: { tags: [s.tag] } },
        ctx.spaceKey,
      );
      return result?.succeeded === 1;
    },
    attributable: (h, s) => itemEventsFor(h, s.item),
    landed: async (s) =>
      (await ctx.storage.items.getIncludingTrashed(s.item))?.tier === "feed",
    survivesBreakage: false,
  },
  {
    name: "POST /items/bulk-actions patches properties on a filtered set",
    family: "bulk",
    transactions: 1,
    setup: async () => {
      const tag = uniq("action");
      const item = await makeNote("before");
      await request(ctx.app, "POST", `/items/${item}/tags`, {
        key: ctx.spaceKey,
        body: { tags: [tag] },
      });
      return { item, tag };
    },
    act: async (s) => {
      const { result } = await runBulkActionAsync(
        ctx,
        {
          action: "update_properties",
          patch: { body: "after" },
          filter: { tags: [s.tag] },
        },
        ctx.spaceKey,
      );
      return result?.succeeded === 1;
    },
    attributable: (h, s) => itemEventsFor(h, s.item),
    landed: async (s) => (await itemBody(s.item)) === "after",
    survivesBreakage: false,
  },
  {
    name: "POST /items/bulk-actions restamps a filtered set",
    family: "bulk",
    transactions: 1,
    setup: async () => {
      const tag = uniq("action");
      const item = await makeNote("bulk restamp");
      await request(ctx.app, "POST", `/items/${item}/tags`, {
        key: ctx.spaceKey,
        body: { tags: [tag] },
      });
      return { item, tag };
    },
    act: async (s) => {
      const { result } = await runBulkActionAsync(
        ctx,
        {
          action: "update_occurred_at",
          occurred_at: RESTAMPED_AT,
          filter: { tags: [s.tag] },
        },
        ctx.spaceKey,
      );
      return result?.succeeded === 1;
    },
    attributable: (h, s) => itemEventsFor(h, s.item),
    landed: async (s) =>
      (await ctx.storage.items.getIncludingTrashed(s.item))?.occurred_at ===
      RESTAMPED_AT,
    survivesBreakage: false,
  },
];

// ---------------------------------------------------------------------------
// The two runs
// ---------------------------------------------------------------------------

describe("a rolled-back write announces nothing", () => {
  for (const door of doors) {
    describe(door.name, () => {
      it("announces what it wrote, and opens the transactions the table records", async () => {
        const state = { ...NO_STATE, ...(await door.setup()) };
        const census = countTransactions();
        let succeeded = false;
        let heard: Heard;
        try {
          heard = await hear(async () => {
            succeeded = await door.act(state);
          });
        } finally {
          census.restore();
        }

        expect(succeeded).toBe(true);
        await expect(door.landed(state)).resolves.toBe(true);
        // The control that makes the negative run mean something: this
        // subscriber can hear this door.
        expect(heard.logged).toBeGreaterThan(0);
        expect(door.attributable(heard, state).length).toBeGreaterThan(0);
        // Observed rather than assumed. Exact, so a second transaction is a
        // finding rather than a shrug — see the table's `transactions`.
        expect(census.fired()).toBe(door.transactions);
      });

      it("announces nothing when the write is forced to come apart", async () => {
        const state = { ...NO_STATE, ...(await door.setup()) };
        const injection =
          door.transactions > 0 ? rollBackAfterTheWrite() : door.breakage!();
        let succeeded = true;
        let heard: Heard;
        try {
          heard = await hear(async () => {
            succeeded = await door.act(state);
          });
        } finally {
          injection.restore();
        }

        // A guard whose probe never engaged has proved nothing.
        expect(injection.fired()).toBeGreaterThan(0);
        expect(succeeded).toBe(false);
        expect(door.attributable(heard, state)).toEqual([]);
        expect(heard.logged).toBe(0);
        await expect(door.landed(state)).resolves.toBe(door.survivesBreakage);
      });
    });
  }
});

// ---------------------------------------------------------------------------
// Coverage
// ---------------------------------------------------------------------------

/**
 * Where the server publishes, and how many times each file does it.
 *
 * **Over call sites rather than registered routes, and that is the point.**
 * A route walk answers "did somebody add a route", and the way this guard
 * actually goes stale is somebody adding a publish to a route that already
 * has a row: a bulk-action arm that starts announcing, a second event on a
 * door that emitted one. That is invisible to a route walk and is exactly
 * what a per-file count catches. The door table above is the human half;
 * this is the mechanical half that makes it stay honest.
 *
 * Definitions are not sites, so `pubsub.ts` is absent by construction.
 *
 * **A site is not a door.** A file that routes several doors through one
 * local fan-out helper spends one site on all of them, so these numbers
 * are smaller than the door count and move differently. That is why a
 * changed number sends you to the file rather than to arithmetic: what it
 * tells you is that the publishing shape moved, not how many doors moved
 * with it.
 *
 * When this fails, the number is never the fix on its own. Work out which
 * door grew the publish, give it a row in `doors` and drive it both ways, or
 * move the file into `PUBLISHES_OUT_OF_SCOPE` with a reason. Editing the
 * count to match is how a guard becomes a formality.
 */
interface PublishingFile {
  /** Call sites of `publish` / `publishEdge` / `announceInlineEdges`. */
  sites: number;
  why: string;
}

/** Files whose publishes are driven by a door in the table above. */
const PUBLISHES_UNDER_GUARD: Record<string, PublishingFile> = {
  "routes/items.ts": {
    sites: 16,
    why: "create, upsert, patch, the conflicted copy a resolving patch spawns, delete, the two promote emits, the two the purge door emits, and the four tag and metadata doors",
  },
  "routes/items-lifecycle.ts": { sites: 2, why: "transition and restore" },
  "routes/edges.ts": { sites: 3, why: "edge create, update and delete" },
  "routes/extensions.ts": { sites: 2, why: "the two extension doors" },
  "routes/bulk.ts": {
    sites: 2,
    why: "the atomic item batch and its inline edges",
  },
  "routes/edges-bulk.ts": { sites: 2, why: "the atomic edge batch" },
  "bulk-actions/runner.ts": {
    sites: 5,
    why: "six arms through five sites: transition and update_tags publish for themselves, purge announces its cascade and its rows through two, and the three property-shaped arms share one local helper",
  },
  "routes/_edges-inline.ts": {
    sites: 2,
    why: "the shared inline-edge announcer, reached only by doors that have a row",
  },
};

/**
 * Files that publish outside this file's scope.
 *
 * **Their events are not lesser ones.** Every entry here puts an ordinary
 * item event on the same stream a durable client persists, so a phantom from
 * any of them would cost a client exactly what a phantom from a write door
 * costs. They are excluded because this file speaks for the doors a client
 * writes its own graph through, which is a boundary drawn on purpose. Listed
 * rather than omitted so the next reader can see the decision and reopen it.
 */
const PUBLISHES_OUT_OF_SCOPE: Record<string, PublishingFile> = {
  "routes/auth-pages.ts": { sites: 2, why: "grant projection at sign-in" },
  "routes/auth-consent.ts": { sites: 1, why: "grant projection at consent" },
  "routes/admin-archive.ts": {
    sites: 2,
    why: "archive restore, an admin surface: the items it wrote and the edges between them, in that order",
  },
  "enrichment/sweeper.ts": {
    sites: 1,
    why: "a background sweeper, outside a request",
  },
};

/** Strip comments so a `publish()` written in prose is not counted. */
function scanForPublishSites(): Map<string, number> {
  const srcRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const found = new Map<string, number>();
  const entries = readdirSync(srcRoot, { recursive: true, encoding: "utf8" });
  for (const entry of entries) {
    if (!entry.endsWith(".ts") || entry.endsWith(".test.ts")) continue;
    const text = readFileSync(join(srcRoot, entry), "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/\/\/[^\n]*/g, "")
      // A definition is not a call site.
      .replace(
        /(?:async\s+)?function\s+(?:publish|publishEdge|announceInlineEdges)\s*\(/g,
        "DEFINITION(",
      );
    const sites =
      text.match(
        /(?<![A-Za-z0-9_$.])(?:publish|publishEdge|announceInlineEdges)\s*\(/g,
      )?.length ?? 0;
    if (sites > 0) found.set(entry.split(sep).join("/"), sites);
  }
  return found;
}

describe("every publish in the server is accounted for", () => {
  it("is under a door, or named with a reason it is not", () => {
    const found = scanForPublishSites();

    for (const [file, sites] of found) {
      const declared =
        PUBLISHES_UNDER_GUARD[file] ?? PUBLISHES_OUT_OF_SCOPE[file];
      // A file nobody classified. Decide which half it belongs in; that
      // decision is the whole value of this check.
      expect(declared, `unclassified publishing file: ${file}`).toBeDefined();
      expect(
        sites,
        `publish sites changed in ${file}: give each new one a door row, or move the file out of scope with a reason`,
      ).toBe(declared?.sites);
    }

    // The other direction. An entry left behind after its publishes moved
    // stops covering anything, silently, and the next publish to land in
    // that file inherits a count that was never about it.
    for (const file of [
      ...Object.keys(PUBLISHES_UNDER_GUARD),
      ...Object.keys(PUBLISHES_OUT_OF_SCOPE),
    ]) {
      expect(found.has(file), `stale entry, no longer publishes: ${file}`).toBe(
        true,
      );
    }

    // A file cannot be both guarded and out of scope.
    for (const file of Object.keys(PUBLISHES_UNDER_GUARD)) {
      expect(file in PUBLISHES_OUT_OF_SCOPE, `${file} is in both maps`).toBe(
        false,
      );
    }
  });
});
