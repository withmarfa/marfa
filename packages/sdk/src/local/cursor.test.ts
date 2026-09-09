/**
 * The scenarios that need the server to assign event ids.
 *
 * Their own file because they are the only ones that ask the fixture for
 * an event log, and that wiring is module-global: keeping them together
 * keeps the number of suites that turn it on to one.
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

function reports(match: (event: LocalEngineEvent) => boolean): Promise<void> {
  return new Promise((resolve) => {
    if (events.some(match)) {
      resolve();
      return;
    }
    watchers.push({ match, resolve });
  });
}

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

/** Bring up a fixture, saying whether the event log is wired. */
async function bringUp(eventLog: boolean): Promise<void> {
  fixture = await createKeysModeFixture(undefined, { eventLog });
  seam = createOfflineSeam(fixture.fetch);
  client = new MarfaClient({
    url: "http://localhost",
    apiKey: fixture.spaceKey,
    fetch: seam.fetch,
  });
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "marfa-local-cursor-"));
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

async function openStore(): Promise<LocalStore> {
  store = await openLocalStore({ path: join(dir, "store.db"), identity });
  return store;
}

describe("the fixture's event log", () => {
  it("is what decides whether a cursor can be refused at all", async () => {
    // Off. Nothing is appended, so the log is empty, the staleness check
    // is skipped for want of anything to compare against, and a cursor
    // from before the beginning of time is served as though it were
    // current. A suite that tested the stale-cursor path here would pass
    // having exercised none of it.
    await bringUp(false);
    await openStore();
    await client.items.create({
      type: "core.note",
      properties: { body: "one" },
    });

    const silent = await askWithCursor("0");
    expect(silent.tooOld).toBeUndefined();
    expect(silent.announced).toBe("0");

    store.close();
    fixture.cleanup();

    // On. The same request, against the same code, now meets a log that
    // knows where it starts.
    await bringUp(true);
    await openStore();
    const created = await client.items.create({
      type: "core.note",
      properties: { body: "one" },
    });
    expect(created.id).toBeDefined();

    const refused = await askWithCursor("0");
    expect(refused.tooOld).toMatchObject({ requested: "0" });
    expect(Number(refused.announced)).toBeGreaterThan(0);
  });
});

/**
 * Open one subscription with a resume cursor and report what it got.
 *
 * The two outcomes race each other, and both are positive: either the
 * stream refuses the cursor, or it delivers a frame — which it can only do
 * if it is still open, so it did not refuse. Concluding "no refusal"
 * from a timer instead makes the answer a function of how busy the machine
 * is: the server announces, awaits a read, and only then refuses, so a
 * loaded box turns a correct engine into a wrong answer in whichever
 * direction the caller happened to be checking.
 */
function askWithCursor(cursor: string): Promise<{
  announced: string | undefined;
  tooOld: { min_retained_id: string; requested: string } | undefined;
}> {
  return new Promise((resolve, reject) => {
    let announced: string | undefined;
    const subscription = client.events.subscribe({
      lastEventId: cursor,
      reconnect: false,
      onEvent: () => {
        // A frame arrived, so the stream is live and past the point where
        // a refusal would have come.
        subscription.close();
        resolve({ announced, tooOld: undefined });
      },
      onCursor: (value) => {
        announced = value;
        // Something for a healthy stream to deliver. A refusal is sent
        // instead of the backlog, so only one of the two can happen.
        client.items
          .create({ type: "core.note", properties: { body: "a live frame" } })
          .catch(reject);
      },
      onCatchupTooOld: (info) => {
        subscription.close();
        resolve({ announced, tooOld: info });
      },
    });
  });
}

describe("a cursor the log can no longer serve (seam: online)", () => {
  it("re-reads and prunes rather than reconnecting into the same refusal", async () => {
    await bringUp(true);
    await openStore();

    const kept = await client.items.create({
      type: "core.note",
      properties: { body: "kept" },
    });
    const goes = await client.items.create({
      type: "core.note",
      properties: { body: "goes while away" },
    });
    await startSync({ initialRetryMs: 5 }).start();
    expect(await store.server.items.get(goes.id)).toBeDefined();

    // Away before anything happens, and this ordering is the scenario
    // rather than housekeeping. With the subscription still open the
    // removal arrives as a live frame, the store acts on it, and the
    // re-import that follows finds nothing left to prune — proving the
    // stream works and the prune nothing at all.
    for (const sync of running.splice(0)) sync.stop();

    // Removed while away, with the cursor left at a position the log
    // cannot serve. Reconnecting with it loops on the refusal; dropping
    // it silently skips whatever happened in the gap — which is this
    // removal, and nothing else would ever mention it.
    await client.items.delete(goes.id);
    await client.items.purge(goes.id);
    await store.syncState.setCursor(identity, "0");

    events.length = 0;
    const resumed = startSync({ initialRetryMs: 5 });
    await resumed.start();
    await reports((event) => event.type === "reimport.finished");

    const reimport = events.find((e) => e.type === "reimport.finished");
    expect(reimport).toMatchObject({ prunedItems: 1 });
    expect(await store.server.items.get(goes.id)).toBeUndefined();
    expect(await store.server.items.get(kept.id)).toBeDefined();
    // Resumed from the announcement the new connection made, not from the
    // cursor that was refused. Settled on rather than read immediately:
    // the re-import clears the cursor before it reads, so the instant it
    // finishes the value is null — which is not "0" and would satisfy a
    // bare inequality without the new announcement ever being observed.
    const resumedAt = await settles(
      () => store.syncState.read(identity),
      (row) => row?.cursor != null,
    );
    expect(resumedAt?.cursor).not.toBe("0");
  });
});

describe("an aged-out cursor over a queue a drain cannot clear (seam: online)", () => {
  it("says the re-import could not run instead of ending the process", async () => {
    await bringUp(true);
    await openStore();
    await client.items.create({
      type: "core.note",
      properties: { body: "on the server" },
    });
    await startSync({ initialRetryMs: 5 }).start();
    for (const sync of running.splice(0)) sync.stop();

    // A drain does not promise an empty queue, and this is the ordinary
    // way it does not: a create parked for review, and an edit to that
    // same row queued behind it. The edit stays pending however many
    // passes run, because the row it names has unsent work in front of it.
    const held = await store.mutations.createItem({
      type: "core.note",
      properties: { body: "parked" },
    });
    const parked = (await store.outbox.list())[0];
    await store.outbox.block(
      parked!.seq,
      "needs_review",
      "2026-09-01T00:00:00.000Z",
    );
    await store.mutations.updateItem(held.id, { title: "waits behind it" });

    // And a cursor the log will refuse, so the engine reaches for the one
    // read it must not run over a pending write: the prune measures the
    // corpus against a listing this edit's row is absent from.
    await store.syncState.setCursor(identity, "0");

    events.length = 0;
    startSync({ initialRetryMs: 5 });
    await running[running.length - 1]?.start();
    await reports(
      (event) => event.type === "sync.error" && event.scope === "reimport",
    );

    // Reported, not thrown. The work runs detached from anything that
    // could hold its promise, so throwing reaches Node as an uncaught
    // exception and ends the host process — an ordinary offline
    // reconnect taking an application down with it.
    const failure = events.find((e) => e.type === "sync.error");
    expect(failure).toMatchObject({ scope: "reimport" });
    expect(failure?.type === "sync.error" && failure.message).toContain(
      "waiting to be sent",
    );

    // The cursor is left alone, because it is the only record that this
    // store still owes a full read. Clearing it and carrying on live would
    // leave the rows a prune should have taken with nothing able to
    // notice them again.
    expect((await store.syncState.read(identity))?.cursor).toBe("0");
    expect(await store.outbox.count()).toBe(2);
  });
});

describe("a restart after events have been seen (seam: online)", () => {
  it("comes back at the cursor the stream last accounted for", async () => {
    await bringUp(true);
    await openStore();
    await startSync().start();

    const note = await client.items.create({
      type: "core.note",
      properties: { body: "written while watching" },
    });
    // The store's own record rather than the subscription's: the two are
    // written together, and only the store's survives the process.
    await settles(
      () => store.syncState.read(identity),
      (row) => row?.cursor != null && row.cursor !== "0",
    );
    const cursorBefore = (await store.syncState.read(identity))?.cursor;

    for (const sync of running.splice(0)) sync.stop();
    store.close();

    // A second engine over the same file, as a restart is.
    await openStore();
    expect((await store.syncState.read(identity))?.cursor).toBe(cursorBefore);
    expect(await store.server.items.get(note.id)).toBeDefined();

    // And it resumes from there rather than from the head of the log,
    // which is what the announcement would have given it.
    seam.reset();
    await startSync().start();
    const resumed = seam.requests.find((r) => r.path === "/events");
    expect(resumed?.headers["last-event-id"]).toBe(cursorBefore);
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
