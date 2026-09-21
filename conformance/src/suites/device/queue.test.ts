import { describe, it, expect, afterEach } from "vitest";
import { answers, wireItem, writeAnswers } from "../../device/marfa-answers.js";
import type { DeviceUnderTest, QueuedWrite } from "../../device/protocol.js";
import { hydratedHarness, scriptWrites, startHarness } from "./harness.js";
import type { Harness } from "./harness.js";

let harness: Harness | undefined;

afterEach(async () => {
  await harness?.stop();
  harness = undefined;
});

/**
 * "A device holds a working copy and a queue."
 *
 * The queue is what makes a device usable when the server is not there, and
 * every rule in it guards a way of losing a write that nobody can see: a write
 * sent without the version it read, a retry that spends a key, a write sent
 * before the row it depends on, a queue cleared by a re-hydration. A queue
 * that drops a write reports nothing, because the caller was already told the
 * write was queued.
 */

/** A row the copy already holds, so an update has something to be based on. */
const HELD = { id: "01a00000-0000-7000-8000-00000000000a", version: 3 };

function held() {
  return {
    "core.note": [
      {
        item: {
          id: HELD.id,
          version: HELD.version,
          properties: { title: "held", body: "held" },
        },
      },
    ],
  };
}

/** A 200 body for a create, shaped as the server shapes one. */
function createdBody(id: string): unknown {
  const answer = answers.created(wireItem({ id }));
  if (answer.kind !== "json") throw new Error("a json answer has a body");
  return answer.body;
}

/** The queue, or a failure naming what the device said instead. */
async function queueOf(device: DeviceUnderTest): Promise<QueuedWrite[]> {
  const queued = await device.queue();
  expect(
    queued.ok,
    `the device refused to report its queue, so nothing below can say what it holds: ${JSON.stringify(queued)}`,
  ).toBe(true);
  if (!queued.ok) throw new Error("unreachable: the assertion above threw");
  return queued.value;
}

/** The ids of the rows a POST carried, in the order they were sent. */
function creates(harness: Harness): string[] {
  return harness.server.requests
    .filter((request) => request.method === "POST")
    .map((request) => (JSON.parse(request.body) as { id: string }).id);
}

describe("the queue answers before there is anything in it", () => {
  it("reports an empty queue on a store that has never been written to", async () => {
    harness = await startHarness("queue-empty");

    // Answerable without a hydration, and this is the case that says so. A
    // caller asking what is outstanding is asking about what they queued,
    // not about the copy: a device that made them hydrate first would
    // refuse the question at the moment it matters most, which is when the
    // server cannot be reached.
    const queued = await harness.device.queue();
    expect(
      queued.ok,
      `a device refused to report its queue, so a caller cannot find out what is outstanding: ${JSON.stringify(queued)}`,
    ).toBe(true);
    if (!queued.ok) return;
    expect(
      queued.value,
      "a store with no writes reported something queued, so the queue reports rows nobody asked for",
    ).toEqual([]);
  });
});

describe("the queue keeps its order", () => {
  it("sends queued writes in the order they were queued", async () => {
    harness = await hydratedHarness("queue-order", { rows: held() });
    const first = await harness.device.create({
      type: "core.note",
      properties: { title: "first", body: "first" },
    });
    const second = await harness.device.create({
      type: "core.note",
      properties: { title: "second", body: "second" },
    });
    expect(first.ok && second.ok).toBe(true);
    if (!first.ok || !second.ok) return;

    scriptWrites(harness.server, {
      create: [
        answers.created(wireItem({ id: first.value.item_id ?? "a" })),
        answers.created(wireItem({ id: second.value.item_id ?? "b" })),
      ],
    });
    const drained = await harness.device.drain();
    expect(drained.ok).toBe(true);
    if (!drained.ok) return;

    const sent = creates(harness);
    // The control on the assertion below: an order is not an order if only
    // one request went.
    expect(
      sent.length,
      "the drain sent fewer requests than the queue held, so the order below is the order of whatever happened to go",
    ).toBe(2);
    expect(
      sent,
      "the drain sent the two creates in an order other than the one they were queued in, so a caller cannot reason about what reaches the server first",
    ).toEqual([first.value.item_id, second.value.item_id]);
  });

  it("keeps the queue across a restart", async () => {
    harness = await hydratedHarness("queue-restart", { rows: held() });
    const queued = await harness.device.create({
      type: "core.note",
      properties: { title: "survives", body: "survives" },
    });
    expect(queued.ok).toBe(true);
    if (!queued.ok) return;

    // A second device over the same store file, which is what a restart is:
    // the process that queued the write is gone and the store is not.
    const restarted = harness.device.reopen();
    const after = await queueOf(restarted);
    expect(
      after.map((row) => row.id),
      "the queue was empty after the process that made it went, so a write a caller was told was queued is gone and nothing reports it",
    ).toEqual([queued.value.id]);
    expect(
      after[0]?.idempotency_key,
      "the key changed across the restart, so a retry would be written a second time rather than answered from the record",
    ).toBe(queued.value.idempotency_key);
  });
});

describe("every write names the version it read", () => {
  it("refuses an update queued with no version", async () => {
    harness = await hydratedHarness("queue-version", { rows: held() });
    const refused = await harness.device.update(HELD.id, {
      properties: { title: "no version" },
    });
    expect(
      refused.ok,
      "an update with no version was queued, and a write that names no version overwrites whatever it finds — the defect the folder rules were written against",
    ).toBe(false);
    // Refused before it is sent rather than by the server, so the rule does
    // not depend on a server that might not refuse.
    expect(
      harness.server.requests.filter((request) => request.method !== "GET"),
      "the device sent a version-less update to the server instead of refusing it, so the refusal rests on a server that might take it",
    ).toEqual([]);
    expect(
      await queueOf(harness.device),
      "a refused update was queued anyway, so a drain would send it later",
    ).toEqual([]);
  });

  it("sends a create with the version it was based on", async () => {
    harness = await hydratedHarness("queue-create-version", { rows: held() });
    const withVersion = await harness.device.create({
      type: "core.note",
      properties: { title: "conditional", body: "conditional" },
      source: "folder",
      sourceId: "note.md",
      version: 7,
    });
    const without = await harness.device.create({
      type: "core.note",
      properties: { title: "plain", body: "plain" },
    });
    expect(withVersion.ok && without.ok).toBe(true);
    if (!withVersion.ok || !without.ok) return;
    expect(
      withVersion.value.base_version,
      "the create dropped the version it was based on, so the server cannot make it conditional and a stale machine overwrites newer content",
    ).toBe(7);

    scriptWrites(harness.server, {
      create: [
        answers.created(wireItem({ id: withVersion.value.item_id ?? "a" })),
        answers.created(wireItem({ id: without.value.item_id ?? "b" })),
      ],
    });
    expect((await harness.device.drain()).ok).toBe(true);

    const bodies = harness.server.requests
      .filter((request) => request.method === "POST")
      .map((request) => JSON.parse(request.body) as { version?: number });
    expect(
      bodies[0]?.version,
      "the version reached the queue and not the wire, so the server was never asked to make the create conditional",
    ).toBe(7);
    // The other arm, and it is the one that says the field is carried rather
    // than always present: a create with no version must send none, because
    // a version the device invented would be a version it minted.
    expect(
      "version" in (bodies[1] ?? {}),
      "a create nobody gave a version to carried one anyway, which is a version the device minted",
    ).toBe(false);
  });
});

describe("a write is answered once", () => {
  it("retries under the key it was queued with, and is answered from the record rather than written twice", async () => {
    harness = await hydratedHarness("queue-key", { rows: held() });
    const queued = await harness.device.create({
      type: "core.note",
      properties: { title: "once", body: "once" },
    });
    expect(queued.ok).toBe(true);
    if (!queued.ok) return;
    const id = queued.value.item_id ?? "a";

    // The first attempt meets a 5xx, which retries and is not counted; the
    // second is answered from the server's record.
    scriptWrites(harness.server, {
      create: [
        { kind: "json", status: 503, body: { error: { code: "unavailable" } } },
        {
          kind: "json",
          status: 200,
          body: createdBody(id),
          headers: { "Idempotency-Replayed": "true" },
        },
      ],
    });
    expect((await harness.device.drain()).ok).toBe(true);
    const second = await harness.device.drain();
    expect(second.ok).toBe(true);
    if (!second.ok) return;

    const keys = harness.server.requests
      .filter((request) => request.method === "POST")
      .map((request) => request.headers["idempotency-key"]);
    expect(
      keys,
      "the two attempts went under different keys, so the server wrote the item twice and told the device it had succeeded both times",
    ).toEqual([queued.value.idempotency_key, queued.value.idempotency_key]);
    expect(
      second.value.verdicts[0]?.replayed,
      "the device did not report that the server answered from its record, so a caller cannot tell a write that landed now from one that had already landed",
    ).toBe(true);
  });
});

describe("a write waits for what it depends on", () => {
  it("holds a write whose create has not been answered", async () => {
    harness = await hydratedHarness("queue-depends", { rows: held() });
    const created = await harness.device.create({
      type: "core.note",
      properties: { title: "parent", body: "parent" },
    });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const id = created.value.item_id ?? "a";

    // The local row lands at a version the server never mints, so an update
    // to it is an update to something the server has not seen.
    const edit = await harness.device.update(id, {
      properties: { title: "child" },
      version: 0,
    });
    expect(
      edit.ok,
      `an update to a row this copy holds was refused: ${JSON.stringify(edit)}`,
    ).toBe(true);
    if (!edit.ok) return;
    expect(
      edit.value.depends_on,
      "the update does not name the create it waits for, so a drain has nothing to hold it by and sends it to a server with no such row",
    ).toEqual([created.value.id]);

    // The create meets a network; the update must not go at all.
    scriptWrites(harness.server, { create: [{ kind: "drop" }] });
    const drained = await harness.device.drain();
    expect(drained.ok).toBe(true);
    if (!drained.ok) return;
    expect(
      drained.value.held,
      "the drain sent a write whose create had not been answered, and the server has no such row to write it to",
    ).toBe(1);
    expect(
      harness.server.requests.some((request) => request.method === "PATCH"),
      "the update went to the server although the create it waits for was never answered",
    ).toBe(false);
    const waiting = (await queueOf(harness.device)).find(
      (row) => row.id === edit.value.id,
    );
    expect(
      waiting?.reason,
      "the held write does not say what it is waiting for, so a caller sees a stalled queue and no reason",
    ).toBe("awaiting_dependency");
  });
});

describe("what a drain sends and reports", () => {
  it("sends every update with the server asked to resolve", async () => {
    harness = await hydratedHarness("queue-conflict-auto", { rows: held() });
    const edit = await harness.device.update(HELD.id, {
      properties: { title: "edited" },
      version: HELD.version,
    });
    expect(edit.ok).toBe(true);

    scriptWrites(harness.server, {
      update: [
        answers.updated(wireItem({ id: HELD.id, version: HELD.version + 1 })),
      ],
    });
    expect((await harness.device.drain()).ok).toBe(true);

    const patch = harness.server.requests.find(
      (request) => request.method === "PATCH",
    );
    expect(
      patch,
      "no update reached the server, so there is nothing here to say how it was sent",
    ).toBeDefined();
    expect(
      patch?.query.get("conflict"),
      "the update went without asking the server to resolve, so a collision comes back as a refusal this device is forbidden to settle itself",
    ).toBe("auto");
  });

  it("reports a verdict for every write it sent", async () => {
    harness = await hydratedHarness("queue-report", { rows: held() });
    const created = await harness.device.create({
      type: "core.note",
      properties: { title: "reported", body: "reported" },
    });
    const edited = await harness.device.update(HELD.id, {
      properties: { title: "reported too" },
      version: HELD.version,
    });
    expect(created.ok && edited.ok).toBe(true);
    if (!created.ok || !edited.ok) return;

    scriptWrites(harness.server, {
      create: [answers.created(wireItem({ id: created.value.item_id ?? "a" }))],
      update: [
        answers.updated(wireItem({ id: HELD.id, version: HELD.version + 1 })),
      ],
    });
    const drained = await harness.device.drain();
    expect(drained.ok).toBe(true);
    if (!drained.ok) return;

    expect(
      drained.value.verdicts.map((verdict) => verdict.id),
      "the drain sent writes it did not report, so a caller running one cannot find out what became of them",
    ).toEqual([created.value.id, edited.value.id]);
    expect(
      drained.value.sent,
      "the count of what was sent disagrees with the verdicts reported beside it",
    ).toBe(2);
    for (const verdict of drained.value.verdicts) {
      expect(
        verdict.verdict,
        `a write the drain sent was reported with no verdict at all: ${JSON.stringify(verdict)}`,
      ).not.toBeNull();
    }
    // And the queue agrees with the report, because a caller reads one or
    // the other and they are two accounts of the same thing.
    const queue = await queueOf(harness.device);
    expect(
      queue.map((row) => row.verdict),
      "the queue and the drain's own report disagree about what became of the same writes",
    ).toEqual(drained.value.verdicts.map((verdict) => verdict.verdict));
  });
});

/**
 * The kinds a queue holds (`queue-and-verdicts.md` 32).
 *
 * `upload_blob` is the one this build cannot yet send: blob work is outside
 * this milestone, and the queue holding a kind whose door has not been built
 * is the contract's shape rather than a gap in it.
 */
const WRITE_KINDS = [
  "create_item",
  "update_item",
  "delete_item",
  "restore_item",
  "transition_item",
  "create_edge",
  "update_edge",
  "delete_edge",
  "replace_metadata",
  "merge_metadata",
  "add_tag",
  "remove_tag",
  "write_extension",
  "delete_extension",
  "upload_blob",
] as const;

describe("what a queue holds", () => {
  it("holds one kind per write, from the closed set", async () => {
    harness = await hydratedHarness("queue-kinds", { rows: held() });
    const { device } = harness;
    const second = await device.create({
      type: "core.note",
      properties: { title: "other end", body: "other end" },
    });
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    const other = second.value.item_id ?? "b";

    const edge = await device.createEdge({
      source: HELD.id,
      target: other,
      type: "core.references",
    });
    expect(
      edge.ok,
      `an edge could not be queued: ${JSON.stringify(edge)}`,
    ).toBe(true);
    if (!edge.ok) return;
    const edgeId = edge.value.edge_id ?? "e";

    // Every kind this build can queue, once each.
    // One at a time, and deliberately: each is its own process, and a
    // device holds the writer handle for as long as its process lives — so
    // twelve started at once would contend for it and eleven would be
    // refused as readers.
    const asked: Array<[string, () => Promise<{ ok: boolean }>]> = [
      [
        "update_item",
        () =>
          device.update(HELD.id, {
            properties: { title: "x" },
            version: HELD.version,
          }),
      ],
      [
        "update_edge",
        () =>
          device.updateEdge(edgeId, { properties: { note: "x" }, version: 0 }),
      ],
      ["add_tag", () => device.addTag(HELD.id, "alpha")],
      ["remove_tag", () => device.removeTag(HELD.id, "alpha")],
      [
        "merge_metadata",
        () => device.writeMetadata(HELD.id, ["beta"], "merge"),
      ],
      [
        "replace_metadata",
        () => device.writeMetadata(HELD.id, ["gamma"], "replace"),
      ],
      [
        "write_extension",
        () => device.writeExtension(HELD.id, "app.notes", { a: 1 }),
      ],
      ["delete_extension", () => device.deleteExtension(HELD.id, "app.notes")],
      ["transition_item", () => device.transitionItem(HELD.id, "archived")],
      ["delete_item", () => device.deleteItem(HELD.id)],
      ["restore_item", () => device.restoreItem(HELD.id)],
      ["delete_edge", () => device.deleteEdge(edgeId)],
    ];
    for (const [kind, asking] of asked) {
      const outcome = await asking();
      expect(
        outcome.ok,
        `the device could not queue a ${kind}: ${JSON.stringify(outcome)}`,
      ).toBe(true);
    }

    const queue = await queueOf(device);
    const kinds = queue.map((row) => row.kind);
    for (const kind of kinds) {
      expect(
        WRITE_KINDS,
        `the queue holds a ${kind}, which is not one of the kinds the contract names: a store carrying a kind outside the set is one no drain can send`,
      ).toContain(kind);
    }
    // The other direction, and the one that matters: every kind this build
    // can queue was queued, so the set is not merely not-exceeded.
    const unreachable = WRITE_KINDS.filter((kind) => !kinds.includes(kind));
    expect(
      unreachable,
      "kinds the contract names are unreachable through this device, so the closed set is a list rather than a description of what the device does",
    ).toEqual(["upload_blob"]);

    // One kind per row, never two. The kind is what decides the door, so a
    // row that was two kinds would be a write sent to one and read as the
    // other.
    for (const row of queue) {
      expect(
        typeof row.kind === "string" && row.kind.length > 0,
        `a queued row carries no kind at all: ${JSON.stringify(row)}`,
      ).toBe(true);
    }
    // And a purge is not among them (`device.md` 25): the binary offers no
    // command for one, so no queue can hold one.
    expect(
      WRITE_KINDS,
      "a purge is a kind the queue holds, and purging is the server's alone",
    ).not.toContain("purge_item");
  });

  it("queues an edge, a tag and an extension as writes of their own", async () => {
    harness = await hydratedHarness("queue-own-writes", { rows: held() });
    const { device } = harness;

    // A create naming tags. They are not part of an item's fields, so they
    // do not ride in the create's body: each is queued on its own, waiting
    // on the create.
    const created = await device.create({
      type: "core.note",
      properties: { title: "tagged", body: "tagged" },
      tags: ["alpha", "beta"],
    });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const id = created.value.item_id ?? "a";

    const edge = await device.createEdge({
      source: HELD.id,
      target: id,
      type: "core.references",
    });
    expect(edge.ok).toBe(true);
    const extension = await device.writeExtension(HELD.id, "app.notes", {
      pinned: true,
    });
    expect(extension.ok).toBe(true);

    const queue = await queueOf(device);
    expect(
      queue.map((row) => row.kind),
      "the tags, the edge and the extension were not queued as writes of their own, so a verdict about the create is a verdict about all of them and a tag added elsewhere collides with a title changed here",
    ).toEqual([
      "create_item",
      "add_tag",
      "add_tag",
      "create_edge",
      "write_extension",
    ]);
    expect(
      queue.filter((row) => row.kind === "add_tag").map((row) => row.tag),
      "the queued tag writes do not say which tag each is about",
    ).toEqual(["alpha", "beta"]);
    for (const row of queue.filter((row) => row.kind === "add_tag")) {
      expect(
        row.depends_on,
        "a tag write does not wait for the create it belongs to, so it would be sent to a server with no such row",
      ).toEqual([created.value.id]);
    }

    // Nothing was dropped and nothing rode inline: the create's body carries
    // no tags, and the copy holds them.
    scriptWrites(harness.server, {
      create: [answers.created(wireItem({ id }), ["alpha", "beta"])],
      tags: [writeAnswers.metadata(id, ["alpha", "beta"])],
      extensions: [writeAnswers.extensions({ "app.notes": { pinned: true } })],
      edges: [
        writeAnswers.edge({
          id: "01a00000-0000-7000-8000-0000000000ee",
          source_id: HELD.id,
          target_id: id,
        }),
      ],
    });
    expect((await device.drain()).ok).toBe(true);
    const body = JSON.parse(
      harness.server.requests.find((request) => request.method === "POST")
        ?.body ?? "{}",
    ) as Record<string, unknown>;
    expect(
      "tags" in body,
      "the create carried its tags inline, so the server answers one verdict for a write and a tag, and a device cannot say which of them landed",
    ).toBe(false);

    const read = await device.get(id);
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(
      read.value.tags,
      "the copy does not hold the tags the caller asked for, so a local read answers an item that never had them",
    ).toEqual(["alpha", "beta"]);
  });
});

describe("a write that is not about an item's fields", () => {
  /**
   * Every kind whose door answers with something other than an item.
   *
   * Ten of the fourteen sendable kinds are in here. Read against the item
   * shape instead, a tag, an edge, a metadata write, an extension and a
   * delete all come back as an answer the device cannot read: the server
   * does the work, the device counts a refusal, sends it again, and kills
   * it on the fifth pass, silently, until the row goes `dead`.
   *
   * So each door is scripted with the body its own door returns. Scripting
   * them all item-shaped is a shape no server gives, and it makes every one
   * of these pass against a device that can read none of them.
   */
  it("reads the answer its own door gives, not an item's", async () => {
    harness = await hydratedHarness("queue-shapes", { rows: held() });
    const { device } = harness;
    const other = await device.create({
      type: "core.note",
      properties: { title: "other end", body: "other end" },
    });
    expect(other.ok).toBe(true);
    if (!other.ok) return;
    const otherId = other.value.item_id ?? "b";
    const edge = await device.createEdge({
      source: HELD.id,
      target: otherId,
      type: "references",
    });
    expect(edge.ok).toBe(true);
    if (!edge.ok) return;
    const edgeId = edge.value.edge_id ?? "e";

    // One of each remaining kind, queued in an order that leaves the item
    // alive at the end.
    const queued: Array<[string, () => Promise<{ ok: boolean }>]> = [
      ["add_tag", () => device.addTag(HELD.id, "alpha")],
      ["remove_tag", () => device.removeTag(HELD.id, "alpha")],
      [
        "merge_metadata",
        () => device.writeMetadata(HELD.id, ["beta"], "merge"),
      ],
      [
        "replace_metadata",
        () => device.writeMetadata(HELD.id, ["gamma"], "replace"),
      ],
      [
        "write_extension",
        () => device.writeExtension(HELD.id, "app.notes", { a: 1 }),
      ],
      ["delete_extension", () => device.deleteExtension(HELD.id, "app.notes")],
      [
        "update_edge",
        () =>
          device.updateEdge(edgeId, { properties: { note: "x" }, version: 0 }),
      ],
      ["delete_edge", () => device.deleteEdge(edgeId)],
      ["transition_item", () => device.transitionItem(HELD.id, "archived")],
      ["restore_item", () => device.restoreItem(HELD.id)],
      ["delete_item", () => device.deleteItem(HELD.id)],
    ];
    for (const [kind, ask] of queued) {
      const outcome = await ask();
      expect(outcome.ok, `could not queue a ${kind}`).toBe(true);
    }

    // Each door answering exactly what it answers.
    scriptWrites(harness.server, {
      create: [answers.created(wireItem({ id: otherId }))],
      update: [answers.updated(wireItem({ id: HELD.id, version: 4 }))],
      tags: [writeAnswers.metadata(HELD.id, ["alpha"])],
      extensions: [writeAnswers.extensions({})],
      edges: [
        writeAnswers.edge({
          id: edgeId,
          source_id: HELD.id,
          target_id: otherId,
        }),
      ],
    });
    harness.server.answer("DELETE", /^\/items\/[^/]+$/, writeAnswers.ok());
    harness.server.answer("DELETE", /^\/edges\/[^/]+$/, writeAnswers.ok());
    harness.server.answer(
      "POST",
      /^\/items\/[^/]+\/restore$/,
      answers.updated(wireItem({ id: HELD.id, version: 5 })),
    );
    harness.server.answer(
      "POST",
      /^\/items\/[^/]+\/transition$/,
      answers.updated(wireItem({ id: HELD.id, version: 5, state: "archived" })),
    );

    const drained = await device.drain();
    expect(drained.ok).toBe(true);
    if (!drained.ok) return;

    const unanswered = drained.value.verdicts.filter(
      (verdict) => verdict.verdict === null,
    );
    expect(
      unanswered.map((verdict) => verdict.kind),
      "the device could not read the answer these doors gave, so a write the server had already taken was counted as a failure and will be killed on the fifth pass",
    ).toEqual([]);
    expect(
      drained.value.verdicts.every((verdict) => verdict.verdict === "accepted"),
      `a door the server answered plainly took a verdict other than accepted: ${JSON.stringify(drained.value.verdicts)}`,
    ).toBe(true);
    // The control: every kind actually went. Without it the absence above
    // is satisfied by a drain that sent nothing.
    expect(
      drained.value.sent,
      "the drain did not send every queued write, so the verdicts above are about a subset",
    ).toBe(queued.length + 2);
    // And none of them counted a refusal, which is what the wrong shape did.
    expect(
      drained.value.verdicts.map((verdict) => verdict.refusals),
      "a write the server answered counted a refusal against itself",
    ).toEqual(drained.value.verdicts.map(() => 0));
  });
});

describe("offline, reconnect and re-hydration", () => {
  it("queues writes while the server is unreachable", async () => {
    harness = await hydratedHarness("queue-offline", { rows: held() });
    await harness.server.offline();

    const queued = await harness.device.create({
      type: "core.note",
      properties: { title: "offline", body: "offline" },
    });
    expect(
      queued.ok,
      `a device refused to queue a write while the server was unreachable, which is the one time a queue is the whole point: ${JSON.stringify(queued)}`,
    ).toBe(true);
    if (!queued.ok) return;

    const drained = await harness.device.drain();
    expect(
      drained.ok,
      `a drain against an unreachable server refused rather than leaving the queue where it was: ${JSON.stringify(drained)}`,
    ).toBe(true);
    if (!drained.ok) return;
    expect(
      drained.value.verdicts[0]?.verdict,
      "a write the network refused was given a verdict, and a device that could not ask has not been answered",
    ).toBeNull();
    expect(
      drained.value.verdicts[0]?.refusals,
      "an unreachable server spent the ceiling, so a week offline would kill a valid write",
    ).toBe(0);

    await harness.server.online();
    const row = (await queueOf(harness.device))[0];
    expect(
      row?.verdict,
      "an outage left a verdict on a write nobody answered",
    ).toBeNull();
    expect(
      row?.id,
      "the write queued during the outage is gone, and the caller was told it was queued",
    ).toBe(queued.value.id);
  });

  it("drains in order on reconnect", async () => {
    harness = await hydratedHarness("queue-reconnect", { rows: held() });
    const before = await harness.device.create({
      type: "core.note",
      properties: { title: "before", body: "before" },
    });
    expect(before.ok).toBe(true);
    if (!before.ok) return;

    await harness.server.offline();
    const during = await harness.device.create({
      type: "core.note",
      properties: { title: "during", body: "during" },
    });
    expect(during.ok).toBe(true);
    if (!during.ok) return;
    // The drain while offline is what makes this about a reconnect rather
    // than about two writes queued back to back: without it, nothing was
    // ever attempted and the order below is just the order they were made.
    expect((await harness.device.drain()).ok).toBe(true);
    await harness.server.online();

    scriptWrites(harness.server, {
      create: [
        answers.created(wireItem({ id: before.value.item_id ?? "a" })),
        answers.created(wireItem({ id: during.value.item_id ?? "b" })),
      ],
    });
    expect((await harness.device.drain()).ok).toBe(true);

    expect(
      creates(harness),
      "the write queued before the outage was answered after the one queued during it, so the queue's order did not survive the reconnect",
    ).toEqual([before.value.item_id, during.value.item_id]);
  });

  it("keeps the queue through a re-hydration", async () => {
    harness = await hydratedHarness("queue-rehydrate", { rows: held() });
    const queued = await harness.device.create({
      type: "core.note",
      properties: { title: "survives", body: "survives" },
    });
    expect(queued.ok).toBe(true);
    if (!queued.ok) return;

    // A re-hydration clears the working copy: items, edges, tags and the
    // search index all go. The queue is not part of the copy and must not.
    const again = await harness.device.hydrate(["core.note"], "library");
    expect(
      again.ok,
      `the re-hydration this case turns on did not happen: ${JSON.stringify(again)}`,
    ).toBe(true);

    const after = await queueOf(harness.device);
    expect(
      after.map((row) => row.id),
      "a re-hydration cleared the queue, so writes a caller was told were queued went with the copy and nothing reports them",
    ).toEqual([queued.value.id]);
    expect(
      after[0]?.idempotency_key,
      "the queue survived the re-hydration with a different key, so a write already answered would be written a second time",
    ).toBe(queued.value.idempotency_key);
  });

  it("shows an unanswered local write to a local read", async () => {
    harness = await hydratedHarness("queue-local-read", { rows: held() });
    // The title and the body carry different words on purpose: the index
    // holds both, so a search for a word the body still says would find the
    // row whether or not the title was reindexed.
    const queued = await harness.device.create({
      type: "core.note",
      properties: { title: "unanswered", body: "a body that does not change" },
    });
    expect(queued.ok).toBe(true);
    if (!queued.ok) return;
    const id = queued.value.item_id ?? "a";

    const read = await harness.device.get(id);
    expect(
      read.ok,
      `a row the device had just written was not readable locally, so a caller told the write was queued cannot see what they wrote: ${JSON.stringify(read)}`,
    ).toBe(true);
    if (!read.ok) return;
    expect(read.value.properties.title).toBe("unanswered");

    // Findable, not merely readable by an id the caller happens to hold. A
    // row that can only be reached by its id is a row a person cannot find,
    // and the id is the one thing they did not choose.
    const found = await harness.device.search("unanswered");
    expect(
      found.ok,
      `a local search refused while a write was outstanding: ${JSON.stringify(found)}`,
    ).toBe(true);
    if (!found.ok) return;
    expect(
      found.value.map((hit) => hit.item.id),
      "a row the device wrote and nobody has answered is not in the local index, so a person searching for what they just wrote is told it is not there",
    ).toEqual([id]);

    // And an edit nobody has answered is findable by what it changed, not
    // only by what the row said before.
    const edited = await harness.device.update(id, {
      properties: { title: "reworded" },
      version: 0,
    });
    expect(edited.ok).toBe(true);
    const afterEdit = await harness.device.search("reworded");
    expect(afterEdit.ok).toBe(true);
    if (!afterEdit.ok) return;
    expect(
      afterEdit.value.map((hit) => hit.item.id),
      "an edit nobody has answered is not in the local index, so the index answers what the row used to say",
    ).toEqual([id]);
    // The control: the words it no longer carries no longer find it, so the
    // index was rewritten rather than merely added to.
    const stale = await harness.device.search("unanswered");
    expect(stale.ok).toBe(true);
    if (!stale.ok) return;
    expect(
      stale.value,
      "the index still answers the title the edit replaced, so it grows a copy per edit and a search answers rows that no longer say what it matched",
    ).toEqual([]);
    expect(
      read.value.version,
      "the local row carries a version the server mints, so nothing can tell it from a row the server has answered for",
    ).toBe(0);

    // And it is reconciled to the server's row when the verdict arrives,
    // which is the other half of the statement.
    // Both doors: the edit above is queued too, so a drain sends a create
    // and then the update that depends on it.
    scriptWrites(harness.server, {
      create: [
        answers.created(
          wireItem({
            id,
            version: 1,
            properties: {
              title: "reworded",
              body: "a body that does not change",
            },
          }),
        ),
      ],
      update: [
        answers.updated(
          wireItem({
            id,
            version: 2,
            properties: {
              title: "as the server took it",
              body: "a body that does not change",
            },
          }),
        ),
      ],
    });
    expect((await harness.device.drain()).ok).toBe(true);
    const settled = await harness.device.get(id);
    expect(settled.ok).toBe(true);
    if (!settled.ok) return;
    expect(
      settled.value.version,
      "the working copy kept its own version after the server answered, so the row it holds is one the server never wrote",
    ).toBe(2);
    expect(settled.value.properties.title).toBe("as the server took it");
  });
});
