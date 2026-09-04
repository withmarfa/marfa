/**
 * The stream and hydration scenarios from the sync contract.
 *
 * Against the in-process server through `createKeysModeFixture`, with the
 * transport swapped for `createOfflineSeam`. Each scenario names the seam
 * mode it uses in its own title.
 *
 * **The fixture serves live frames and no event ids.** `createApp` does not
 * wire the event log — that happens in the server's own bootstrap — so
 * every frame here arrives without an id, the log is empty, and nothing
 * replays. What that leaves out is named where it bites; the cursor rules
 * are covered against the store directly in `apply.test.ts`.
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
import { createOutboxDrain } from "./drain.js";
import { importAll, PendingWritesError } from "./import.js";
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
let events: LocalEngineEvent[];
let running: LocalSync[];
let dir: string;

const identity = {
  origin: "http://localhost",
  spaceId: SINGLE_SPACE,
  accountId: SINGLE_ACCOUNT,
};

/**
 * Resolve when the engine reports something matching.
 *
 * The engine's own report rather than a poll: a loop with a deadline in it
 * turns a hang into an assertion failure that names the wrong thing, and
 * the runner already owns the timeout.
 */
function reports(match: (event: LocalEngineEvent) => boolean): Promise<void> {
  return new Promise((resolve) => {
    const found = events.find(match);
    if (found !== undefined) {
      resolve();
      return;
    }
    watchers.push({ match, resolve });
  });
}
let watchers: {
  match: (event: LocalEngineEvent) => boolean;
  resolve: () => void;
}[];

function startSync(options?: { initialRetryMs?: number }): LocalSync {
  const sync = createLocalSync({
    store,
    client,
    drain: createOutboxDrain({ store, client }),
    ...(options?.initialRetryMs === undefined
      ? {}
      : { initialRetryMs: options.initialRetryMs }),
    onEvent: (event) => {
      events.push(event);
      for (const watcher of watchers.splice(0)) {
        if (watcher.match(event)) watcher.resolve();
        else watchers.push(watcher);
      }
    },
  });
  running.push(sync);
  return sync;
}

/** Wait for the store to hold something the stream is expected to deliver.
 *  The frames carry no ids here, so there is no engine report to wait on
 *  and the store itself is the only signal. */
async function settles<T>(read: () => Promise<T>, want: (v: T) => boolean) {
  for (;;) {
    const value = await read();
    if (want(value)) return value;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

beforeEach(async () => {
  fixture = await createKeysModeFixture();
  seam = createOfflineSeam(fixture.fetch);
  client = new MarfaClient({
    url: "http://localhost",
    apiKey: fixture.adminKey,
    fetch: seam.fetch,
  });
  dir = mkdtempSync(join(tmpdir(), "marfa-local-stream-"));
  store = await openLocalStore({ path: join(dir, "store.db"), identity });
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

describe("hydrating a fresh store (seam: online)", () => {
  it("subscribes before it reads, and takes every state", async () => {
    const kept = await client.items.create({
      type: "core.note",
      properties: { body: "kept" },
    });
    const binned = await client.items.create({
      type: "core.note",
      properties: { body: "binned" },
    });
    await client.edges.create({
      edge_type: "references",
      source_id: kept.id,
      target_id: binned.id,
    });
    await client.metadata.addTags(kept.id, ["filed"]);
    await client.items.delete(binned.id);

    seam.reset();
    await startSync().start();

    // The order is the rule. Reading first leaves a window between the
    // read finishing and the subscription opening that nothing covers and
    // nothing afterwards reports; subscribing first turns that window into
    // an overlap, which the version comparison makes free.
    expect(seam.calls).toEqual([
      "GET /events",
      // The count the progress reports are measured against, read once
      // before the walk rather than per page: a denominator that moved
      // while the read ran would make every fraction built on it a
      // different question.
      "GET /items/stats",
      "GET /items",
      "GET /edges",
    ]);

    // Every state, so a row reaching the bin is something this client can
    // see rather than a row that silently stops being mentioned.
    const held = await store.server.items.list();
    expect(new Map(held.map((row) => [row.id, row.state]))).toEqual(
      new Map([
        [kept.id, "active"],
        [binned.id, "trashed"],
      ]),
    );
    expect(await store.server.edges.list()).toHaveLength(1);
    expect(await store.server.metadata.get(kept.id)).toMatchObject({
      tags: ["filed"],
    });

    // The control. An unrecognized query parameter is dropped rather than
    // refused, so a read that asked for every state and a read that asked
    // for nothing come back looking identical when the filter is not
    // honored. The default listing returns one row where the store holds
    // two, which is the same request without `state` and the only thing
    // that proves the parameter did any work.
    const itemRead = seam.requests.find((r) => r.path === "/items");
    expect(itemRead?.query).toMatchObject({ state: "any" });
    expect((await client.items.list({})).data).toHaveLength(1);

    expect(events).toContainEqual(
      expect.objectContaining({ type: "hydration.finished", edges: 1 }),
    );
    expect((await store.syncState.read(identity))?.hydratedAt).not.toBeNull();
  });
});

describe("an event for a row this client is editing (seam: online)", () => {
  it("changes what the server said without hiding the unsent edit", async () => {
    const note = await client.items.create({
      type: "core.note",
      properties: { body: "as written" },
    });
    await startSync().start();

    // An edit made here and not yet sent, and another device changing a
    // different field underneath it.
    await store.mutations.updateItem(note.id, { title: "mine, unsent" });
    await client.items.update(note.id, { body: "theirs" });

    await settles(
      () => store.server.items.get(note.id),
      (row) => row?.properties.body === "theirs",
    );

    // Three layers doing their job. The event changed server state; the
    // queue still holds the edit; what a person sees is the two composed.
    // A store that kept one merged copy would have to choose, and would
    // choose wrongly in one direction or the other.
    expect(await store.visible.getItem(note.id)).toMatchObject({
      properties: { body: "theirs", title: "mine, unsent" },
    });
    expect(await store.outbox.count()).toBe(1);
  });
});

describe("a removal that arrives while the client is watching (seam: online)", () => {
  it("keeps a trashed row and takes a purged one away", async () => {
    const note = await client.items.create({
      type: "core.note",
      properties: { body: "goes" },
    });
    const other = await client.items.create({
      type: "core.note",
      properties: { body: "stays" },
    });
    const edge = await client.edges.create({
      edge_type: "references",
      source_id: other.id,
      target_id: note.id,
    });
    await startSync().start();
    expect(await store.server.edges.get(edge.id)).toBeDefined();

    await client.items.delete(note.id);
    await settles(
      () => store.server.items.get(note.id),
      (row) => row?.state === "trashed",
    );

    await client.items.purge(note.id);
    await settles(
      () => store.server.items.get(note.id),
      (row) => row === undefined,
    );

    // The edge went with it, on its own event. Nothing here computes a
    // cascade: the server publishes what it removed, and a client that
    // inferred instead would be maintaining a second copy of the server's
    // cascade rules.
    await settles(
      () => store.server.edges.get(edge.id),
      (row) => row === undefined,
    );
  });
});

describe("a connection that closes (seam: stream_close, then online)", () => {
  it("reads what changed while it was away before trusting the new one", async () => {
    const anchor = await client.items.create({
      type: "core.note",
      properties: { body: "there at the start" },
    });

    // Every connection carries its first frame and then ends, so the
    // subscription reconnects. What arrives in between reaches no live
    // frame, which is the gap the catch-up exists to close.
    seam.mode = "stream_close";
    await startSync({ initialRetryMs: 5 }).start();

    const missed = await client.items.create({
      type: "core.note",
      properties: { body: "arrived while disconnected" },
    });
    const missedEdge = await client.edges.create({
      edge_type: "references",
      source_id: missed.id,
      target_id: anchor.id,
    });

    seam.reset();
    await reports((event) => event.type === "catchup.finished");

    expect(await store.server.items.get(missed.id)).toMatchObject({
      properties: { body: "arrived while disconnected" },
    });
    expect(await store.server.edges.get(missedEdge.id)).toBeDefined();

    // Narrowed, not re-read whole. Both halves carry the bound: an
    // items-only catch-up would leave an edge changed in the gap
    // unreachable until something else happened to it.
    const reads = seam.requests.filter((r) => r.method === "GET");
    const itemRead = reads.find((r) => r.path === "/items");
    const edgeRead = reads.find((r) => r.path === "/edges");
    expect(itemRead?.query.updated_after).toBeDefined();
    expect(edgeRead?.query.updated_after).toBeDefined();

    // The control, on the same server through the same client: the bound
    // is honored rather than dropped, so a value nothing can satisfy
    // returns nothing. Without this the assertions above pass just as
    // happily on a read that was never filtered at all.
    const impossible = "2099-01-01T00:00:00.000Z";
    expect(
      (await client.items.list({ state: "any", updated_after: impossible }))
        .data,
    ).toHaveLength(0);
    expect((await client.items.list({ state: "any" })).data.length).toBe(2);
    expect(
      (await client.edges.list({ updated_after: impossible })).data,
    ).toHaveLength(0);
    expect((await client.edges.list({})).data).toHaveLength(1);
  });
});

/**
 * No subscription in this block, deliberately. A re-import is what a
 * client does after being away long enough that the log cannot catch it
 * up, and a live stream would deliver every removal below as it happened —
 * leaving the prune with nothing to find and the scenario proving nothing.
 */
describe("re-importing after being away (seam: online, no subscription)", () => {
  it("prunes items and edges the server no longer has", async () => {
    const kept = await client.items.create({
      type: "core.note",
      properties: { body: "kept" },
    });
    const goes = await client.items.create({
      type: "core.note",
      properties: { body: "goes while away" },
    });
    const keptEdge = await client.edges.create({
      edge_type: "references",
      source_id: kept.id,
      target_id: goes.id,
    });
    const goesEdge = await client.edges.create({
      edge_type: "about",
      source_id: goes.id,
      target_id: kept.id,
    });
    await importAll({ store, client, prune: false });
    expect(await store.server.edges.list()).toHaveLength(2);

    // Removed with nothing watching, and past anything the log could
    // replay. A re-import is the only thing that can ever notice.
    await client.edges.delete(goesEdge.id);
    await client.items.delete(goes.id);
    await client.items.purge(goes.id);

    const result = await importAll({ store, client, prune: true });

    // Both halves. The items-only version of this passes every assertion
    // about items and leaves the client holding a relationship to a row it
    // has correctly forgotten — which nothing later corrects, because the
    // event that would have said so is outside the window.
    expect(result).toMatchObject({ prunedItems: 1, prunedEdges: 2 });
    expect(await store.server.items.get(goes.id)).toBeUndefined();
    expect(await store.server.edges.get(goesEdge.id)).toBeUndefined();
    // The edge pointing at the purged row went with it, on the server's
    // own cascade. Nothing here computes that: it is absent from the read.
    expect(await store.server.edges.get(keptEdge.id)).toBeUndefined();
    expect(await store.server.items.get(kept.id)).toBeDefined();
  });

  it("never removes a row this client has not sent yet", async () => {
    // A create the server has never seen, parked for review so that a
    // drain cannot clear it. The row exists nowhere but here, so the read
    // was never going to return it — and pruning against that read would
    // delete the write itself.
    const unsent = await store.mutations.createItem({
      type: "core.note",
      properties: { body: "only here" },
    });
    const queued = (await store.outbox.list())[0];
    if (queued === undefined) throw new Error("expected a queued create");
    await store.outbox.block(
      queued.seq,
      "needs_review",
      "2026-09-01T00:00:00.000Z",
    );

    const result = await importAll({ store, client, prune: true });

    expect(result.prunedItems).toBe(0);
    expect(await store.visible.getItem(unsent.id)).toMatchObject({
      properties: { body: "only here" },
    });
  });

  it("refuses to read over a write that is still going out", async () => {
    await store.mutations.createItem({
      type: "core.note",
      properties: { body: "on its way" },
    });

    // A read landing while a write is in flight records a server state the
    // write is about to change, and the prune then measures the corpus
    // against it. Drain first is the contract's answer and this is what
    // enforces it — a blocked row is a different matter, since nothing is
    // going to send it and refusing on one would strand the client that
    // most needs to re-import.
    await expect(importAll({ store, client, prune: true })).rejects.toThrow(
      PendingWritesError,
    );
  });
});
