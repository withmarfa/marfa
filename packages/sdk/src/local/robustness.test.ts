/**
 * What the engine does when the server is not there, or the store is not
 * this process's to write.
 *
 * Every scenario here is a state an ordinary client reaches: a server that
 * is down, a second window, a write made before the first connection. None
 * of them may hang, and none of them may go by unsaid.
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
import { createLocalEngine, type LocalEngine } from "./engine.js";
import { createOfflineSeam, type OfflineSeam } from "./offline-seam.js";
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
let open: LocalStore[];
let engines: LocalEngine[];
let events: LocalEngineEvent[];
let dir: string;
let path: string;

const AT = "2026-09-01T00:00:00.000Z";

const identity = {
  origin: "http://localhost",
  spaceId: SINGLE_SPACE,
  accountId: SINGLE_ACCOUNT,
};

function engineOver(
  target: LocalStore,
  options?: { connectTimeoutMs?: number; initialRetryMs?: number },
): LocalEngine {
  const engine = createLocalEngine({
    store: target,
    client,
    ...(options?.connectTimeoutMs === undefined
      ? {}
      : { connectTimeoutMs: options.connectTimeoutMs }),
    ...(options?.initialRetryMs === undefined
      ? {}
      : { initialRetryMs: options.initialRetryMs }),
  });
  engine.on((event) => events.push(event));
  engines.push(engine);
  return engine;
}

beforeEach(async () => {
  fixture = await createKeysModeFixture();
  seam = createOfflineSeam(fixture.fetch);
  client = new MarfaClient({
    url: "http://localhost",
    apiKey: fixture.adminKey,
    fetch: seam.fetch,
  });
  dir = mkdtempSync(join(tmpdir(), "marfa-local-robust-"));
  path = join(dir, "store.db");
  store = await openLocalStore({ path, identity });
  open = [store];
  engines = [];
  events = [];
});

afterEach(() => {
  for (const engine of engines) engine.stop();
  for (const handle of open) {
    try {
      handle.close();
    } catch {
      // Already closed by the scenario.
    }
  }
  fixture.cleanup();
  rmSync(dir, { recursive: true, force: true });
});

describe("a server that will not answer (seam: offline)", () => {
  it("gives up on the first connection instead of waiting for ever", async () => {
    seam.mode = "offline";
    const engine = engineOver(store, {
      connectTimeoutMs: 150,
      initialRetryMs: 5,
    });

    // The stream announces where the log stands as its first frame, and
    // starting waits for it. Waiting with no bound is a promise that can
    // never settle: an engine pointed at a server that is down sits in
    // `connecting` for the life of the process, and the caller has no
    // failure to handle and no state to render.
    await expect(engine.start()).rejects.toThrow(/did not connect/);
    expect((await engine.status()).connection).toBe("offline");
  });

  it("says the stream failed rather than retrying in silence", async () => {
    seam.mode = "server_error";
    const engine = engineOver(store, {
      connectTimeoutMs: 200,
      initialRetryMs: 5,
    });
    await expect(engine.start()).rejects.toThrow();

    // Reconnecting is right and saying nothing about it is not: a stream
    // that fails the same way on every attempt looks, from outside,
    // exactly like a quiet server.
    const failures = events.filter(
      (event) => event.type === "sync.error" && event.scope === "stream",
    );
    expect(failures.length).toBeGreaterThan(0);
  });

  it("settles when it is stopped before it ever connected", async () => {
    seam.mode = "offline";
    const engine = engineOver(store, { initialRetryMs: 5 });
    const starting = engine.start();
    engine.stop();

    // Stopping aborts the subscription, and a start still waiting on an
    // announcement that is now never coming has to be told so — otherwise
    // shutting an engine down leaves a promise nobody can settle.
    await expect(starting).rejects.toThrow(/stopped/);
    expect((await engine.status()).connection).toBe("stopped");
  });
});

describe("a start that is abandoned or times out", () => {
  it("leaves nothing armed when it is stopped during its first read", async () => {
    seam.mode = "offline";
    const engine = engineOver(store, {
      connectTimeoutMs: 60,
      initialRetryMs: 5,
    });
    const starting = engine.start();
    engine.stop();
    await expect(starting).rejects.toThrow(/stopped/);

    // The give-up timer is cleared on every path out of `start`, including
    // the one that leaves before the wait is awaited. Left armed it fires
    // later, reports offline over the stopped state the app was last
    // shown, and — holding a reference — keeps the event loop alive, so a
    // command-line tool that stops the engine and expects to exit does not.
    events.length = 0;
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(events).toEqual([]);
  });

  it("can be started again after it gave up waiting", async () => {
    seam.mode = "offline";
    const engine = engineOver(store, {
      connectTimeoutMs: 60,
      initialRetryMs: 5,
    });
    await expect(engine.start()).rejects.toThrow(/did not connect/);

    // The message says to start again when the server is reachable, so
    // starting again has to be something this object can do. Giving up on
    // a connection must not retire the engine: the second attempt would
    // otherwise reject saying it was stopped before the stream announced,
    // which is both false and unactionable.
    seam.mode = "online";
    await expect(engine.start()).resolves.toBeUndefined();
    expect((await engine.status()).connection).toBe("online");
  });
});

describe("a listener that throws, and one that is not there", () => {
  it("does not turn a reported failure into an unhandled one", async () => {
    seam.mode = "server_error";
    const engine = engineOver(store, {
      connectTimeoutMs: 150,
      initialRetryMs: 5,
    });
    engine.on(() => {
      throw new Error("a listener that cannot cope");
    });

    // The one path whose whole purpose is not to crash reports through the
    // listeners, so a listener that throws would put the rejection
    // straight back where it was taken from.
    await expect(engine.start()).rejects.toThrow();
    expect(
      events.some(
        (event) => event.type === "sync.error" && event.scope === "stream",
      ),
    ).toBe(true);
  });

  it("keeps the last failure where an app that polls can find it", async () => {
    seam.mode = "server_error";
    const engine = engineOver(store, {
      connectTimeoutMs: 150,
      initialRetryMs: 5,
    });
    await expect(engine.start()).rejects.toThrow();

    // Reported to a listener is thinner than it reads: an app that polls
    // rather than subscribes, or one that attached a listener after the
    // failure, has no way to learn that a catch-up has been failing all
    // afternoon.
    const status = await engine.status();
    expect(status.lastError).toMatchObject({ scope: "stream" });
    expect(status.lastError?.message).toEqual(expect.any(String));
  });
});

describe("a re-import that did not finish", () => {
  it("is owed on the next start rather than followed over", async () => {
    const stale = await client.items.create({
      type: "core.note",
      properties: { body: "removed while away" },
    });
    await client.items.create({
      type: "core.note",
      properties: { body: "still there" },
    });
    await engineOver(store).start();
    for (const running of engines.splice(0)) running.stop();
    expect(await store.server.items.get(stale.id)).toBeDefined();

    // Removed with nothing watching, and a re-import that got as far as
    // clearing the cursor and then failed. Null cursor means two things —
    // a store that has never connected, and one that owes a full read —
    // and only the second needs one. Told apart by the flag rather than
    // by the cursor, which this path destroys.
    await client.items.delete(stale.id);
    await client.items.purge(stale.id);
    await store.syncState.setReimportOwed(identity, AT);
    await store.syncState.setCursor(identity, null);

    const engine = engineOver(store);
    await engine.start();

    // Without the flag the hydration stamp is set and the cursor is null,
    // so the next start adopts the announced head and follows live for
    // ever over a corpus that was never re-read and never pruned.
    expect(await store.server.items.get(stale.id)).toBeUndefined();
    expect(await store.server.items.list()).toHaveLength(1);
    expect((await store.syncState.read(identity))?.reimportOwedAt).toBeNull();
  });
});

describe("a handle another engine is holding", () => {
  it("refuses to follow the stream, with the reason", async () => {
    const second = await openLocalStore({ path, identity });
    open.push(second);
    expect(second.writer).toBe(false);

    // Following the stream means recording where it has reached, and this
    // handle cannot write. Refusing with the reason is the whole point of
    // reporting `writer` at all: without the check the first cursor write
    // throws from somewhere far from the cause.
    const engine = engineOver(second);
    await expect(engine.start()).rejects.toThrow(/read-only/);
    await expect(engine.drain()).rejects.toThrow(/read-only/);

    // And it still reads, which is what a second window is for.
    expect((await engine.status()).writer).toBe(false);
    expect(await second.visible.listItems()).toEqual([]);
  });
});

describe("a store that took a write before it was ever online", () => {
  it("hydrates rather than refusing over its own queue", async () => {
    await client.items.create({
      type: "core.note",
      properties: { body: "on the server" },
    });
    // Written offline, before this store had ever reached the server. A
    // fresh store's first read is the one thing that cannot be deferred
    // until the queue empties, because nothing tells the app to drain and
    // the queue may never empty on its own.
    await store.mutations.createItem({
      type: "core.note",
      properties: { body: "made before the first connection" },
    });

    const engine = engineOver(store);
    await expect(engine.start()).resolves.toBeUndefined();

    const status = await engine.status();
    expect(status.hydration.done).toBe(true);
    expect(await store.server.items.list()).toHaveLength(1);
    expect(await store.visible.listItems()).toHaveLength(2);
  });
});
