/**
 * The scenarios from the sync contract that this part of the engine owns.
 *
 * They run against the in-process server through `createKeysModeFixture`,
 * with the transport swapped for `createOfflineSeam`. Each names the seam
 * mode it uses in its own title, because a scenario that does not is not
 * reproducible.
 */
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { unregisterTypeSchema } from "@withmarfa/shared";
import { MarfaClient } from "../client.js";
import {
  createKeysModeFixture,
  type KeysModeFixture,
} from "../test-harness.js";
import { createBlobStore, type LocalBlobs } from "./blobs.js";
import { createOutboxDrain, type OutboxDrain } from "./drain.js";
import { createOfflineSeam, type OfflineSeam } from "./offline-seam.js";
import { openLocalStore, type LocalStore } from "./store/index.js";
import { createTypeGraph } from "./type-graph.js";
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

    // One PATCH and nothing else.
    //
    // This does not by itself separate a server-side resolution from a
    // client-side one — the kit's old `manual` path also issued exactly
    // one PATCH, then parked. It is a forward-looking pin: the deleted
    // client-side merge spawned the sibling as a second `POST /items`,
    // and the `callback` strategy that still exists re-sends a merged
    // body as a second PATCH. Either would break this line.
    expect(seam.calls).toEqual([`PATCH /items/${note.id}`]);

    // What actually separates the two is who made the sibling, and the
    // server saying so is the only report of it: no route names what a
    // write created.
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "mutation.merged",
        fields: ["body"],
      }),
    );
    const merged = events.find((event) => event.type === "mutation.merged");
    expect(
      merged !== undefined && "conflictedCopyId" in merged
        ? merged.conflictedCopyId
        : undefined,
    ).toBeDefined();

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

describe("two clients editing different fields (seam: online)", () => {
  it("keeps both, because neither collided", async () => {
    const note = await store.mutations.createItem({
      type: "core.note",
      properties: { body: "as written" },
    });
    await drain.drain();

    // The other half of rule 10, and the half that carries the ordinary
    // case: fields that do not collide merge. The scenario beside this one
    // covers the same field edited twice; this one is two people working
    // on one row without getting in each other's way.
    //
    // **What this does not discriminate, stated so nobody reads it as
    // more than it is.** It does not depend on the conflict strategy:
    // fields that do not collide never reach one, so it passes under
    // `manual` too — both were tried. Nor does it break when the update
    // sends the whole row instead of the patch, because a field equal to
    // the ancestor reads as unchanged and the server keeps its own value.
    //
    // What it does catch is an engine that resolves here — a sibling, a
    // second call, or a merged event where nothing was merged — and a
    // server that starts taking a side instead of keeping both.
    await store.mutations.updateItem(note.id, { title: "mine" });
    await client.items.update(note.id, { body: "theirs" });

    seam.reset();
    expect(await drain.drain()).toMatchObject({ sent: 1, remaining: 0 });

    // Both present on the one row. A merge that took a side would leave
    // one of them missing, and a merge made here rather than at the server
    // would spawn a sibling — so the row count is asserted too.
    const onServer = await client.items.list({ limit: 50 });
    expect(onServer.data).toHaveLength(1);
    expect(onServer.data[0]).toMatchObject({
      id: note.id,
      properties: { title: "mine", body: "theirs" },
    });

    // Nothing collided, so nothing was resolved by policy and there is
    // nothing to report. Asserting the silence matters: `mutation.merged`
    // firing here would tell an app a person's text had been moved when
    // it had not.
    expect(events.filter((event) => event.type === "mutation.merged")).toEqual(
      [],
    );

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

    // And it settles once — but not for the reason it first appears.
    //
    // `title` DOES collide: the ancestor has neither value, so the field
    // differs from it on both sides and the server puts it in the
    // conflict set. What saves the replay is the policy rather than the
    // absence of a collision — `core.note` keeps both copies for `body`
    // and `notes` only, and resolves `title` last-writer-wins.
    //
    // On a `keep_both_copies` field this replay would spawn a SECOND
    // sibling, because the server's deterministic sibling id is derived
    // from the idempotency key and an update carries none. That is the
    // same missing key the note below describes, and it is the reason
    // this scenario uses `title`: the `body` case cannot pass until the
    // key covers updates.
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

/**
 * The local type graph refuses before the queue, and a schema refusal from
 * the server buys exactly one look at the server's vocabulary.
 *
 * These validate in a space of their own rather than in the server's, and
 * that is what makes the assertions mean anything. `@withmarfa/shared` is
 * external to the server's bundle, so the in-process server and this file
 * share one module-level registry: a type registered over `POST /types` is
 * already in the registry a local validation would read. Hydrating into a
 * different space is the only way to tell a graph this client fetched from
 * one the server happened to leave lying about.
 */
const CLIENT_SPACE = "01a02000-0000-7000-8000-0000000000c6";
const RECIPE = "lm.recipe";

const clientIdentity = {
  origin: "http://localhost",
  spaceId: CLIENT_SPACE,
  accountId: SINGLE_ACCOUNT,
};

describe("a write the type forbids (seam: offline)", () => {
  let scoped: LocalStore;

  beforeEach(async () => {
    scoped = await openLocalStore({
      path: join(dir, "typed.db"),
      identity: clientIdentity,
    });
  });

  afterEach(() => {
    scoped.close();
    // The registry outlives this file inside a reused worker, and both
    // spaces are written during these tests: the client's by hydration,
    // the server's by its own `POST /types`.
    unregisterTypeSchema(RECIPE, CLIENT_SPACE);
    unregisterTypeSchema(RECIPE, null);
  });

  it("refuses a platform type's required field before anything is queued", async () => {
    // Offline throughout: whatever refuses this cannot be the server.
    seam.mode = "offline";

    await expect(
      scoped.mutations.createItem({
        type: "core.note",
        properties: { title: "a note with no body" },
      }),
    ).rejects.toThrow(
      /body: Invalid input: expected string, received undefined/,
    );

    // The point of rule 13 is the queue, not the message. A write that is
    // enqueued and refused an hour later reaches a person long after the
    // edit left their hands, as a dead letter to read rather than a field
    // to fix.
    expect(await scoped.outbox.count()).toBe(0);
    expect(await scoped.deadLetters.list()).toEqual([]);
    expect(seam.calls).toEqual([]);

    // The control. A refusal that also refused good writes would satisfy
    // every assertion above.
    const good = await scoped.mutations.createItem({
      type: "core.note",
      properties: { body: "a note with a body" },
    });
    expect(await scoped.outbox.count()).toBe(1);
    expect(await scoped.visible.getItem(good.id)).toBeDefined();
  });

  it("refuses an edit that would break the row, and leaves the row alone", async () => {
    seam.mode = "offline";
    const note = await scoped.mutations.createItem({
      type: "core.note",
      properties: { body: "as written" },
    });

    await expect(
      scoped.mutations.updateItem(note.id, { body: 42 }),
    ).rejects.toThrow(/body: Invalid input: expected string, received number/);

    expect(await scoped.outbox.count()).toBe(1);
    expect(await scoped.visible.getItem(note.id)).toMatchObject({
      properties: { body: "as written" },
    });

    // Validated as the merged row rather than as the patch: this edit names
    // no `body` at all, and the row's own `body` is what satisfies the
    // type's required field. Refusing it would refuse every partial edit
    // ever made against a type with a required field.
    await scoped.mutations.updateItem(note.id, { title: "named later" });
    expect(await scoped.visible.getItem(note.id)).toMatchObject({
      properties: { body: "as written", title: "named later" },
    });
  });

  it("does not refuse a type it has never heard of", async () => {
    seam.mode = "offline";

    // A store whose cache is cold — a fresh install opened on a plane, a
    // space whose custom types have not been read yet — must still be able
    // to write. The server is the authority on what types exist, and a
    // client that refused everything it did not recognize would be unusable
    // exactly where the local engine is supposed to earn its place.
    const queued = await scoped.mutations.createItem({
      type: "lm.never_hydrated",
      properties: { anything: true },
    });
    expect(await scoped.visible.getItem(queued.id)).toBeDefined();
    expect(await scoped.outbox.count()).toBe(1);
  });

  it("refuses what a hydrated custom type forbids, and did not before hydrating", async () => {
    await client.types.register({
      id: RECIPE,
      version: 1,
      fields: {
        title: { type: "string", required: true },
        servings: { type: "integer" },
      },
    });

    // The control, and the reason the assertion after it is about
    // hydration rather than about the server's own registration sitting in
    // the shared registry: before the graph is read this space has no such
    // type, so the write goes to the queue.
    const beforeHydration = await scoped.mutations.createItem({
      type: RECIPE,
      properties: { servings: 4 },
    });
    expect(await scoped.visible.getItem(beforeHydration.id)).toBeDefined();

    const graph = createTypeGraph({ store: scoped, client });
    expect((await graph.refresh()).registered).toContain(RECIPE);
    expect((await scoped.cachedTypes.list()).map((held) => held.id)).toEqual([
      RECIPE,
    ]);

    seam.reset();
    seam.mode = "offline";
    await expect(
      scoped.mutations.createItem({
        type: RECIPE,
        properties: { servings: 6 },
      }),
    ).rejects.toThrow(
      /title: Invalid input: expected string, received undefined/,
    );
    expect(seam.calls).toEqual([]);
  });

  it("validates against the cached graph on a later open, with no network", async () => {
    await client.types.register({
      id: RECIPE,
      version: 1,
      fields: {
        title: { type: "string", required: true },
        servings: { type: "integer" },
      },
    });
    await createTypeGraph({ store: scoped, client }).refresh();
    scoped.close();

    // Out of the registry entirely, so what follows proves the store put it
    // back rather than finding it still there.
    unregisterTypeSchema(RECIPE, CLIENT_SPACE);
    const reopened = await openLocalStore({
      path: join(dir, "typed.db"),
      identity: clientIdentity,
    });
    try {
      seam.reset();
      seam.mode = "offline";
      const unguarded = await reopened.mutations.createItem({
        type: RECIPE,
        properties: { servings: 8 },
      });
      expect(await reopened.visible.getItem(unguarded.id)).toBeDefined();

      expect(await createTypeGraph({ store: reopened, client }).load()).toBe(1);
      await expect(
        reopened.mutations.createItem({
          type: RECIPE,
          properties: { servings: 9 },
        }),
      ).rejects.toThrow(/title: Invalid input/);
      expect(seam.calls).toEqual([]);
    } finally {
      reopened.close();
      // The outer `afterEach` closes `scoped`, which this test already did.
      // Reopened so that close has something to close.
      scoped = await openLocalStore({
        path: join(dir, "typed.db"),
        identity: clientIdentity,
      });
    }
  });
});

describe("a schema refusal from the server (seam: online)", () => {
  let scoped: LocalStore;
  let graph: ReturnType<typeof createTypeGraph>;
  let graphed: OutboxDrain;

  beforeEach(async () => {
    scoped = await openLocalStore({
      path: join(dir, "refusal.db"),
      identity: clientIdentity,
    });
    graph = createTypeGraph({ store: scoped, client });
    graphed = createOutboxDrain({
      store: scoped,
      client,
      types: graph,
      onEvent: (event) => events.push(event),
    });
  });

  afterEach(() => {
    scoped.close();
    unregisterTypeSchema(RECIPE, CLIENT_SPACE);
    unregisterTypeSchema(RECIPE, null);
  });

  it("refreshes the graph once, revalidates, and dead-letters what the fresh graph still forbids", async () => {
    await client.types.register({
      id: RECIPE,
      version: 1,
      fields: {
        title: { type: "string", required: true },
        servings: { type: "integer" },
      },
    });

    // Queued because this space's graph has never been read, which is the
    // stale-cache case rule 5 exists for rather than a contrivance: a type
    // registered on another device is a type this store has not seen.
    const doomed = await scoped.mutations.createItem({
      type: RECIPE,
      properties: { servings: 4 },
    });

    seam.reset();
    const pass = await graphed.drain();
    expect(pass).toMatchObject({ sent: 0, remaining: 0 });

    // The refusal, then the one read of the server's vocabulary it buys.
    // No second `POST /items`: the refreshed graph answers the question
    // the server already answered, so sending again would spend a request
    // to be told what this client now knows.
    expect(seam.calls).toEqual(["POST /items", "GET /types"]);

    const refused = await scoped.deadLetters.list();
    expect(refused).toHaveLength(1);
    expect(refused[0]).toMatchObject({
      kind: "item.create",
      reason: "refused",
      httpStatus: 400,
      // Both doors answer a schema refusal with this code now. They did
      // not: the create door said `validation_error` where the update door
      // said `invalid_properties`, and a classification recognizing only
      // one of them treated the other as an ordinary 400 and spent no
      // refresh at all. The classifier still accepts both, which is now
      // belt and braces rather than the thing holding this up.
      code: "invalid_properties",
    });
    expect(refused[0]?.message).toMatch(
      /refreshed type graph refuses it too.*title: Invalid input/s,
    );

    // The ghost is gone and the graph is cached, so the next write of this
    // shape is refused before it is queued rather than after.
    expect(await scoped.visible.getItem(doomed.id)).toBeUndefined();
    expect((await scoped.cachedTypes.list()).map((held) => held.id)).toEqual([
      RECIPE,
    ]);
    await expect(
      scoped.mutations.createItem({
        type: RECIPE,
        properties: { servings: 5 },
      }),
    ).rejects.toThrow(/title: Invalid input/);
  });

  it("spends the refresh once when the refusal survives it", async () => {
    // Strict mode: the space refuses properties the type does not declare.
    // It is the honest shape of a refusal a registry refresh cannot resolve,
    // because the strictness is not in the type graph at all — it is space
    // configuration, and reading the vocabulary again returns exactly what
    // this client already holds. Without the guard the engine would refresh
    // on every refusal for ever and never settle the write.
    const space = await client.admin.spaces.create({ name: "strict-space" });
    const minted = await client.admin.keys.create(space.id, {
      label: "strict-space-admin",
      source: "sdk-test-local",
      role: "space_admin",
    });
    const spaceClient = new MarfaClient({
      url: "http://localhost",
      apiKey: minted.key,
      fetch: seam.fetch,
    });
    await spaceClient.spaces.setConfig({
      enforcement: { strict_mode: { types: ["core.note"] } },
    });

    const spaceStore = await openLocalStore({
      path: join(dir, "strict.db"),
      identity: {
        origin: "http://localhost",
        spaceId: space.id,
        accountId: SINGLE_ACCOUNT,
      },
    });
    try {
      const strictDrain = createOutboxDrain({
        store: spaceStore,
        client: spaceClient,
        types: createTypeGraph({ store: spaceStore, client: spaceClient }),
        onEvent: (event) => events.push(event),
      });

      // Accepted locally, and rightly: loose validation is what the
      // server's own create path applies, and a client stricter than the
      // server refuses work a person would have kept.
      await spaceStore.mutations.createItem({
        type: "core.note",
        properties: { body: "held", undeclared: true },
      });

      seam.reset();
      const first = await strictDrain.drain();
      expect(first).toMatchObject({ sent: 0, remaining: 1 });
      expect(seam.calls).toEqual(["POST /items", "GET /types"]);
      // Kept rather than refused: the graph has been read afresh and the
      // write still looks valid against it, so it is owed another send.
      // Nothing about the row has been decided yet.
      expect(await spaceStore.deadLetters.list()).toEqual([]);
      expect(
        (await spaceStore.outbox.list())[0]?.schemaRefreshedAt,
      ).not.toBeNull();

      seam.reset();
      const second = await strictDrain.drain();
      expect(second).toMatchObject({ sent: 0, remaining: 0 });
      // The send, and no second `GET /types`. One refresh per refusal for
      // the life of the mutation — a queue of a hundred writes refused on
      // the same grounds must not ask the server a hundred times for the
      // vocabulary it has already given.
      expect(seam.calls).toEqual(["POST /items"]);
      expect(await spaceStore.deadLetters.list()).toMatchObject([
        {
          kind: "item.create",
          reason: "refused",
          httpStatus: 400,
          // The other of the two codes one refusal answers under. This
          // door raises the route layer's; the create-with-bad-properties
          // door above raises the storage layer's.
          code: "invalid_properties",
        },
      ]);
    } finally {
      spaceStore.close();
    }
  });

  it("is final on the first answer when no graph is wired", async () => {
    await client.types.register({
      id: RECIPE,
      version: 1,
      fields: { title: { type: "string", required: true } },
    });
    await scoped.mutations.createItem({
      type: RECIPE,
      properties: {},
    });

    // No `types`, which is a real configuration rather than an oversight:
    // with no local graph there is nothing that could be stale, so the
    // server's first answer is the only one there is.
    const ungraphed = createOutboxDrain({ store: scoped, client });
    seam.reset();
    await ungraphed.drain();

    expect(seam.calls).toEqual(["POST /items"]);
    expect(await scoped.deadLetters.list()).toHaveLength(1);
  });
});

/**
 * An attachment made offline: the bytes are held locally, the upload goes
 * in front of the write that names them, and a replay tells a lost upload
 * from one that landed.
 *
 * Its own fixture, with a blob ceiling small enough that the server refuses
 * an oversized upload for real. Fabricating that refusal at the seam would
 * test this file's idea of what a refusal looks like; the ceiling is the
 * server's own and the code it answers with is the server's own too.
 */
describe("an attachment made offline (seam: offline, lost_response, then online)", () => {
  const BLOB_CEILING = 64;
  let blobFixture: KeysModeFixture;
  let blobSeam: OfflineSeam;
  let blobClient: MarfaClient;
  let blobStore: LocalStore;
  let blobs: LocalBlobs;
  let blobDrain: OutboxDrain;
  let blobDir: string;

  const photo = (fill: number, size = 16): Uint8Array =>
    new Uint8Array(size).fill(fill);

  const attach = async (
    hash: string,
  ): Promise<{ id: string; properties: Record<string, unknown> }> =>
    blobStore.mutations.createItem({
      type: "core.file.image",
      properties: {
        blob_ref: hash,
        mime_type: "image/png",
        title: "a photograph",
        width: 4,
        height: 4,
      },
    });

  beforeEach(async () => {
    blobFixture = await createKeysModeFixture({ maxBlobSize: BLOB_CEILING });
    blobSeam = createOfflineSeam(blobFixture.fetch);
    blobClient = new MarfaClient({
      url: "http://localhost",
      apiKey: blobFixture.adminKey,
      fetch: blobSeam.fetch,
    });
    blobDir = mkdtempSync(join(tmpdir(), "marfa-local-blobs-"));
    blobStore = await openLocalStore({
      path: join(blobDir, "store.db"),
      identity: {
        origin: "http://localhost",
        spaceId: SINGLE_SPACE,
        accountId: SINGLE_ACCOUNT,
      },
    });
    blobs = createBlobStore({ store: blobStore, client: blobClient });
    blobDrain = createOutboxDrain({
      store: blobStore,
      client: blobClient,
      blobs,
      onEvent: (event) => events.push(event),
    });
  });

  afterEach(() => {
    blobStore.close();
    blobFixture.cleanup();
    rmSync(blobDir, { recursive: true, force: true });
  });

  it("uploads the bytes before the write that references them", async () => {
    blobSeam.mode = "offline";
    const bytes = photo(7);
    const { hash } = await blobs.stage(bytes, "image/png");

    // The reference is written immediately, against bytes no server has
    // seen. That is the point of hashing locally: a person attaches a
    // photograph and the item carries it at once.
    const file = await attach(hash);
    expect(await blobStore.visible.getItem(file.id)).toMatchObject({
      properties: { blob_ref: hash },
    });

    const offlinePass = await blobDrain.drain();
    expect(offlinePass).toMatchObject({ sent: 0, offline: true, remaining: 1 });
    // The upload was what the pass reached for first, and it is the only
    // thing it reached for: the write behind it is not sent to a server
    // that does not have the bytes.
    expect(blobSeam.calls).toEqual(["POST /blobs"]);

    blobSeam.reset();
    blobSeam.mode = "online";
    const pass = await blobDrain.drain();
    expect(pass).toMatchObject({ sent: 1, remaining: 0 });

    // The order, which nothing on the server would object to if it were
    // wrong: `POST /items` does not check that a `blob_ref` resolves, so an
    // item sent first is accepted and carries a reference to nothing. The
    // failure is silent, which is why it is asserted here rather than left
    // to a round trip.
    expect(blobSeam.calls).toEqual([
      "HEAD /blobs/" + hash,
      "POST /blobs",
      "POST /items",
    ]);

    expect(await blobClient.blobs.exists(hash)).toBe(true);
    expect(new Uint8Array(await blobClient.blobs.download(hash))).toEqual(
      bytes,
    );
    expect((await blobClient.items.get(file.id)).properties.blob_ref).toBe(
      hash,
    );
    // The queue row is gone and the bytes are an ordinary cached copy now,
    // rather than the only copy anywhere.
    expect(await blobStore.blobs.get(hash)).toBeUndefined();
    expect(blobs.held(hash)).toBe(true);
  });

  it("tells an upload that landed from one that was lost", async () => {
    // Landed: the server stored the bytes and the answer never came back.
    const landed = photo(3);
    const landedHash = (await blobs.stage(landed, "image/png")).hash;
    const landedItem = await attach(landedHash);

    blobSeam.mode = "lost_response";
    expect(await blobDrain.drain()).toMatchObject({ sent: 0, offline: true });

    blobSeam.reset();
    blobSeam.mode = "online";
    expect(await blobDrain.drain()).toMatchObject({ sent: 1, remaining: 0 });
    // One probe, and no second upload. Re-sending would cost the bytes
    // again for a server that already has them, and on a photograph over a
    // phone connection that is the difference the probe is for.
    expect(blobSeam.calls).toEqual([
      "HEAD /blobs/" + landedHash,
      "POST /items",
    ]);
    expect(
      (await blobClient.items.get(landedItem.id)).properties.blob_ref,
    ).toBe(landedHash);

    // Lost: the request never arrived, so the bytes are still owed.
    const lost = photo(9);
    const lostHash = (await blobs.stage(lost, "image/png")).hash;
    const lostItem = await attach(lostHash);

    blobSeam.mode = "offline";
    expect(await blobDrain.drain()).toMatchObject({ sent: 0, offline: true });

    blobSeam.reset();
    blobSeam.mode = "online";
    expect(await blobDrain.drain()).toMatchObject({ sent: 1, remaining: 0 });
    // The same probe, the other answer, and the upload it makes necessary.
    // A client that skipped the probe would be right here and wrong above;
    // one that never re-uploaded would be right above and leave a dangling
    // reference here.
    expect(blobSeam.calls).toEqual([
      "HEAD /blobs/" + lostHash,
      "POST /blobs",
      "POST /items",
    ]);
    expect(await blobClient.blobs.exists(lostHash)).toBe(true);
    expect((await blobClient.items.get(lostItem.id)).properties.blob_ref).toBe(
      lostHash,
    );
  });

  it("dead-letters the write when the upload is refused, and keeps the bytes", async () => {
    const oversized = photo(1, BLOB_CEILING * 4);
    const { hash } = await blobs.stage(oversized, "image/png");
    const file = await attach(hash);
    // A second write naming the same bytes, to show the refusal reaches
    // everything that waits on it rather than only the first row.
    await blobStore.mutations.updateItem(file.id, { title: "renamed" });

    blobSeam.reset();
    const pass = await blobDrain.drain();
    expect(pass).toMatchObject({ sent: 0, remaining: 0 });
    expect(blobSeam.calls).toEqual(["POST /blobs"]);

    const refused = await blobStore.deadLetters.list();
    expect(refused.map((entry) => [entry.kind, entry.reason])).toEqual([
      ["item.create", "cascaded"],
      ["item.update", "cascaded"],
    ]);
    expect(refused[0]).toMatchObject({
      code: "blob_too_large",
      httpStatus: 413,
    });
    expect(refused[0]?.message).toContain("The bytes are kept.");

    // The half of the rule that matters to a person. An upload the server
    // refused is still a photograph they took, and the engine's answer is
    // to tell them rather than to delete it.
    expect(blobs.held(hash)).toBe(true);
    expect(new Uint8Array(readFileSync(blobs.pathFor(hash)))).toEqual(
      oversized,
    );
    expect(await blobStore.blobs.get(hash)).toMatchObject({
      state: "failed",
      code: "blob_too_large",
    });

    // And they leave only when the app says so, which is the one door out.
    expect(await blobs.discard(hash)).toBe(true);
    expect(blobs.held(hash)).toBe(false);
    expect(await blobStore.blobs.get(hash)).toBeUndefined();
  });
});

/**
 * Offline search over the fields server search indexes.
 *
 * The claim rule 15 makes is a comparison, so these run the same term
 * through both surfaces and compare the sets. Asserting only that offline
 * search finds something would pass against an index over any fields at
 * all; asserting the same items as the server is the property, and it is
 * why the server half is queried live rather than predicted here.
 */
describe("a term found online (seam: online, then offline)", () => {
  let searchStore: LocalStore;
  let searchDir: string;

  /**
   * A subtype of `core.note` whose identifier says nothing about that.
   *
   * The name is the point: `core.note.*` would be reachable by the string
   * test alone, and this deliberately is not, so only the declared parent
   * puts it under `core.note`.
   */
  const JOURNAL = "lm.journal";

  /** Everything the type declares as a display hint, and one field only
   *  the long tail covers, so a mistake in either half shows. */
  const CORPUS = [
    {
      type: "core.note",
      properties: {
        title: "Quarterly bassoon review",
        body: "the reeds arrived late",
      },
    },
    {
      type: "core.note",
      properties: { title: "Grocery list", body: "a bassoon is not food" },
    },
    {
      type: "core.note",
      properties: { title: "Unrelated", body: "nothing of the sort" },
    },
    {
      type: "core.file",
      properties: {
        blob_ref: `sha256:${"a".repeat(64)}`,
        mime_type: "text/plain",
        title: "Receipt",
        // Not a core FTS column and not a display hint: a plain string
        // field the type declares, which the server folds into the index's
        // long tail. It is here because an index built only over the hint
        // fields would find everything above and miss this.
        notes: "paid for the bassoon in cash",
      },
    },
  ] as const;

  /** Named so the refill scenario can reopen the same file after closing
   *  it, which is the only way to reach the open-time index repair. */
  const openSearchStore = (): Promise<LocalStore> =>
    openLocalStore({
      path: join(searchDir, "store.db"),
      identity: {
        origin: "http://localhost",
        spaceId: SINGLE_SPACE,
        accountId: SINGLE_ACCOUNT,
      },
    });

  beforeEach(async () => {
    searchDir = mkdtempSync(join(tmpdir(), "marfa-local-search-"));
    searchStore = await openSearchStore();
  });

  afterEach(() => {
    searchStore.close();
    // The registry is process-global, so a type one scenario registers is
    // still there for the next file unless it is taken back out.
    unregisterTypeSchema(JOURNAL, null);
    rmSync(searchDir, { recursive: true, force: true });
  });

  it("finds the same items offline", async () => {
    for (const seed of CORPUS) {
      await searchStore.mutations.createItem({
        type: seed.type,
        properties: { ...seed.properties },
      });
    }
    const drained = createOutboxDrain({ store: searchStore, client });
    expect(await drained.drain()).toMatchObject({ sent: 4, remaining: 0 });

    const online = await client.search("bassoon");
    // Three of the four, and the fourth is what says the comparison has
    // teeth: a search that matched everything would satisfy "the same set"
    // trivially.
    expect(online).toHaveLength(3);

    seam.mode = "offline";
    const offline = await searchStore.search.find("bassoon");

    const ids = (rows: { item: { id: string } }[]): string[] =>
      rows.map((row) => row.item.id).sort();
    expect(ids(offline)).toEqual(ids(online));

    // The long-tail field specifically, because it is the one an index
    // built over display hints alone would miss. The set equality above
    // already carries which ids matched, so this only has to say that the
    // online half really did return the file item it is named for.
    expect(online.find((row) => row.item.type === "core.file")).toBeDefined();

    // A term in none of the indexed fields finds nothing on either side,
    // which is the control that the index is not simply matching
    // everything.
    seam.mode = "online";
    expect(await client.search("harpsichord")).toHaveLength(0);
    expect(await searchStore.search.find("harpsichord")).toHaveLength(0);

    // The stemmer, which is where "the same fields" stops being enough.
    // Nothing in the corpus contains "arriving"; one note contains
    // "arrived". Both indexes declare `porter unicode61`, so both reduce
    // the two words to one stem and both find that note. An index that
    // lost the stemmer answers nothing here while the server still answers
    // the note, which is the found-online-not-found-offline shape this
    // whole comparison exists to catch — and every term above is an exact
    // match that a bare `unicode61` would have found just as well, so
    // without this the tokenizer is unasserted.
    //
    // The length is asserted rather than the equality alone: two empty
    // sets agree, so a comparison on its own would go green precisely when
    // both sides had stopped working. The control above left the seam
    // online, which is where this needs it.
    const stemmedOnline = await client.search("arriving");
    expect(stemmedOnline).toHaveLength(1);
    seam.mode = "offline";
    expect(ids(await searchStore.search.find("arriving"))).toEqual(
      ids(stemmedOnline),
    );
  });

  it("narrows by type the way the server does, subtypes included", async () => {
    await searchStore.mutations.createItem({
      type: "core.file",
      properties: {
        blob_ref: `sha256:${"b".repeat(64)}`,
        mime_type: "text/plain",
        title: "a plain bassoon file",
      },
    });
    await searchStore.mutations.createItem({
      type: "core.file.image",
      properties: {
        blob_ref: `sha256:${"c".repeat(64)}`,
        mime_type: "image/png",
        title: "a bassoon photograph",
        width: 2,
        height: 2,
      },
    });
    await searchStore.mutations.createItem({
      type: "core.note",
      properties: { title: "a bassoon note", body: "not a file" },
    });
    await createOutboxDrain({ store: searchStore, client }).drain();

    const online = await client.search("bassoon", { type: "core.file" });
    seam.mode = "offline";
    const offline = await searchStore.search.find("bassoon", {
      type: "core.file",
    });

    // Two, not one and not three: `core.file.image` is under `core.file`
    // by declared parent, and the note is not. A filter that matched the
    // identifier exactly would return one, and one that ignored the filter
    // would return three.
    expect(online).toHaveLength(2);
    expect(offline.map((row) => row.item.type).sort()).toEqual([
      "core.file",
      "core.file.image",
    ]);
    expect(offline.map((row) => row.item.id).sort()).toEqual(
      online.map((row) => row.item.id).sort(),
    );
  });

  it("finds a subtype the identifier does not name, through the registry", async () => {
    // The neighbouring scenario narrows on `core.file`, whose subtype is
    // `core.file.image` — a name under the wanted one, which the string
    // test alone answers. So it passes with the registry consulted or not,
    // and the two arms of the subtree test are individually removable
    // against it.
    //
    // This is the case the registry arm exists for and the only one that
    // separates them: a type whose declared parent is `core.note` and
    // whose identifier is nowhere near it. `lm.journal`.startsWith(
    // "core.note.") is false, so nothing but the declared parentage puts
    // it in the answer.
    await client.types.register({
      id: JOURNAL,
      version: 1,
      parent: "core.note",
      fields: { mood: { type: "string" } },
    });
    // No hydration step, deliberately. `@withmarfa/shared` is external to
    // the server's bundle, so the in-process server and this test share one
    // module-level registry and the registration above is already in the
    // one `isSubtypeOf` reads. Taking it back out to force a hydration
    // would take it out of the server's `listTypes` too, since that reads
    // the same map — the server would stop resolving the subtree, and the
    // online half of the comparison would go to one row. Hydrating into a
    // space of its own is how the scenarios that are about hydration avoid
    // that; this one is about the subtree test in `find.ts`.

    await searchStore.mutations.createItem({
      type: JOURNAL,
      properties: {
        title: "a bassoon journal",
        body: "written by hand",
        mood: "content",
      },
    });
    await searchStore.mutations.createItem({
      type: "core.note",
      properties: { title: "a plain bassoon note", body: "typed" },
    });
    await createOutboxDrain({ store: searchStore, client }).drain();

    const online = await client.search("bassoon", { type: "core.note" });
    seam.mode = "offline";
    const offline = await searchStore.search.find("bassoon", {
      type: "core.note",
    });

    // Both, not one: the journal is under `core.note` by declaration
    // alone. A subtree test reduced to the name comparison returns only
    // the plain note here.
    expect(online).toHaveLength(2);
    expect(offline.map((row) => row.item.type).sort()).toEqual([
      "core.note",
      JOURNAL,
    ]);
    expect(offline.map((row) => row.item.id).sort()).toEqual(
      online.map((row) => row.item.id).sort(),
    );
  });

  it("finds a subtype by name alone, for a type it has never heard of (seam: offline)", async () => {
    // The other arm, and the mirror of the scenario above. Nothing
    // registers either of these types, here or on the server, so the
    // registry answers nothing about them — `lm.ledger.page` resolves to
    // no schema at all, and its parentage is therefore undeclared rather
    // than merely unread. The name is the only thing saying it sits under
    // `lm.ledger`, which is the reading `GET /items` and `/search` both
    // give the parameter.
    //
    // It is reachable rather than theoretical: writing a type the client
    // has never heard of is deliberately permitted, so a store whose type
    // cache is cold holds exactly these rows.
    seam.mode = "offline";
    const page = await searchStore.mutations.createItem({
      type: "lm.ledger.page",
      properties: { title: "a bassoon ledger" },
    });

    expect(
      (await searchStore.search.find("bassoon", { type: "lm.ledger" })).map(
        (row) => row.item.id,
      ),
    ).toEqual([page.id]);
  });

  it("refills an index that was lost, on the open that finds it gone", async () => {
    for (const seed of CORPUS) {
      await searchStore.mutations.createItem({
        type: seed.type,
        properties: { ...seed.properties },
      });
    }
    seam.mode = "offline";
    expect(await searchStore.search.find("bassoon")).toHaveLength(3);

    // The shape a store upgraded from a build without this table arrives
    // in, and the shape a column change leaves behind — FTS5 has no ALTER,
    // so the repair is always drop and rebuild. Reached here directly
    // because every other route to it needs a differently-shaped store on
    // disk.
    await searchStore.raw.executeMultiple("DROP TABLE items_fts");
    searchStore.close();

    searchStore = await openSearchStore();

    // The assertion the comment on `ensureSearchIndex` is about. An empty
    // index answers every search with nothing and reads exactly like a
    // search that matched nothing, so a store that reopened without the
    // refill would report an empty library for ever and nothing would say
    // so. Every other scenario here opens an empty store, where a rebuild
    // over zero items cannot tell the two apart.
    expect(await searchStore.search.find("bassoon")).toHaveLength(3);
  });

  it("finds a write that has never been sent, and stops finding a deleted one", async () => {
    const sent = await searchStore.mutations.createItem({
      type: "core.note",
      properties: { title: "sent", body: "a bassoon that reached the server" },
    });
    await createOutboxDrain({ store: searchStore, client }).drain();

    seam.mode = "offline";
    const unsent = await searchStore.mutations.createItem({
      type: "core.note",
      properties: { title: "unsent", body: "a bassoon written on a plane" },
    });

    // The index is over visible state, so a write this client has made and
    // not sent is findable. An index built from server state alone would
    // go quiet on exactly the writes a local store exists to keep.
    expect(
      (await searchStore.search.find("bassoon"))
        .map((row) => row.item.id)
        .sort(),
    ).toEqual([sent.id, unsent.id].sort());

    // And an edit is reflected rather than appended: the old text stops
    // matching. FTS5 has no upsert, so an index that only inserted would
    // hold both versions and go on finding the item by a word the person
    // removed.
    await searchStore.mutations.updateItem(unsent.id, {
      body: "a clarinet written on a plane",
    });
    expect(
      (await searchStore.search.find("bassoon")).map((row) => row.item.id),
    ).toEqual([sent.id]);
    expect(
      (await searchStore.search.find("clarinet")).map((row) => row.item.id),
    ).toEqual([unsent.id]);

    // A queued delete takes it out of the answers, because the answers are
    // resolved through visible state rather than served from the index.
    await searchStore.mutations.deleteItem(unsent.id);
    expect(await searchStore.search.find("clarinet")).toEqual([]);
  });
});
