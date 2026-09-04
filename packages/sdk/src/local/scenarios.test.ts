/**
 * The scenarios from the sync contract that this part of the engine owns.
 *
 * They run against the in-process server through `createKeysModeFixture`,
 * with the transport swapped for `createOfflineSeam`. Each names the seam
 * mode it uses in its own title, because a scenario that does not is not
 * reproducible.
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
let drain: OutboxDrain;
let events: LocalEngineEvent[];
let dir: string;

function openDrain(retryCeiling?: number): OutboxDrain {
  return createOutboxDrain({
    store,
    client,
    ...(retryCeiling === undefined ? {} : { retryCeiling }),
    onEvent: (event) => events.push(event),
  });
}

beforeEach(async () => {
  fixture = await createKeysModeFixture();
  seam = createOfflineSeam(fixture.fetch);
  client = new MarfaClient({
    url: "http://localhost",
    apiKey: fixture.adminKey,
    fetch: seam.fetch,
  });
  dir = mkdtempSync(join(tmpdir(), "marfa-local-scenarios-"));
  store = await openLocalStore({
    path: join(dir, "store.db"),
    identity: {
      origin: "http://localhost",
      spaceId: SINGLE_SPACE,
      accountId: SINGLE_ACCOUNT,
    },
  });
  events = [];
  drain = openDrain();
});

afterEach(() => {
  store.close();
  fixture.cleanup();
  rmSync(dir, { recursive: true, force: true });
});

describe("a mutation queued after a create (seam: offline, then online)", () => {
  it("sends the create first, and the edge after its endpoints", async () => {
    seam.mode = "offline";

    const note = await store.mutations.createItem({
      type: "core.note",
      properties: { body: "first" },
    });
    await store.mutations.updateItem(note.id, { title: "renamed" });
    const other = await store.mutations.createItem({
      type: "core.note",
      properties: { body: "second" },
    });
    await store.mutations.createEdge({
      source_id: note.id,
      target_id: other.id,
      edge_type: "references",
    });

    // Offline is not an attempt: the pass stops at the first unreachable
    // request rather than working through a queue nothing can send.
    const offlinePass = await drain.drain();
    expect(offlinePass).toMatchObject({ sent: 0, offline: true, remaining: 4 });
    expect((await store.outbox.list()).every((e) => e.attempts === 0)).toBe(
      true,
    );

    seam.reset();
    seam.mode = "online";
    const pass = await drain.drain();

    expect(pass).toMatchObject({ sent: 4, remaining: 0, parked: false });
    expect(seam.calls).toEqual([
      "POST /items",
      `PATCH /items/${note.id}`,
      "POST /items",
      "POST /edges",
    ]);

    // Only what changed, and the version the row was read at. A patch
    // carrying the whole property bag turns every field into a candidate
    // for conflict, and one carrying no version is never compared against
    // an ancestor at all, so an echoed stale value reverts a server edit
    // with nothing reporting it.
    const patch = seam.requests[1];
    expect(patch?.body).toEqual({
      properties: { title: "renamed" },
      version: 1,
    });

    // The order is load-bearing rather than decorative: each of these only
    // exists because the write in front of it went first.
    const stored = await client.items.get(note.id);
    expect(stored.properties.title).toBe("renamed");
    expect(stored.properties.body).toBe("first");
    const edges = await client.edges.list({ edge_type: "references" });
    expect(edges.data).toHaveLength(1);
    expect(edges.data[0]).toMatchObject({
      source_id: note.id,
      target_id: other.id,
    });
  });
});

describe("a refused write (seam: offline while queued, then online)", () => {
  it("dead-letters the create, cascades to what waited on it, and takes the ghost away", async () => {
    seam.mode = "offline";
    const good = await store.mutations.createItem({
      type: "core.note",
      properties: { body: "keeps" },
    });
    const doomed = await store.mutations.createItem({
      // Nothing has registered this type, so the server answers 400
      // `unknown_type` — a refusal no retry changes.
      type: "custom.nothing_registered",
      properties: { body: "goes" },
    });
    await store.mutations.updateItem(doomed.id, { title: "also goes" });
    await store.mutations.createEdge({
      source_id: doomed.id,
      target_id: good.id,
      edge_type: "references",
    });

    seam.mode = "online";
    const pass = await drain.drain();

    expect(pass).toMatchObject({ sent: 1, remaining: 0 });

    const refused = await store.deadLetters.list();
    expect(refused.map((entry) => [entry.kind, entry.reason])).toEqual([
      ["item.create", "refused"],
      ["item.update", "cascaded"],
      ["edge.create", "cascaded"],
    ]);
    expect(refused[0]?.httpStatus).toBe(400);
    expect(refused[0]?.code).toBe("unknown_type");

    // The local row is gone, because the queue entry that stood for it is.
    expect(await store.visible.getItem(doomed.id)).toBeUndefined();
    expect(await store.visible.listEdges()).toHaveLength(0);
    // The write that had nothing to do with the refusal still landed.
    expect(await store.visible.getItem(good.id)).toMatchObject({
      properties: { body: "keeps" },
    });

    expect(
      events.filter((event) => event.type === "mutation.dead_lettered"),
    ).toHaveLength(3);

    const first = refused[0];
    if (first === undefined) throw new Error("expected a dead letter");
    expect(await store.deadLetters.dismiss(first.id)).toBe(true);
    expect(await store.deadLetters.list()).toHaveLength(2);
  });

  it("rolls a refused update back to the server's state", async () => {
    const note = await store.mutations.createItem({
      type: "core.note",
      properties: { body: "as sent" },
    });
    await drain.drain();

    // Another device removes the row while an edit here is still queued.
    seam.mode = "offline";
    await store.mutations.updateItem(note.id, { body: "never lands" });
    expect(await store.visible.getItem(note.id)).toMatchObject({
      properties: { body: "never lands" },
    });

    seam.mode = "online";
    await client.items.delete(note.id);
    await client.items.purge(note.id);

    await drain.drain();

    const refused = await store.deadLetters.list();
    expect(refused).toHaveLength(1);
    expect(refused[0]).toMatchObject({
      kind: "item.update",
      reason: "refused",
      httpStatus: 404,
    });
    // Back to what the server last said, with nothing to undo: the queue
    // entry was the edit, and it has left.
    expect(await store.visible.getItem(note.id)).toMatchObject({
      properties: { body: "as sent" },
    });
    expect(await store.outbox.count()).toBe(0);
  });
});

describe("a transient failure past the ceiling (seam: offline, then server_error)", () => {
  it("parks the mutation with its reason and tells the app", async () => {
    seam.mode = "offline";
    const note = await store.mutations.createItem({
      type: "core.note",
      properties: { body: "waiting" },
    });

    const limited = openDrain(3);

    // Being offline is not a failed attempt, so the budget is untouched.
    await limited.drain();
    await limited.drain();
    expect((await store.outbox.list())[0]?.attempts).toBe(0);

    seam.mode = "server_error";
    await limited.drain();
    await limited.drain();
    expect((await store.outbox.list())[0]).toMatchObject({
      state: "pending",
      attempts: 2,
    });

    await limited.drain();

    const parked = (await store.outbox.list())[0];
    expect(parked).toMatchObject({
      state: "blocked",
      blockedReason: "retry_ceiling",
      attempts: 3,
    });
    expect(parked?.lastError).toContain("Server is having a moment");

    expect(events).toContainEqual(
      expect.objectContaining({
        type: "mutation.blocked",
        reason: "retry_ceiling",
      }),
    );
    // Parked, not discarded: still queued and still on screen.
    expect(await store.deadLetters.list()).toHaveLength(0);
    expect(await store.visible.getItem(note.id)).toMatchObject({
      properties: { body: "waiting" },
    });

    // A further pass leaves a parked mutation alone rather than spending
    // another attempt on it.
    seam.reset();
    await limited.drain();
    expect(seam.calls).toEqual([]);
  });
});

describe("a token expired mid-drain (seam: online for one write, then unauthorized)", () => {
  it("parks the queue on auth, tells the app, and drops nothing", async () => {
    seam.mode = "offline";
    const first = await store.mutations.createItem({
      type: "core.note",
      properties: { body: "one" },
    });
    const second = await store.mutations.createItem({
      type: "core.note",
      properties: { body: "two" },
    });
    const third = await store.mutations.createItem({
      type: "core.note",
      properties: { body: "three" },
    });

    seam.after(1, "unauthorized");
    const pass = await drain.drain();

    expect(pass).toMatchObject({ sent: 1, parked: true, remaining: 2 });
    const parkedEvent = events.find((event) => event.type === "queue.parked");
    expect(parkedEvent).toMatchObject({ reason: "auth", parked: 2 });
    expect(parkedEvent?.message).toContain("expired");

    const queued = await store.outbox.list();
    expect(queued.map((entry) => entry.blockedReason)).toEqual([
      "auth",
      "auth",
    ]);
    expect(await store.deadLetters.list()).toHaveLength(0);
    for (const id of [first.id, second.id, third.id]) {
      expect(await store.visible.getItem(id)).toBeDefined();
    }

    // Nothing was dropped, so a working credential drains the rest.
    seam.mode = "online";
    await store.outbox.retryAll("auth", new Date().toISOString());
    const recovered = await drain.drain();
    expect(recovered).toMatchObject({ sent: 2, remaining: 0 });
    expect(await client.items.get(third.id)).toMatchObject({
      properties: { body: "three" },
    });
  });
});

describe("what a sent write leaves behind (seam: online, one edit made offline)", () => {
  it("keeps the tags on a row the server only trashed", async () => {
    const note = await store.mutations.createItem({
      type: "core.note",
      properties: { body: "tagged" },
    });
    await drain.drain();
    await client.metadata.addTags(note.id, ["filed"]);
    const tags = await client.metadata.get(note.id);
    await store.server.metadata.put(tags);

    await store.mutations.deleteItem(note.id);
    await drain.drain();

    // A delete is a trash. The server keeps the row and everything hanging
    // off it, so taking the tags here would leave a restore bringing the
    // item back stripped, with nothing to correct it until a metadata
    // event or a full re-read happens along. The layers are separate so
    // that one layer's write cannot reach the other.
    expect(await store.server.metadata.get(note.id)).toMatchObject({
      tags: ["filed"],
    });
  });

  it("does not overwrite a newer row with the answer to an older write", async () => {
    const note = await store.mutations.createItem({
      type: "core.note",
      properties: { body: "first" },
    });
    await drain.drain();

    // An edit on its way out, and the row moving on underneath it before
    // the answer lands. Whatever the server says about this write, it
    // describes a version older than the one already held.
    seam.mode = "offline";
    await store.mutations.updateItem(note.id, { title: "mine" });
    seam.mode = "online";
    const ahead = await client.items.update(note.id, { body: "from ahead" });
    await store.server.items.put({ ...ahead, version: ahead.version + 5 });

    await drain.drain();

    // Settling a write is a write into server state like any other, and
    // the same comparison governs it. Without that, the response to a
    // write the client made overwrites an event that arrived while it was
    // in flight — and no event will ever redeliver what was lost.
    expect(await store.server.items.get(note.id)).toMatchObject({
      version: ahead.version + 5,
      properties: { body: "from ahead" },
    });
  });
});

describe("the key a mutation was written with (seam: offline, then online)", () => {
  it("goes out on every door that takes one", async () => {
    seam.mode = "offline";
    const note = await store.mutations.createItem({
      type: "core.note",
      properties: { body: "one" },
    });
    const other = await store.mutations.createItem({
      type: "core.note",
      properties: { body: "two" },
    });
    const edge = await store.mutations.createEdge({
      source_id: note.id,
      target_id: other.id,
      edge_type: "references",
    });
    await store.mutations.deleteEdge(edge.id);
    await store.mutations.deleteItem(note.id);

    const queued = await store.outbox.list();
    seam.reset();
    seam.mode = "online";
    const pass = await drain.drain();
    expect(pass).toMatchObject({ sent: 5, remaining: 0 });

    // One request per queued mutation, in the order they were written, so
    // the key on each request belongs to the row beside it. Asserting the
    // header is merely present would pass on a transport that minted its
    // own per call, which answers nothing: a repeat has to carry the key
    // the first attempt carried, and only the stored one is that.
    expect(seam.calls).toEqual([
      "POST /items",
      "POST /items",
      "POST /edges",
      `DELETE /edges/${edge.id}`,
      `DELETE /items/${note.id}`,
    ]);
    expect(
      seam.requests.map((request) => request.headers["idempotency-key"]),
    ).toEqual(queued.map((entry) => entry.idempotencyKey));
  });
});

describe("a delete whose answer was lost (seam: lost_response, then online)", () => {
  it("repeats as a no-op instead of failing against the row it removed", async () => {
    const note = await store.mutations.createItem({
      type: "core.note",
      properties: { body: "goes" },
    });
    const other = await store.mutations.createItem({
      type: "core.note",
      properties: { body: "stays" },
    });
    const edge = await store.mutations.createEdge({
      source_id: note.id,
      target_id: other.id,
      edge_type: "references",
    });
    await drain.drain();

    await store.mutations.deleteEdge(edge.id);
    await store.mutations.deleteItem(note.id);

    // Both deletes land; the client is told neither did. That is not a
    // refusal, so the pass stops with the queue intact and no attempt
    // spent against either row.
    seam.mode = "lost_response";
    const lost = await drain.drain();
    expect(lost).toMatchObject({ sent: 0, offline: true, remaining: 2 });

    seam.mode = "online";
    const retry = await drain.drain();
    expect(retry).toMatchObject({ sent: 2, remaining: 0 });

    // A delete is where the key earns its place. A create repeats safely
    // on the id the client minted, which the server recognizes as one it
    // has already performed; a delete has no such handle, so the second
    // attempt finds nothing to remove and is refused 404. That refusal is
    // permanent, so without the key both rows land in the dead-letter log
    // and the person is told a delete failed that the server carried out.
    expect(await store.deadLetters.list()).toEqual([]);
    expect(await store.visible.getItem(note.id)).toBeUndefined();
    expect(await store.visible.listEdges()).toHaveLength(0);
  });
});

describe("an edge edit (seam: offline, then online)", () => {
  it("goes out with the version it was made against", async () => {
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
    await drain.drain();

    seam.mode = "offline";
    await store.mutations.updateEdge(edge.id, { note: "added here" });
    expect(await store.visible.getEdge(edge.id)).toMatchObject({
      properties: { note: "added here" },
    });

    seam.reset();
    seam.mode = "online";
    expect(await drain.drain()).toMatchObject({ sent: 1, remaining: 0 });

    // The version the edit was computed against, so a row that moved on
    // underneath is refused rather than written over. Edges carry no merge
    // policy, so an unconditional write here would be a silent
    // last-writer-wins with nothing reporting it.
    const patch = seam.requests.find((request) => request.method === "PATCH");
    expect(patch?.body).toMatchObject({ version: 1 });
    expect(
      (await client.edges.list({ edge_type: "references" })).data[0],
    ).toMatchObject({ properties: { note: "added here" } });
  });
});

describe("a queue that empties cleanly (seam: offline, then online)", () => {
  it("records when it last did", async () => {
    seam.mode = "offline";
    await store.mutations.createItem({
      type: "core.note",
      properties: { body: "one" },
    });
    await drain.drain();
    expect((await store.syncState.read(store.identity))?.lastDrainedAt).toBe(
      null,
    );

    seam.mode = "online";
    await drain.drain();

    // Only when the queue actually emptied. A stamp written on every pass
    // would say a client was up to date while something was still parked
    // in front of it, which is the one question this field exists to
    // answer.
    expect(
      (await store.syncState.read(store.identity))?.lastDrainedAt,
    ).not.toBeNull();
  });
});

describe("two clients editing one field (seam: online)", () => {
  it("takes what the server settled on, and never settles it here", async () => {
    const note = await store.mutations.createItem({
      type: "core.note",
      properties: { body: "as written" },
    });
    await drain.drain();

    // An edit made against version 1, and another device moving the row on
    // before it is sent. `body` is `keep_both_copies` on `core.note`, so a
    // resolution here has to produce a sibling — and which side of the
    // wire produces it is the whole question.
    await store.mutations.updateItem(note.id, { body: "mine" });
    await client.items.update(note.id, { body: "theirs" });

    seam.reset();
    const pass = await drain.drain();
    expect(pass).toMatchObject({ sent: 1, remaining: 0 });

    // One PATCH and nothing else. This is the assertion that distinguishes
    // a server-side resolution from a client-side one: an engine merging
    // here would show up as a second call, the sibling's `POST /items`,
    // and a second device on a different kit would spawn a different one.
    expect(seam.calls).toEqual([`PATCH /items/${note.id}`]);

    // The sibling exists and the server made it, inside the write's own
    // transaction. Asserting only on the count would pass against an
    // engine that created it, which is the rule being tested.
    const onServer = await client.items.list({ limit: 50 });
    const bodies = onServer.data.map((item) => item.properties.body).sort();
    expect(bodies).toEqual(["mine", "theirs"]);

    // Nothing parked and nothing lost: the edit is on the server, under
    // whichever id the policy gave it.
    expect(await store.outbox.list()).toEqual([]);
    expect(await store.deadLetters.list()).toHaveLength(0);
  });
});

describe("an update whose answer was lost (seam: lost_response, then online)", () => {
  it("replays into the merge rather than parking, and spawns nothing", async () => {
    const note = await store.mutations.createItem({
      type: "core.note",
      properties: { body: "first" },
    });
    await drain.drain();
    await store.mutations.updateItem(note.id, { title: "mine" });

    // The write lands and the client is told nothing came back.
    seam.mode = "lost_response";
    expect(await drain.drain()).toMatchObject({ sent: 0, offline: true });

    seam.mode = "online";
    await drain.drain();

    // A create repeats safely on the id the client minted, and a delete on
    // the key it carries. An update has neither, so the replay re-sends
    // the version it was computed against and the server has moved past
    // it. What it meets now is the merge rather than a refusal, so the
    // edit settles instead of parking for a person to redo.
    expect(await store.outbox.list()).toEqual([]);
    expect(await store.deadLetters.list()).toEqual([]);

    // And it settles once. A replay that spawned a second row would be the
    // failure this scenario is really watching for, because `title` here
    // does not collide and a colliding field would reach the sibling path
    // twice.
    const onServer = await client.items.list({ limit: 50 });
    expect(onServer.data).toHaveLength(1);
    expect(onServer.data[0]).toMatchObject({
      id: note.id,
      properties: { title: "mine" },
    });

    // The gap that remains, stated rather than asserted away: the row was
    // written twice, so the version moved twice for one edit. The contract
    // closes that with the idempotency key covering updates as it already
    // covers creates and deletes, which needs a key field the client's
    // update options do not yet carry. Merging makes the outcome right; it
    // does not make the write a no-op.
    expect(onServer.data[0]?.version).toBeGreaterThan(2);
  });
});
