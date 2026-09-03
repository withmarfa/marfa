/**
 * A write that is undone tells the stream nothing.
 *
 * A durable client persists what the stream says and moves its cursor past
 * it. An event published for a write that then rolls back becomes a row on
 * that client which nothing will ever correct, short of a full re-import: a
 * cached client forgets on reload, a durable one does not. So the ordering
 * is not a nicety — publish is downstream of the write landing, on every
 * door, or the door can manufacture a phantom.
 *
 * **The local emitter is the thing to watch, not the event log.** On
 * Postgres the cross-process half already rides the surrounding transaction
 * (`event-replication.ts` announces over `pg_notify`, delivered on commit),
 * and a publish moved inside a transaction would have its `event_log` row
 * rolled back with everything else. The `emitter.emit` inside `publish()` is
 * unconditional and synchronous, so a same-process subscriber — SSE viewers,
 * outbound webhook delivery, the reactive bridges — is exactly who receives
 * the phantom. Every assertion below is therefore made against a live
 * subscriber first and the event log second.
 *
 * **Each door is proved twice.** Once unbroken, so the subscriber is known
 * to hear this door at all — a negative assertion against a probe that could
 * never have seen anything is not evidence — and once with the write forced
 * to come apart. Two shapes of breakage, because the doors are two shapes:
 *
 *   - A door that wraps its write in `storage.runInTransaction` is broken by
 *     rolling that transaction back the instant its last write lands. That
 *     is the ticket's own probe, and the only one that reaches the case
 *     where the write really did happen and really was undone.
 *   - A door that opens no transaction has nothing to roll back. Its write
 *     is a single statement and the property reduces to ordering, so it is
 *     broken by making that write throw. Weaker, and honest about it: it
 *     catches a publish moved above the write and nothing else.
 *
 * Which shape each door is, is measured rather than assumed. The unbroken
 * run counts the transactions the door opens and the table below has to
 * agree, so a door that later grows a transaction reddens here and its
 * publish placement gets looked at rather than inherited.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { generateId } from "@withmarfa/shared";
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
  __resetCycleDetectionForTests,
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
  __resetCycleDetectionForTests();
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
 * door reading one it never minted gets an empty string and a request that
 * fails visibly — rather than the string `undefined` inside a URL, which
 * routes as a malformed id and reads as a real refusal.
 */
interface DoorState {
  item: string;
  other: string;
  edge: string;
  sourceId: string;
  tag: string;
}

const NO_STATE: DoorState = {
  item: "",
  other: "",
  edge: "",
  sourceId: "",
  tag: "",
};

interface Door {
  name: string;
  family: Family;
  /**
   * Whether the door wraps its write in `storage.runInTransaction`. Asserted
   * against the count taken on the unbroken run, so this is a record of what
   * the door does rather than a claim about it.
   */
  transactional: boolean;
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

function uniq(prefix: string): string {
  return `${prefix}-${Math.random().toString(36).slice(2, 10)}`;
}

async function makeNote(body = "seed"): Promise<string> {
  const res = await request(ctx.app, "POST", "/items", {
    key: ctx.adminKey,
    body: { type: "core.note", properties: { body }, source_id: uniq("seed") },
  });
  expect(res.status).toBe(201);
  return ((await res.json()) as { item: { id: string } }).item.id;
}

async function makeEdge(source: string, target: string): Promise<string> {
  const res = await request(ctx.app, "POST", "/edges", {
    key: ctx.adminKey,
    body: { source_id: source, target_id: target, edge_type: "references" },
  });
  expect(res.status).toBe(201);
  return ((await res.json()) as { edge: { id: string } }).edge.id;
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
    transactional: true,
    setup: () => Promise.resolve({ item: generateId() }),
    act: async (s) => {
      const res = await request(ctx.app, "POST", "/items", {
        key: ctx.adminKey,
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
    transactional: true,
    setup: async () => ({
      item: generateId(),
      other: await makeNote("target"),
    }),
    act: async (s) => {
      const res = await request(ctx.app, "POST", "/items", {
        key: ctx.adminKey,
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
    transactional: true,
    setup: async () => {
      const sourceId = uniq("natural");
      const res = await request(ctx.app, "POST", "/items", {
        key: ctx.adminKey,
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
        key: ctx.adminKey,
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
    transactional: true,
    setup: async () => {
      const item = await makeNote("before");
      const other = await makeNote("new target");
      const stale = await makeNote("stale target");
      await request(ctx.app, "PATCH", `/items/${item}`, {
        key: ctx.adminKey,
        body: { edges: { references: [stale] } },
      });
      return { item, other };
    },
    act: async (s) => {
      const res = await request(ctx.app, "PATCH", `/items/${s.item}`, {
        key: ctx.adminKey,
        body: {
          properties: { body: "after" },
          edges: { references: [s.other] },
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
    name: "DELETE /items/{id} trashes an item",
    family: "item",
    transactional: true,
    setup: async () => ({ item: await makeNote("doomed") }),
    act: async (s) => {
      const res = await request(ctx.app, "DELETE", `/items/${s.item}`, {
        key: ctx.adminKey,
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
    transactional: false,
    breakage: () => breakWrite(ctx.storage.items, "transition"),
    setup: async () => ({ item: await makeNote("transitioning") }),
    act: async (s) => {
      const res = await request(
        ctx.app,
        "POST",
        `/items/${s.item}/transition`,
        {
          key: ctx.adminKey,
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
    transactional: false,
    breakage: () => breakWrite(ctx.storage.items, "restore"),
    setup: async () => {
      const item = await makeNote("to restore");
      await request(ctx.app, "DELETE", `/items/${item}`, { key: ctx.adminKey });
      return { item };
    },
    act: async (s) => {
      const res = await request(ctx.app, "POST", `/items/${s.item}/restore`, {
        key: ctx.adminKey,
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
    transactional: false,
    // The edge is the second of two writes and the only thing this door
    // announces, so it is what the breakage has to reach.
    breakage: () => breakWrite(ctx.storage.edges, "createRaw"),
    setup: async () => {
      // Promotion is defined against a row an integration wrote, and no
      // route stamps that source, so the mirror is planted through storage.
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
        key: ctx.adminKey,
      });
      return res.status === 201;
    },
    attributable: (h, s) => edgeEventsTouching(h, [s.item]),
    landed: async (s) =>
      (await ctx.storage.edges.listToTarget(s.item)).data.length > 0,
    // The edge is the announcement's whole subject and it never exists, so
    // there is nothing for a subscriber to have been told about. The
    // promoted item does survive — it is written first, outside any
    // transaction — which is an atomicity defect in this door rather than an
    // announcement one, and is not what this file is holding.
    survivesBreakage: false,
  },
  {
    name: "DELETE /items/{id}/purge removes an item and its edges",
    family: "item",
    transactional: false,
    breakage: () => breakWrite(ctx.storage.items, "purge"),
    setup: async () => {
      const item = await makeNote("to purge");
      const other = await makeNote("pointing at it");
      const edge = await makeEdge(other, item);
      await request(ctx.app, "DELETE", `/items/${item}`, { key: ctx.adminKey });
      return { item, other, edge };
    },
    act: async (s) => {
      const res = await request(ctx.app, "DELETE", `/items/${s.item}/purge`, {
        key: ctx.adminKey,
      });
      return res.status === 200;
    },
    attributable: (h, s) => edgeEventsTouching(h, [s.item, s.other]),
    landed: async (s) => (await ctx.storage.edges.get(s.edge)) === null,
    // The cascade deletes the edges before it purges the item, with nothing
    // holding the two together, so a failure at the purge leaves the edges
    // gone and their holders never told. Recorded, not fixed here.
    survivesBreakage: true,
  },

  // --- metadata -----------------------------------------------------------
  {
    name: "PUT /items/{id}/metadata replaces the tags",
    family: "metadata",
    transactional: false,
    breakage: () => breakWrite(ctx.storage.metadata, "set"),
    setup: async () => ({ item: await makeNote("tagged") }),
    act: async (s) => {
      const res = await request(ctx.app, "PUT", `/items/${s.item}/metadata`, {
        key: ctx.adminKey,
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
    transactional: false,
    breakage: () => breakWrite(ctx.storage.metadata, "merge"),
    setup: async () => ({ item: await makeNote("tagged") }),
    act: async (s) => {
      const res = await request(ctx.app, "PATCH", `/items/${s.item}/metadata`, {
        key: ctx.adminKey,
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
    transactional: false,
    breakage: () => breakWrite(ctx.storage.metadata, "addTags"),
    setup: async () => ({ item: await makeNote("tagged") }),
    act: async (s) => {
      const res = await request(ctx.app, "POST", `/items/${s.item}/tags`, {
        key: ctx.adminKey,
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
    transactional: false,
    breakage: () => breakWrite(ctx.storage.metadata, "removeTag"),
    setup: async () => {
      const item = await makeNote("tagged");
      await request(ctx.app, "POST", `/items/${item}/tags`, {
        key: ctx.adminKey,
        body: { tags: ["doomed"] },
      });
      return { item };
    },
    act: async (s) => {
      const res = await request(
        ctx.app,
        "DELETE",
        `/items/${s.item}/tags/doomed`,
        { key: ctx.adminKey },
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
    transactional: false,
    breakage: () => breakWrite(ctx.storage.metadata, "setExtension"),
    setup: async () => ({ item: await makeNote("with sidecar") }),
    act: async (s) => {
      const res = await request(
        ctx.app,
        "PUT",
        `/items/${s.item}/extensions/${NAMESPACE}`,
        { key: ctx.adminKey, body: { note: "sidecar" } },
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
    transactional: false,
    breakage: () => breakWrite(ctx.storage.metadata, "deleteExtension"),
    setup: async () => {
      const item = await makeNote("with sidecar");
      await request(ctx.app, "PUT", `/items/${item}/extensions/${NAMESPACE}`, {
        key: ctx.adminKey,
        body: { note: "sidecar" },
      });
      return { item };
    },
    act: async (s) => {
      const res = await request(
        ctx.app,
        "DELETE",
        `/items/${s.item}/extensions/${NAMESPACE}`,
        { key: ctx.adminKey },
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
    transactional: true,
    setup: async () => ({
      item: await makeNote("edge source"),
      other: await makeNote("edge target"),
    }),
    act: async (s) => {
      const res = await request(ctx.app, "POST", "/edges", {
        key: ctx.adminKey,
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
    transactional: false,
    breakage: () => breakWrite(ctx.storage.edges, "updateProperties"),
    setup: async () => {
      const item = await makeNote("edge source");
      const other = await makeNote("edge target");
      return { item, other, edge: await makeEdge(item, other) };
    },
    act: async (s) => {
      const res = await request(ctx.app, "PATCH", `/edges/${s.edge}`, {
        key: ctx.adminKey,
        body: { properties: { note: "edited" } },
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
    transactional: false,
    breakage: () => breakWrite(ctx.storage.edges, "delete"),
    setup: async () => {
      const item = await makeNote("edge source");
      const other = await makeNote("edge target");
      return { item, other, edge: await makeEdge(item, other) };
    },
    act: async (s) => {
      const res = await request(ctx.app, "DELETE", `/edges/${s.edge}`, {
        key: ctx.adminKey,
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
    transactional: true,
    setup: async () => ({
      item: generateId(),
      other: await makeNote("bulk edge target"),
    }),
    act: async (s) => {
      const res = await request(ctx.app, "POST", "/items/bulk", {
        key: ctx.adminKey,
        body: {
          atomic: true,
          emit_events: true,
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
    transactional: true,
    setup: async () => ({
      item: await makeNote("bulk edge source"),
      other: await makeNote("bulk edge target"),
    }),
    act: async (s) => {
      const res = await request(ctx.app, "POST", "/edges/bulk", {
        key: ctx.adminKey,
        body: {
          atomic: true,
          emit_events: true,
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
    transactional: true,
    setup: async () => {
      const tag = uniq("action");
      const item = await makeNote("bulk transition");
      await request(ctx.app, "POST", `/items/${item}/tags`, {
        key: ctx.adminKey,
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
          emit_events: true,
          filter: { tags: [s.tag] },
        },
        ctx.adminKey,
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
    transactional: true,
    setup: async () => {
      const tag = uniq("action");
      const item = await makeNote("bulk purge");
      const other = await makeNote("pointing at it");
      const edge = await makeEdge(other, item);
      await request(ctx.app, "POST", `/items/${item}/tags`, {
        key: ctx.adminKey,
        body: { tags: [tag] },
      });
      await request(ctx.app, "DELETE", `/items/${item}`, { key: ctx.adminKey });
      return { item, other, edge, tag };
    },
    act: async (s) => {
      const { result } = await runBulkActionAsync(
        ctx,
        {
          action: "purge",
          confirm: "PURGE",
          emit_events: true,
          filter: { tags: [s.tag], state: "trashed" },
        },
        ctx.adminKey,
      );
      return result?.succeeded === 1;
    },
    attributable: (h, s) => edgeEventsTouching(h, [s.item, s.other]),
    landed: async (s) => (await ctx.storage.edges.get(s.edge)) === null,
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
        // Observed rather than assumed — see the table's `transactional`.
        expect(census.fired() > 0).toBe(door.transactional);
      });

      it("announces nothing when the write is forced to come apart", async () => {
        const state = { ...NO_STATE, ...(await door.setup()) };
        const injection = door.transactional
          ? rollBackAfterTheWrite()
          : door.breakage!();
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
