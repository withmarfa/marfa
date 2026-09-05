/**
 * What the engine tells an app about itself, and what an app renders.
 *
 * The reporting and the projection together, because the two only mean
 * anything in each other's company: a status nothing displays is a shape
 * nobody has checked, and a collection with nothing driving it is a list
 * that never changes.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MarfaClient } from "../client.js";
import {
  createKeysModeFixture,
  type KeysModeFixture,
} from "../test-harness.js";
import { createLocalEngine, type LocalEngine } from "./engine.js";
import { createOfflineSeam, type OfflineSeam } from "./offline-seam.js";
import { createProjection } from "./projection.js";
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
let engine: LocalEngine;
let events: LocalEngineEvent[];
let dir: string;

const identity = {
  origin: "http://localhost",
  spaceId: SINGLE_SPACE,
  accountId: SINGLE_ACCOUNT,
};

beforeEach(async () => {
  fixture = await createKeysModeFixture();
  seam = createOfflineSeam(fixture.fetch);
  client = new MarfaClient({
    url: "http://localhost",
    apiKey: fixture.adminKey,
    fetch: seam.fetch,
  });
  dir = mkdtempSync(join(tmpdir(), "marfa-local-engine-"));
  store = await openLocalStore({ path: join(dir, "store.db"), identity });
  events = [];
  engine = createLocalEngine({ store, client });
  engine.on((event) => events.push(event));
});

afterEach(() => {
  engine.stop();
  store.close();
  fixture.cleanup();
  rmSync(dir, { recursive: true, force: true });
});

async function seedNotes(count: number): Promise<void> {
  for (let index = 0; index < count; index += 1) {
    await client.items.create({
      type: "core.note",
      properties: { body: `note ${String(index)}` },
    });
  }
}

describe("hydration progress (seam: online)", () => {
  it("rises to the count the server gave and then matches it", async () => {
    await seedNotes(5);
    await engine.start();

    const progress = events.filter((e) => e.type === "hydration.progress");
    expect(progress.length).toBeGreaterThan(0);

    // Monotonic, which is the property a progress display depends on and
    // the one an implementation loses first: a count derived from what the
    // store holds would fall back whenever a page carried rows already
    // there, and a bar that runs backwards reads as a fault.
    const counts = progress.map((e) => e.items);
    expect(counts).toEqual([...counts].sort((a, b) => a - b));

    // Against a total the server named, read once before the walk. Every
    // report carries the same one: a denominator that moved during the
    // read would make the fraction meaningless.
    const totals = new Set(progress.map((e) => e.totalItems));
    expect([...totals]).toEqual([5]);
    expect(counts[counts.length - 1]).toBe(5);

    const status = await engine.status();
    expect(status.hydration).toMatchObject({
      done: true,
      items: 5,
      totalItems: 5,
    });
    expect(await store.server.items.list()).toHaveLength(5);
  });

  it("reads again after a start that never finished", async () => {
    await seedNotes(4);

    // What a process killed part-way through hydration leaves: rows in the
    // store and no completion stamp. The stamp is written after the read
    // for exactly this reason — a client that recorded it first would come
    // back believing it held a corpus it had only started.
    await store.server.items.put(
      (await client.items.list({ state: "any" })).data[0]!,
    );
    expect((await store.syncState.read(identity))?.hydratedAt).toBeNull();

    await engine.start();

    const status = await engine.status();
    expect(status.hydration.done).toBe(true);
    expect(await store.server.items.list()).toHaveLength(4);
  });
});

describe("what the engine reports (seam: offline, then online)", () => {
  it("separates what is waiting from what has stopped, and by reason", async () => {
    await engine.start();

    seam.mode = "offline";
    const first = await store.mutations.createItem({
      type: "core.note",
      properties: { body: "queued" },
    });
    await store.mutations.createItem({
      type: "core.note",
      properties: { body: "also queued" },
    });

    let status = await engine.status();
    expect(status).toMatchObject({ pending: 2, deadLetters: 0, writer: true });
    expect(status.identity).toEqual(identity);

    // Nothing reached the server, so the engine says so rather than
    // reporting the quiet stream as health.
    await engine.drain();
    expect((await engine.status()).connection).toBe("offline");

    // Parked for two different reasons, which are counted apart because
    // what clears them differs: a suspended space passes on its own, a
    // write awaiting review needs the app.
    const queued = await store.outbox.list();
    await store.outbox.block(
      queued[0]!.seq,
      "auth",
      "2026-09-01T00:00:00.000Z",
    );
    await store.outbox.block(
      queued[1]!.seq,
      "needs_review",
      "2026-09-01T00:00:00.000Z",
    );

    status = await engine.status();
    expect(status).toMatchObject({
      pending: 0,
      blocked: { auth: 1, needs_review: 1 },
    });
    expect(first.id).toBeDefined();

    seam.mode = "online";
    await store.outbox.retryAll("auth", "2026-09-01T00:00:01.000Z");
    await engine.drain();

    status = await engine.status();
    expect(status).toMatchObject({ pending: 0, blocked: { needs_review: 1 } });

    // The drain reached the server, and that still does not make the
    // engine online. The evidence is asymmetric: a pass that could not
    // reach the server proves the engine is not reaching it, while a pass
    // that succeeded says only that one request worked — the stream is
    // what is continuously in contact, and it has not reconnected. Read
    // the other way round, this field says "online" through an entire
    // permanent backoff loop, because a queue with nothing in it never
    // fails to send.
    expect(status.connection).toBe("offline");
    expect(status.lastDrainedAt).toBeNull();
  });
});

describe("converging on another device's edit (seam: online)", () => {
  it("says a change landed, so a projection has something to refresh on", async () => {
    await engine.start();
    const notes = createProjection({ store, type: "core.note" });
    await notes.preload();
    expect([...notes.values()]).toHaveLength(0);

    // The app's own writes reach a projection through the write path. A
    // row that arrives on the stream does not: the engine writes to the
    // store and the projection reads from it, so without a signal an app
    // converges on its own edits and never on anybody else's — rows sit
    // in the store while the screen says nothing arrived, which from a
    // person's side is sync being broken with nothing visibly wrong.
    const changed: string[] = [];
    engine.on((event) => {
      if (event.type === "store.changed") changed.push(event.type);
    });

    await client.items.create({
      type: "core.note",
      properties: { body: "from another device" },
    });

    // Bounded explicitly. The stock `vi.waitFor` budget is 1s, and what this
    // waits on is a full round trip — create over HTTP, server write, event
    // log, SSE fanout, client receive, engine apply, signal. On a busy machine
    // that is the same assertion-shaped clock this suite has already been
    // caught by once, and it fails as `expected 0 to be greater than 0`, which
    // names no budget. The runner's own budget is 60s, so this still fails
    // first and says why.
    await vi.waitFor(
      () => {
        expect(
          changed.length,
          "the engine applied an inbound change and fired no store.changed " +
            "within 5s, so a projection would never converge on it",
        ).toBeGreaterThan(0);
      },
      { timeout: 5_000 },
    );

    // The signal arrives after the apply, so a listener that refreshes on
    // it reads a store that already holds the row rather than racing it.
    await notes.utils.refresh();
    expect([...notes.values()].map((note) => note.properties.body)).toContain(
      "from another device",
    );

    await notes.cleanup();
  });
});

describe("the projection (seam: online, then offline for the unsent write)", () => {
  it("shows visible state, which is the queue over what the server said", async () => {
    const fromServer = await client.items.create({
      type: "core.note",
      properties: { body: "from the server" },
    });
    await client.items.create({
      type: "core.bookmark",
      properties: { url: "https://example.invalid" },
    });
    await engine.start();

    const notes = createProjection({ store, type: "core.note" });
    await notes.preload();

    // One type, not the whole space: the store answers about any row, and
    // a list is bound to one kind of thing.
    expect([...notes.values()].map((row) => row.id)).toEqual([fromServer.id]);

    // A write made here is visible before the server has seen it, because
    // the projection reads the visible layer and the queue is part of it.
    // A projection over server state would leave the row a person just
    // made missing until a round trip came back.
    seam.mode = "offline";
    const unsent = await store.mutations.createItem({
      type: "core.note",
      properties: { body: "made here, never sent" },
    });
    await notes.utils.refresh();

    expect(new Set([...notes.values()].map((row) => row.id))).toEqual(
      new Set([fromServer.id, unsent.id]),
    );

    // And a removal that has not been sent takes the row off the list, so
    // what a person sees matches what they did rather than what the
    // server has been told.
    await store.mutations.deleteItem(fromServer.id);
    await notes.utils.refresh();
    expect([...notes.values()].map((row) => row.id)).toEqual([unsent.id]);

    await notes.cleanup();
  });

  it("reflects a property a merge removed", async () => {
    const note = await client.items.create({
      type: "core.note",
      properties: { body: "kept", draft: "goes away" },
    });
    await engine.start();

    const notes = createProjection({ store, type: "core.note" });
    await notes.preload();
    expect([...notes.values()][0]?.properties).toMatchObject({
      draft: "goes away",
    });

    // The row as it now stands, with one property gone. What is pinned
    // here is the behavior rather than the setting that would otherwise
    // deliver it: the refresh replaces the collection wholesale, so a
    // dropped property is reflected whatever the row-update mode says.
    // A refresh that diffed instead would need that mode, and this is the
    // assertion that would catch it going partial.
    await store.server.items.put({
      ...note,
      version: note.version + 1,
      properties: { body: "kept" },
    });
    await notes.utils.refresh();

    const shown = [...notes.values()][0];
    expect(shown?.properties).toEqual({ body: "kept" });
    expect(shown?.properties).not.toHaveProperty("draft");

    await notes.cleanup();
  });

  it("refuses a view larger than it was told to hold", async () => {
    await seedNotes(3);
    await engine.start();

    const errors: unknown[] = [];
    const capped = createProjection({
      store,
      type: "core.note",
      maxItems: 2,
      onError: (error) => errors.push(error),
    });
    await capped.preload();

    // Reported rather than thrown into whatever rendered it, and the
    // collection still reports ready — a view that waits forever on a
    // ceiling it crossed is worse than an empty one that says why.
    expect(errors[0]).toBeInstanceOf(RangeError);
    expect([...capped.values()]).toHaveLength(0);

    await capped.cleanup();
  });
});
