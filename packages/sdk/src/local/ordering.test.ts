/**
 * What waits behind what, and what a reconnect is allowed to refuse.
 *
 * Both rules are about a queue that is not empty, which is the state the
 * engine is in whenever it matters and the one the earlier scenarios kept
 * arranging away.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MarfaClient } from "../client.js";
import {
  createKeysModeFixture,
  type KeysModeFixture,
} from "../test-harness.js";
import { createOutboxDrain, type OutboxDrain } from "./drain.js";
import { importAll } from "./import.js";
import { createOfflineSeam, type OfflineSeam } from "./offline-seam.js";
import { createLocalSync, type LocalSync } from "./sync.js";
import { openLocalStore, type LocalStore } from "./store/index.js";
import {
  SINGLE_ACCOUNT,
  SINGLE_SPACE,
  type LocalEngineEvent,
} from "./types.js";

let fixture: KeysModeFixture;
let seam: OfflineSeam;
let client: MarfaClient;
let store: LocalStore;
let drain: OutboxDrain;
let events: LocalEngineEvent[];
let watchers: {
  match: (event: LocalEngineEvent) => boolean;
  resolve: () => void;
}[];
let running: LocalSync[];
let dir: string;

const identity = {
  origin: "http://localhost",
  spaceId: SINGLE_SPACE,
  accountId: SINGLE_ACCOUNT,
};

const AT = "2026-09-01T00:00:00.000Z";

function record(event: LocalEngineEvent): void {
  events.push(event);
  for (const watcher of watchers.splice(0)) {
    if (watcher.match(event)) watcher.resolve();
    else watchers.push(watcher);
  }
}

function reports(match: (event: LocalEngineEvent) => boolean): Promise<void> {
  return new Promise((resolve) => {
    if (events.some(match)) {
      resolve();
      return;
    }
    watchers.push({ match, resolve });
  });
}

function startSync(initialRetryMs?: number): LocalSync {
  const sync = createLocalSync({
    store,
    client,
    drain,
    ...(initialRetryMs === undefined ? {} : { initialRetryMs }),
    onEvent: record,
  });
  running.push(sync);
  return sync;
}

beforeEach(async () => {
  fixture = await createKeysModeFixture();
  seam = createOfflineSeam(fixture.fetch);
  client = new MarfaClient({
    url: "http://localhost",
    apiKey: fixture.adminKey,
    fetch: seam.fetch,
  });
  dir = mkdtempSync(join(tmpdir(), "marfa-local-ordering-"));
  store = await openLocalStore({ path: join(dir, "store.db"), identity });
  drain = createOutboxDrain({ store, client, onEvent: record });
  events = [];
  watchers = [];
  running = [];
});

afterEach(() => {
  for (const sync of running) sync.stop();
  store.close();
  fixture.cleanup();
  rmSync(dir, { recursive: true, force: true });
});

describe("what a queued write holds back (seam: offline while queued, then online)", () => {
  it("holds an edge behind an endpoint's unsent create, and nothing else", async () => {
    seam.mode = "offline";
    const anchor = await store.mutations.createItem({
      type: "core.note",
      properties: { body: "anchor" },
    });
    const other = await store.mutations.createItem({
      type: "core.note",
      properties: { body: "other" },
    });
    const edge = await store.mutations.createEdge({
      source_id: anchor.id,
      target_id: other.id,
      edge_type: "references",
    });
    await store.mutations.updateItem(other.id, { title: "edited after" });

    // The anchor's create parked, so it is going nowhere on its own. The
    // edge names it as an endpoint and cannot be sent against a row the
    // server does not have.
    const queued = await store.outbox.list();
    await store.outbox.block(queued[0]!.seq, "needs_review", AT);

    seam.mode = "online";
    seam.reset();
    await drain.drain();

    // The edge waited. Sending it would have been a write against an id
    // the server has never seen, and the refusal would have dead-lettered
    // a relationship the person actually made.
    expect(seam.calls).not.toContain("POST /edges");
    expect(
      (await store.outbox.list()).some((e) => e.targetId === edge.id),
    ).toBe(true);

    // The other endpoint's own create and edit went, because nothing they
    // wait on is held. An edge is held back by its endpoints; an endpoint
    // is not held back by its edges, and the two are not symmetric.
    expect(seam.calls).toContain("POST /items");
    expect(await client.items.get(other.id)).toMatchObject({
      properties: { title: "edited after" },
    });
  });

  it("does not starve an item behind a parked edge that names it", async () => {
    const anchor = await client.items.create({
      type: "core.note",
      properties: { body: "anchor" },
    });
    const other = await client.items.create({
      type: "core.note",
      properties: { body: "other" },
    });
    const edge = await client.edges.create({
      edge_type: "references",
      source_id: anchor.id,
      target_id: other.id,
    });
    await importAll({ store, client, prune: false });

    // An edge edit that is going nowhere, and then an ordinary edit to one
    // of the rows it happens to touch.
    await store.mutations.updateEdge(edge.id, { note: "parked" });
    const parked = (await store.outbox.list())[0];
    await store.outbox.block(parked!.seq, "needs_review", AT);
    await store.mutations.updateItem(anchor.id, { title: "still wanted" });

    seam.reset();
    await drain.drain();

    // The item is not a dependant of the edge. Holding it back would strand
    // it for ever: skipped on every pass, never sent, never blocked, never
    // dead-lettered, counted as pending with no reason attached, and
    // clearing only on an app action against an edge that has nothing to
    // do with it.
    expect(await client.items.get(anchor.id)).toMatchObject({
      properties: { title: "still wanted" },
    });
    expect(
      (await store.outbox.list()).filter((e) => e.targetKind === "item"),
    ).toEqual([]);
  });
});

describe("a reconnect while something is queued (seam: stream_close, then online)", () => {
  it("catches up rather than refusing over the queue", async () => {
    await client.items.create({
      type: "core.note",
      properties: { body: "there at the start" },
    });

    seam.mode = "stream_close";
    await startSync(5).start();

    // An ordinary local write, unsent because nothing has drained it. The
    // catch-up that runs on the next reconnect reads and writes through the
    // version comparison and prunes nothing, so it cannot touch this row —
    // refusing over it buys nothing and costs the reconnect.
    await store.mutations.createItem({
      type: "core.note",
      properties: { body: "queued while reconnecting" },
    });
    expect(await store.outbox.count()).toBe(1);

    await reports((event) => event.type === "catchup.finished");
    expect(await store.outbox.count()).toBe(1);
  });

  it("asks from the older of the two marks, not the newer", async () => {
    const anchor = await client.items.create({
      type: "core.note",
      properties: { body: "anchor" },
    });
    const other = await client.items.create({
      type: "core.note",
      properties: { body: "other" },
    });
    await importAll({ store, client, prune: false });

    // Two halves of the graph at different points in time. The edge half
    // is behind, because nothing has written an edge yet.
    const edge = await client.edges.create({
      edge_type: "references",
      source_id: anchor.id,
      target_id: other.id,
    });
    await store.server.edges.put({ ...edge, updated_at: edge.created_at });
    await client.items.update(anchor.id, { title: "much later" });
    await importAll({
      store,
      client,
      prune: false,
      updatedAfter: (await store.server.edges.maxUpdatedAt()) ?? "",
    });

    const itemMark = await store.server.items.maxUpdatedAt();
    const edgeMark = await store.server.edges.maxUpdatedAt();
    if (itemMark === undefined || edgeMark === undefined) {
      throw new Error("expected both halves to hold something");
    }
    expect(edgeMark < itemMark).toBe(true);

    // Something changed on the older half after that half's mark and
    // before the newer half's.
    await client.edges.update(edge.id, { note: "changed in the gap" });
    const changed = (await client.edges.list({ edge_type: "references" }))
      .data[0];
    if (changed === undefined) throw new Error("expected the edge");

    // Already hydrated, so starting does not read the corpus again and
    // move the marks this scenario just arranged.
    await store.syncState.setHydratedAt(identity, AT);

    // Through a reconnect, which is what runs the catch-up. Every
    // connection carries its opening frame and then ends, so nothing
    // arrives live and the catch-up is the only way the change can reach
    // this store.
    seam.mode = "stream_close";
    await startSync(5).start();
    await reports((event) => event.type === "catchup.finished");

    // Taking the newer of the two marks would ask both halves for
    // everything since the item's clock, which is past the edge's own, so
    // a change to the older half in between is never asked for and
    // nothing later mentions it.
    const caught = events.find((event) => event.type === "catchup.finished");
    expect(caught).toMatchObject({ since: edgeMark });
    expect(changed.properties).toMatchObject({ note: "changed in the gap" });

    await settles(
      () => store.server.edges.get(edge.id),
      (row) => row?.properties.note === "changed in the gap",
    );
  });

  it("reads a slice over a pending write and refuses only a prune", async () => {
    await client.items.create({
      type: "core.note",
      properties: { body: "on the server" },
    });
    await store.mutations.createItem({
      type: "core.note",
      properties: { body: "not sent yet" },
    });

    // The refusal belongs to the read that removes rows, because that is
    // the one measuring the corpus against a listing a pending write is
    // about to change. A slice that only ever writes forward is not.
    await expect(
      importAll({ store, client, prune: false }),
    ).resolves.toMatchObject({ prunedItems: 0 });
    await expect(importAll({ store, client, prune: true })).rejects.toThrow(
      /waiting to be sent/,
    );
  });
});

async function settles<T>(
  read: () => Promise<T>,
  want: (value: T) => boolean,
): Promise<T> {
  for (;;) {
    const value = await read();
    if (want(value)) return value;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
