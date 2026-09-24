import { describe, it, expect, afterEach } from "vitest";
import {
  answers,
  refusal,
  wireItem,
  writeAnswers,
} from "../../device/marfa-answers.js";
import type { DeviceUnderTest, QueuedWrite } from "../../device/protocol.js";
import type { Responder } from "../../device/scripted-server.js";
import { chmodSync, existsSync, rmSync } from "node:fs";
import {
  KEY,
  acceptUploads,
  fileOf,
  hashOf,
  hydratedHarness,
  scriptWrites,
  startHarness,
} from "./harness.js";
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

/** An edge row as the server answers one. */
function edgeRow(
  id: string,
  source: string,
  target: string,
  version: number,
  properties: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    id,
    source_id: source,
    target_id: target,
    edge_type: "references",
    properties,
    version,
    created_at: "2026-09-18T00:00:00.000Z",
    updated_at: "2026-09-18T00:00:00.000Z",
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

    // **The witness for both absences above.** An empty queue and an empty
    // request log are what a device that queues nothing and sends nothing
    // also has, so neither assertion says anything on its own. The same
    // update with a version queues, and draining it puts a non-GET on the
    // server: both things the assertions above say did not happen are
    // producible on this harness, in this case.
    const accepted = await harness.device.update(HELD.id, {
      properties: { title: "with version" },
      version: HELD.version,
    });
    expect(
      accepted.ok,
      "the same update with a version was refused too, so the refusal above is the door rather than the missing version",
    ).toBe(true);
    expect((await queueOf(harness.device)).length).toBe(1);

    scriptWrites(harness.server, {
      update: [answers.updated(wireItem({ id: HELD.id, version: 4 }))],
    });
    expect((await harness.device.drain()).ok).toBe(true);
    expect(
      harness.server.requests.filter((request) => request.method !== "GET")
        .length,
      "a queued update did not reach the server either, so the empty request log above says nothing about the refusal",
    ).toBe(1);
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

/** The kinds a queue holds (`queue-and-verdicts.md` 32). */
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
    // thirteen started at once would contend for it and twelve would be
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
      ["upload_blob", () => device.putBlob(fileOf("note.txt", "bytes"))],
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
    ).toEqual([]);

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

describe("an answer the device applies keeps what it has not had answered", () => {
  /** A create door that takes whatever it is sent, at version 1. */
  function acceptCreates(harnessUnderTest: Harness): void {
    scriptWrites(harnessUnderTest.server, {
      create: [
        (request) => {
          const sent = JSON.parse(request.body) as {
            id: string;
            properties: Record<string, unknown>;
          };
          return answers.created(
            wireItem({ id: sent.id, version: 1, properties: sent.properties }),
          );
        },
      ],
    });
  }

  it("keeps the writes it has not had answered through the answer to an earlier one", async () => {
    harness = await hydratedHarness("queue-overlay-answer", { rows: held() });
    const { device, server } = harness;
    const note = await device.create({
      type: "core.note",
      properties: { title: "as created", body: "the body" },
    });
    const binned = await device.create({
      type: "core.note",
      properties: { title: "to be binned", body: "going" },
    });
    expect(note.ok && binned.ok).toBe(true);
    if (!note.ok || !binned.ok) return;
    const id = note.value.item_id ?? "a";
    const binnedId = binned.value.item_id ?? "b";
    expect(
      (
        await device.update(id, {
          properties: { title: "edited before any answer" },
          version: 0,
        })
      ).ok,
    ).toBe(true);
    expect((await device.addTag(id, "favorite")).ok).toBe(true);
    expect((await device.deleteItem(binnedId)).ok).toBe(true);

    // The creates are answered and nothing after them is: every later door
    // fails the way an environment fails, so those writes are still
    // unanswered when the drain returns.
    acceptCreates(harness);
    scriptWrites(server, {
      update: [answers.serverFault()],
      tags: [answers.serverFault()],
    });
    server.answer("DELETE", /^\/items\/[^/]+$/, answers.serverFault());
    expect((await device.drain()).ok).toBe(true);

    const read = await device.get(id);
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    // The witness: the create's answer was adopted, so what follows is about
    // a row that took the server's fields and not one nothing touched.
    expect(
      read.value.version,
      "the create's answer was not adopted, so nothing here is about an answer laid over waiting writes",
    ).toBe(1);
    expect(
      read.value.properties.title,
      "the answer to the create erased the edit queued after it, so the copy shows the write as undone while the queue still sends it",
    ).toBe("edited before any answer");
    expect(
      read.value.tags,
      "the answer to the create erased the tag queued after it, and a tag's own answer carries no row to put it back",
    ).toEqual(["favorite"]);

    const listed = await device.list();
    expect(listed.ok).toBe(true);
    expect(
      listed.ok ? listed.value.map((item) => item.id) : [],
      "the answer to a create brought back a row the device had already put in the bin, and a delete's own answer carries no row to take it away again",
    ).not.toContain(binnedId);
    // The witness: the row is held, in the bin, so the absence above is the
    // waiting delete laid over it and not a row that went missing.
    const everything = await device.list({ allStates: true });
    expect(
      everything.ok
        ? everything.value.find((item) => item.id === binnedId)?.state
        : undefined,
    ).toBe("trashed");

    const waiting = (await queueOf(device)).filter(
      (row) => row.verdict === null,
    );
    expect(
      waiting.map((row) => row.kind).sort(),
      "the writes after the creates were not left waiting, so the absences above are not about unanswered writes",
    ).toEqual(["add_tag", "delete_item", "update_item"]);
  });

  it("moves the copy onto the row a create lands on, with every write waiting on it", async () => {
    const OTHER = { id: "01a00000-0000-7000-8000-00000000000b", version: 1 };
    harness = await hydratedHarness("queue-create-lands-on-held", {
      rows: {
        "core.note": [
          ...held()["core.note"],
          { item: { id: OTHER.id, version: OTHER.version } },
        ],
      },
    });
    const { device, server } = harness;
    // A create carrying the natural key of a row the server holds, and the
    // writes queued on the row it made here before it was answered.
    const created = await device.create({
      type: "core.note",
      properties: { title: "the same note", body: "b" },
      source: "notes",
      sourceId: "shared.md",
      version: HELD.version,
    });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const local = created.value.item_id ?? "";
    for (const queued of [
      await device.update(local, {
        properties: { title: "edited here" },
        version: 0,
      }),
      await device.addTag(local, "kept"),
      await device.createEdge({
        source: local,
        target: OTHER.id,
        type: "references",
      }),
    ]) {
      expect(queued.ok, JSON.stringify(queued)).toBe(true);
    }
    // The witness: every write was queued against the id minted here, so its
    // absence from the wire below is the move and not a write never queued.
    expect(
      (await queueOf(device)).filter((row) => row.item_id === local),
    ).toHaveLength(4);

    scriptWrites(server, {
      // The server resolves the pair onto the row it holds.
      create: [
        (request) => {
          const sent = JSON.parse(request.body) as {
            properties: Record<string, unknown>;
          };
          return answers.created(
            wireItem({
              id: HELD.id,
              version: HELD.version + 1,
              properties: sent.properties,
              source: "notes",
              source_id: "shared.md",
            }),
          );
        },
      ],
      update: [
        (request) => {
          const sent = JSON.parse(request.body) as {
            version: number;
            properties: Record<string, unknown>;
          };
          return answers.updated(
            wireItem({
              id: request.pathname.split("/").at(-1) ?? "",
              version: sent.version + 1,
              properties: sent.properties,
            }),
          );
        },
      ],
      tags: [{ kind: "json", status: 200, body: {} }],
      edges: [{ kind: "json", status: 201, body: {} }],
    });
    expect((await device.drain()).ok).toBe(true);

    const sent = server.requests.filter((request) => request.method !== "GET");
    expect(
      sent
        .filter(
          (request) =>
            request.pathname.includes(local) || request.body.includes(local),
        )
        .map((request) => `${request.method} ${request.pathname}`),
      "a write waiting on the create went to the id minted here, which the server never held",
    ).toEqual([]);
    const update = sent.find(
      (request) =>
        request.method === "PATCH" && request.pathname === `/items/${HELD.id}`,
    );
    expect(
      (JSON.parse(update?.body ?? "{}") as { version?: number }).version,
      "the edit was not sent on the version the create was answered with",
    ).toBe(HELD.version + 1);
    expect(
      sent.some(
        (request) =>
          request.method === "POST" &&
          request.pathname === `/items/${HELD.id}/tags`,
      ),
    ).toBe(true);
    expect(
      sent
        .filter((request) => request.pathname === "/edges")
        .map(
          (request) =>
            (JSON.parse(request.body) as { source_id?: string }).source_id,
        ),
    ).toEqual([HELD.id]);
    expect(
      (await device.get(local)).ok,
      "the row minted here is still held beside the one the server answered with, so the copy holds one note twice",
    ).toBe(false);
    expect((await device.get(HELD.id)).ok).toBe(true);
  });

  it("refuses a create whose natural key names a row, and moves the copy onto that row", async () => {
    // Another device's create landed under the same natural key after this
    // copy last read, so the create here, conditional on nothing being there,
    // is refused, and the envelope names the row that is (`versions.md` 10).
    const OTHER = { id: "01a00000-0000-7000-8000-00000000000b", version: 1 };
    const THEIRS = { id: "01a00000-0000-7000-8000-0000000000c1", version: 2 };
    harness = await hydratedHarness("queue-create-refused-onto-held", {
      rows: { "core.note": [{ item: { id: OTHER.id, version: 1 } }] },
    });
    const { device, server } = harness;
    const created = await device.create({
      type: "core.note",
      properties: { title: "mine", body: "mine" },
      source: "notes",
      sourceId: "raced.md",
      version: 0,
    });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const local = created.value.item_id ?? "";
    const edit = await device.update(local, {
      properties: { title: "mine, edited" },
      version: 0,
    });
    const tagged = await device.addTag(local, "kept");
    const linked = await device.createEdge({
      source: local,
      target: OTHER.id,
      type: "references",
    });
    for (const queued of [edit, tagged, linked]) {
      expect(queued.ok, JSON.stringify(queued)).toBe(true);
    }
    // The witness: the edit waits on the create, so its absence from the
    // wire below is the refusal and not a write that was never queued.
    expect(edit.ok && edit.value.depends_on).toEqual([created.value.id]);

    const theirs = {
      id: THEIRS.id,
      version: THEIRS.version,
      properties: { title: "theirs", body: "theirs" },
      source: "notes",
      source_id: "raced.md",
    };
    scriptWrites(server, {
      create: [
        answers.ancestorUnavailable(
          {
            id: THEIRS.id,
            version: THEIRS.version,
            properties: theirs.properties,
            tier: "library",
            occurred_at: "2026-01-01T00:00:00.000Z",
            source_id: "raced.md",
          },
          0,
        ),
      ],
      // The row read by the id the envelope named, to hold it.
      read: [answers.updated(wireItem(theirs))],
      update: [
        (request) =>
          answers.updated(
            wireItem({
              ...theirs,
              version:
                (JSON.parse(request.body) as { version: number }).version + 1,
              properties: { title: "edited after", body: "theirs" },
            }),
          ),
      ],
      tags: [{ kind: "json", status: 200, body: {} }],
      edges: [
        (request) => {
          const sent = JSON.parse(request.body) as {
            id: string;
            source_id: string;
            target_id: string;
          };
          return writeAnswers.edge(sent);
        },
      ],
    });
    const drained = await device.drain();
    expect(drained.ok, JSON.stringify(drained)).toBe(true);
    if (!drained.ok) return;

    const verdictOf = (id: string) =>
      drained.value.verdicts.find((entry) => entry.id === id);
    expect(
      [
        verdictOf(created.value.id)?.verdict,
        verdictOf(created.value.id)?.reason,
      ],
      "a create the server refused because the row it would make is there was held for a release that can only meet the same refusal",
    ).toEqual(["refused", "ancestor_unavailable"]);
    expect(
      verdictOf(created.value.id)?.item_id,
      "the drain reported the create against the id minted here, which names nothing",
    ).toBe(THEIRS.id);
    expect(
      verdictOf(edit.ok ? edit.value.id : "")?.verdict,
      "an edit based on the refused create was sent, over a row this device never read",
    ).toBe("refused");
    expect(
      verdictOf(tagged.ok ? tagged.value.id : "")?.verdict,
      "the tag waited on a create that will never land, although the row it names exists",
    ).toBe("accepted");
    expect(verdictOf(linked.ok ? linked.value.id : "")?.verdict).toBe(
      "accepted",
    );

    const sent = server.requests.filter((request) => request.method !== "GET");
    expect(
      sent
        .filter(
          (request) =>
            request.pathname.includes(local) || request.body.includes(local),
        )
        .map((request) => `${request.method} ${request.pathname}`),
      "a write went to the id minted here, which the server never held",
    ).toEqual([]);
    expect(
      sent.filter((request) => request.method === "PATCH"),
      "the edit based on the refused create went out",
    ).toEqual([]);
    expect(
      sent.map((request) => `${request.method} ${request.pathname}`),
    ).toEqual(["POST /items", `POST /items/${THEIRS.id}/tags`, "POST /edges"]);

    // One item, the server's, as the server holds it.
    expect(
      (await device.get(local)).ok,
      "the row minted here is still held beside the one the server named, so the copy holds one note twice",
    ).toBe(false);
    const holding = await device.get(THEIRS.id);
    expect(holding.ok, JSON.stringify(holding)).toBe(true);
    if (!holding.ok) return;
    expect(holding.value.version).toBe(THEIRS.version);
    expect(holding.value.properties.title).toBe("theirs");

    // And a write after it does not wait on the refused create: it is sent,
    // on the version the copy holds.
    const later = await device.update(THEIRS.id, {
      properties: { title: "edited after" },
      version: THEIRS.version,
    });
    expect(later.ok, JSON.stringify(later)).toBe(true);
    if (!later.ok) return;
    expect(later.value.depends_on).toEqual([]);
    expect((await device.drain()).ok).toBe(true);
    const patch = server.requests.find(
      (request) =>
        request.method === "PATCH" &&
        request.pathname === `/items/${THEIRS.id}`,
    );
    expect(
      (JSON.parse(patch?.body ?? "{}") as { version?: number }).version,
    ).toBe(THEIRS.version);
  });

  it("blocks a create whose natural key names a row it cannot read", async () => {
    // The envelope names a row that is gone by the time the device reads it,
    // so there is nothing to move onto, and the create stops as any write
    // refused this way does (`queue-and-verdicts.md` 22).
    const GONE = "01a00000-0000-7000-8000-0000000000c9";
    harness = await hydratedHarness("queue-create-refused-onto-gone", {
      rows: held(),
    });
    const { device, server } = harness;
    const created = await device.create({
      type: "core.note",
      properties: { title: "mine", body: "mine" },
      source: "notes",
      sourceId: "gone.md",
      version: 0,
    });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const local = created.value.item_id ?? "";
    scriptWrites(server, {
      create: [
        answers.ancestorUnavailable(
          {
            id: GONE,
            version: 1,
            properties: { title: "gone" },
            tier: "library",
            occurred_at: "2026-01-01T00:00:00.000Z",
            source_id: "gone.md",
          },
          0,
        ),
      ],
      read: [refusal(404, "item_not_found", "Item not found")],
    });
    const drained = await device.drain();
    expect(drained.ok, JSON.stringify(drained)).toBe(true);
    if (!drained.ok) return;
    // The witness: the device did go to read the row it would have moved onto.
    expect(
      server.requests.some(
        (request) =>
          request.method === "GET" && request.pathname === `/items/${GONE}`,
      ),
    ).toBe(true);
    const [verdict] = drained.value.verdicts;
    expect(
      [verdict?.verdict, verdict?.reason],
      "a create was refused onto a row the device could not hold, leaving its copy holding nothing under the key",
    ).toEqual(["blocked", "ancestor_unavailable"]);
    expect((await device.get(local)).ok).toBe(true);
  });

  it("sends a create carrying a natural key without the id it minted, and holds the row the answer names", async () => {
    harness = await hydratedHarness("queue-keyed-create-id", { rows: held() });
    const { device, server } = harness;
    const keyed = await device.create({
      type: "core.note",
      properties: { title: "keyed", body: "keyed" },
      source: "notes",
      sourceId: "fresh.md",
    });
    const plain = await device.create({
      type: "core.note",
      properties: { title: "plain", body: "plain" },
    });
    expect(keyed.ok && plain.ok).toBe(true);
    if (!keyed.ok || !plain.ok) return;
    const local = keyed.value.item_id ?? "";
    expect(
      (
        await device.update(local, {
          properties: { title: "keyed, edited" },
          version: 0,
        })
      ).ok,
    ).toBe(true);

    // The server's rules: a create naming an id is written under it, and one
    // naming none is given an id the server mints.
    const minted = "01a00000-0000-7000-8000-0000000000f1";
    scriptWrites(server, {
      create: [
        (request) => {
          const sent = JSON.parse(request.body) as {
            id?: string;
            properties: Record<string, unknown>;
            source?: string;
            source_id?: string;
          };
          return answers.created(
            wireItem({
              id: sent.id ?? minted,
              properties: sent.properties,
              ...(sent.source === undefined ? {} : { source: sent.source }),
              source_id: sent.source_id ?? null,
            }),
          );
        },
      ],
      update: [
        (request) => {
          const sent = JSON.parse(request.body) as {
            version: number;
            properties: Record<string, unknown>;
          };
          return answers.updated(
            wireItem({
              id: request.pathname.split("/").at(-1) ?? "",
              version: sent.version + 1,
              properties: sent.properties,
              source: "notes",
              source_id: "fresh.md",
            }),
          );
        },
      ],
    });
    const drained = await device.drain();
    expect(drained.ok, JSON.stringify(drained)).toBe(true);
    if (!drained.ok) return;
    expect(
      drained.value.verdicts.find((entry) => entry.kind === "create_item")
        ?.item_id,
      "the drain reported the keyed create under the id minted here, which names nothing once the copy has moved",
    ).toBe(minted);

    const bodies = server.requests
      .filter(
        (request) => request.method === "POST" && request.pathname === "/items",
      )
      .map((request) => JSON.parse(request.body) as Record<string, unknown>);
    const keyedBody = bodies.find((body) => body.source_id === "fresh.md");
    expect(keyedBody, "the keyed create was never sent").toBeDefined();
    expect(
      "id" in (keyedBody ?? {}),
      "a create carrying a natural key named the id minted here, which the server refuses wherever that key already names a row",
    ).toBe(false);
    // The witness: a create with no natural key still names the id minted
    // here, so the absence above is about the key.
    expect(
      bodies.find((body) => body.source_id === undefined)?.id,
      "a create with no natural key did not carry the id minted here",
    ).toBe(plain.value.item_id);

    expect(
      (await device.get(local)).ok,
      "the copy still holds the row under the id minted here, which the server never had",
    ).toBe(false);
    const landed = await device.get(minted);
    expect(
      landed.ok,
      "the copy does not hold the row under the id the server answered with",
    ).toBe(true);
    const edit = server.requests.find((request) => request.method === "PATCH");
    expect(
      edit?.pathname,
      "the edit waiting on the create went to the id minted here",
    ).toBe(`/items/${minted}`);
    expect(
      (JSON.parse(edit?.body ?? "{}") as { version?: number }).version,
    ).toBe(1);
  });

  it("sends an edit of its own unanswered create based on the version that create was answered with", async () => {
    harness = await hydratedHarness("queue-rebase-own-create", {
      rows: held(),
    });
    const { device, server } = harness;
    const note = await device.create({
      type: "core.note",
      properties: { title: "made here", body: "the body" },
    });
    expect(note.ok).toBe(true);
    if (!note.ok) return;
    const id = note.value.item_id ?? "a";
    expect(
      (
        await device.update(id, {
          properties: { title: "edited here" },
          version: 0,
        })
      ).ok,
    ).toBe(true);
    // The control: an edit based on a version the server issued.
    expect(
      (
        await device.update(HELD.id, {
          properties: { title: "held, edited" },
          version: HELD.version,
        })
      ).ok,
    ).toBe(true);

    acceptCreates(harness);
    scriptWrites(server, {
      update: [
        (request) => {
          const sent = JSON.parse(request.body) as {
            version: number;
            properties: Record<string, unknown>;
          };
          const target = request.pathname.split("/").at(-1) ?? "";
          return answers.updated(
            wireItem({
              id: target,
              version: sent.version + 1,
              properties: sent.properties,
            }),
          );
        },
      ],
    });
    const drained = await device.drain();
    expect(drained.ok).toBe(true);

    const sentVersion = (target: string): unknown =>
      (
        JSON.parse(
          server.requests.find(
            (request) =>
              request.method === "PATCH" &&
              request.pathname === `/items/${target}`,
          )?.body ?? "{}",
        ) as { version?: unknown }
      ).version;
    expect(
      sentVersion(id),
      "an edit of the device's own create went out based on the placeholder the copy held, a version the server never mints and holds no snapshot of, so it is blocked though everything it was based on was the device's own",
    ).toBe(1);
    expect(
      sentVersion(HELD.id),
      "an edit based on a version the server issued was sent on some other version",
    ).toBe(HELD.version);
  });

  it("sends an edit of its own unanswered edge based on the version that edge was answered with", async () => {
    harness = await hydratedHarness("queue-rebase-own-edge", { rows: held() });
    const { device, server } = harness;
    const note = await device.create({
      type: "core.note",
      properties: { title: "the other end", body: "the other end" },
    });
    expect(note.ok).toBe(true);
    if (!note.ok) return;
    const target = note.value.item_id ?? "a";
    const link = await device.createEdge({
      source: HELD.id,
      target,
      type: "references",
    });
    expect(link.ok).toBe(true);
    if (!link.ok) return;
    const edgeId = link.value.edge_id ?? "e";
    expect(
      (
        await device.updateEdge(edgeId, {
          properties: { weight: 2 },
          version: 0,
        })
      ).ok,
    ).toBe(true);

    acceptCreates(harness);
    scriptWrites(server, {
      edges: [
        writeAnswers.edge({
          id: edgeId,
          source_id: HELD.id,
          target_id: target,
          version: 1,
        }),
        writeAnswers.edge({
          id: edgeId,
          source_id: HELD.id,
          target_id: target,
          version: 2,
          properties: { weight: 2 },
        }),
      ],
    });
    expect((await device.drain()).ok).toBe(true);

    const patch = server.requests.find(
      (request) =>
        request.method === "PATCH" && request.pathname === `/edges/${edgeId}`,
    );
    expect(
      patch,
      "the edit of the device's own edge was never sent, so nothing below is about the version it went on",
    ).toBeDefined();
    expect(
      (JSON.parse(patch?.body ?? "{}") as { version?: unknown }).version,
      "an edit of the device's own edge went out based on the placeholder the copy held, a version the server never mints",
    ).toBe(1);
  });

  it("keeps a waiting write through the reconcile of a refused one", async () => {
    harness = await hydratedHarness("queue-overlay-reconcile", {
      rows: held(),
    });
    const { device, server } = harness;
    expect((await device.addTag(HELD.id, "refused-here")).ok).toBe(true);
    expect(
      (
        await device.update(HELD.id, {
          properties: { title: "edited, waiting" },
          version: HELD.version,
        })
      ).ok,
    ).toBe(true);
    scriptWrites(server, {
      tags: [refusal(400, "validation_error", "not a tag this server takes")],
      update: [answers.serverFault()],
      read: [
        answers.updated(
          wireItem({
            id: HELD.id,
            version: HELD.version,
            properties: { title: "held", body: "held" },
          }),
        ),
      ],
    });
    expect((await device.drain()).ok).toBe(true);

    const read = await device.get(HELD.id);
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    // The witness: the refusal was reconciled, so the row took the server's
    // copy and lost the refused tag.
    expect(
      read.value.tags,
      "the refused tag was not reconciled away, so nothing here is about a reconcile",
    ).not.toContain("refused-here");
    expect(
      read.value.properties.title,
      "the reconcile of a refused write erased an edit still waiting behind it",
    ).toBe("edited, waiting");
  });

  it("keeps a waiting edge edit through the answer to the edge's create", async () => {
    harness = await hydratedHarness("queue-overlay-edge-answer", {
      rows: held(),
    });
    const { device, server } = harness;
    const note = await device.create({
      type: "core.note",
      properties: { title: "the other end", body: "the other end" },
    });
    expect(note.ok).toBe(true);
    if (!note.ok) return;
    const target = note.value.item_id ?? "a";
    const link = await device.createEdge({
      source: HELD.id,
      target,
      type: "references",
    });
    expect(link.ok).toBe(true);
    if (!link.ok) return;
    const edgeId = link.value.edge_id ?? "e";
    expect(
      (
        await device.updateEdge(edgeId, {
          properties: { weight: 2 },
          version: 0,
        })
      ).ok,
    ).toBe(true);

    acceptCreates(harness);
    server.answer("POST", "/edges", {
      kind: "json",
      status: 201,
      body: { edge: edgeRow(edgeId, HELD.id, target, 1) },
    });
    server.answer("PATCH", /^\/edges\/[^/]+$/, answers.serverFault());
    expect((await device.drain()).ok).toBe(true);

    const edges = await device.edgesFrom(HELD.id);
    expect(edges.ok).toBe(true);
    if (!edges.ok) return;
    const edge = edges.value.find((held) => held.id === edgeId);
    // The witness: the create's answer was adopted.
    expect(
      edge?.version,
      "the edge's answer was not adopted, so nothing here is about laying an edit over it",
    ).toBe(1);
    expect(
      edge?.properties.weight,
      "the answer to the edge's create erased the edit still waiting on it",
    ).toBe(2);
  });

  it("keeps a blocked write through a re-hydration", async () => {
    harness = await hydratedHarness("queue-overlay-rehydrate-blocked", {
      rows: held(),
    });
    const { device, server } = harness;
    const note = await device.create({
      type: "core.note",
      properties: { title: "made, then blocked", body: "blocked" },
    });
    expect(note.ok).toBe(true);
    if (!note.ok) return;
    scriptWrites(server, { create: [answers.unauthorized()] });
    expect((await device.drain()).ok).toBe(true);
    const queued = await queueOf(device);
    expect(
      queued.map((row) => [row.verdict, row.reason]),
      "the create was not blocked, so nothing here is about a blocked write",
    ).toEqual([["blocked", "credential_refused"]]);

    expect((await device.hydrate(["core.note"], "library")).ok).toBe(true);
    const own = await device.get(note.value.item_id ?? "a");
    expect(
      own.ok,
      "a re-hydration dropped a create that is blocked and waiting for a release",
    ).toBe(true);
  });

  it("keeps the writes it has not had answered through a re-hydration", async () => {
    const rows = held();
    harness = await hydratedHarness("queue-overlay-rehydrate", { rows });
    const { device } = harness;
    const note = await device.create({
      type: "core.note",
      properties: { title: "made here", body: "made here" },
    });
    expect(note.ok).toBe(true);
    if (!note.ok) return;
    const made = note.value.item_id ?? "a";
    expect(
      (
        await device.update(HELD.id, {
          properties: { title: "edited here" },
          version: HELD.version,
        })
      ).ok,
    ).toBe(true);
    expect((await device.addTag(HELD.id, "favorite")).ok).toBe(true);
    const link = await device.createEdge({
      source: HELD.id,
      target: made,
      type: "references",
    });
    expect(link.ok).toBe(true);
    if (!link.ok) return;
    const edgeId = link.value.edge_id ?? "e";
    expect(
      (
        await device.updateEdge(edgeId, {
          properties: { weight: 4 },
          version: 0,
        })
      ).ok,
    ).toBe(true);

    // The server has since moved the held row on elsewhere, and nothing the
    // hydration pulls answers any of the writes above.
    rows["core.note"] = [
      {
        item: {
          id: HELD.id,
          version: HELD.version + 1,
          properties: { title: "held", body: "changed elsewhere" },
        },
      },
    ];
    expect((await device.hydrate(["core.note"], "library")).ok).toBe(true);

    const read = await device.get(HELD.id);
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    // The witness: the hydration took the server's row, so what follows is
    // about writes laid over a refilled copy and not a copy nothing touched.
    expect(
      read.value.properties.body,
      "the re-hydration did not take the server's row, so nothing here is about a refilled copy",
    ).toBe("changed elsewhere");
    expect(read.value.version).toBe(HELD.version + 1);
    expect(
      read.value.properties.title,
      "the re-hydration erased an edit still in the queue, so the copy shows the write as undone while the queue still sends it",
    ).toBe("edited here");
    expect(
      read.value.tags,
      "the re-hydration erased a tag still in the queue, and its answer carries no row to put it back",
    ).toEqual(["favorite"]);

    const own = await device.get(made);
    expect(
      own.ok,
      "the re-hydration dropped a row the device created and has not had answered, so a caller told the write was queued can no longer read it",
    ).toBe(true);
    if (!own.ok) return;
    expect(own.value.properties.title).toBe("made here");
    const queued = await queueOf(device);
    expect(
      own.value.created_at,
      "the row held again after the re-hydration took the hydration's time rather than the time it was made",
    ).toBe(
      queued.find((row) => row.item_id === made && row.kind === "create_item")
        ?.queued_at,
    );
    const edges = await device.edgesFrom(HELD.id);
    expect(edges.ok).toBe(true);
    const edge = edges.ok
      ? edges.value.find((held) => held.id === edgeId)
      : undefined;
    expect(
      edge,
      "the re-hydration dropped an edge the device created and has not had answered",
    ).toBeDefined();
    expect(
      edge?.properties.weight,
      "the re-hydration erased an edit still waiting on the device's own edge",
    ).toBe(4);
    expect(
      queued.filter((row) => row.verdict === null).length,
      "the writes this case lays over the refilled copy were not left waiting",
    ).toBe(5);
  });
});

/**
 * The reads a refusal by dependency reconciles against: the server holds no
 * item the device made and never sent, and no edge from it.
 */
function holdsNoneOfIt(harnessUnderTest: Harness): void {
  harnessUnderTest.server.answer(
    "GET",
    /^\/items\/[^/]+$/,
    refusal(404, "item_not_found", "no such item"),
  );
  harnessUnderTest.server.answer("GET", /^\/items\/[^/]+\/edges$/, {
    kind: "json",
    status: 200,
    body: { data: [], next_cursor: null },
  });
}

describe("an upload is a queued write", () => {
  /** An answer to `POST /blobs` naming what it was sent, or `named`. */
  function uploaded(named?: string): Responder {
    return (request) =>
      writeAnswers.uploaded(
        named ?? hashOf(request.raw),
        request.headers["content-type"] ?? "",
        request.raw.length,
      );
  }

  it("queues an upload and sends its bytes when it drains", async () => {
    harness = await hydratedHarness("upload-queued", { rows: held() });
    const { device, server } = harness;
    const bytes = Buffer.from("a note, as bytes\n");
    const file = fileOf("note.txt", bytes);
    const queued = await device.putBlob(file, "text/plain");
    expect(
      queued.ok,
      `the device could not queue an upload: ${JSON.stringify(queued)}`,
    ).toBe(true);
    if (!queued.ok) return;
    expect(queued.value.kind).toBe("upload_blob");
    expect(
      queued.value.blob,
      "the upload does not name the bytes it carries, so nothing can ask what is outstanding for them",
    ).toBe(hashOf(bytes));
    expect(queued.value.verdict).toBeNull();
    // An empty file is refused where it is asked for, since the server holds
    // no empty blob; the upload above is the witness that files are taken.
    const empty = await device.putBlob(fileOf("empty.txt", ""));
    expect(
      empty.ok,
      "an empty file was queued as an upload the server will refuse",
    ).toBe(false);
    expect((await queueOf(device)).map((row) => row.kind)).toEqual([
      "upload_blob",
    ]);

    // The bytes were held when the upload was queued: the file the person
    // named is gone before the drain, and the upload still sends them.
    rmSync(file);
    acceptUploads(harness.server);
    const drained = await device.drain();
    expect(drained.ok).toBe(true);
    if (!drained.ok) return;
    expect(
      drained.value.verdicts[0]?.verdict,
      `the upload was not answered: ${JSON.stringify(drained.value)}`,
    ).toBe("accepted");
    const sent = server.requests.find(
      (request) => request.method === "POST" && request.pathname === "/blobs",
    );
    expect(
      sent?.raw,
      "the upload did not send the bytes it was queued with",
    ).toEqual(bytes);
    expect(sent?.headers["content-type"]).toBe("text/plain");
    expect(
      sent?.headers.authorization,
      "the upload went without the credential, so the server refuses every one",
    ).toBe(`Bearer ${KEY}`);
  });

  it("attaches a file as an upload, a file item and an edge, each waiting on the one before", async () => {
    harness = await hydratedHarness("upload-attach", { rows: held() });
    const { device, server } = harness;
    const bytes = Buffer.from("%PDF-1.7 a scan\n");
    const attached = await device.attach(HELD.id, fileOf("scan.pdf", bytes));
    expect(
      attached.ok,
      `the device could not attach a file: ${JSON.stringify(attached)}`,
    ).toBe(true);
    if (!attached.ok) return;
    const [upload, item, edge] = attached.value;
    expect(attached.value.map((row) => row.kind)).toEqual([
      "upload_blob",
      "create_item",
      "create_edge",
    ]);
    expect(
      item?.depends_on,
      "the file item does not wait on its upload, so it can reach the server naming bytes the server has never been sent",
    ).toEqual([upload?.id]);
    expect(
      edge?.depends_on,
      "the edge does not wait on the file item, so it can link a row the server does not hold",
    ).toContain(item?.id);

    const file = await device.get(item?.item_id ?? "");
    expect(file.ok).toBe(true);
    if (!file.ok) return;
    expect(file.value.type).toBe("core.file");
    expect(file.value.properties).toMatchObject({
      blob_ref: hashOf(bytes),
      mime_type: "application/pdf",
      title: "scan.pdf",
    });

    acceptUploads(harness.server);
    scriptWrites(server, {
      create: [
        (request) => {
          const sent = JSON.parse(request.body) as {
            id: string;
            type: string;
            properties: Record<string, unknown>;
          };
          return answers.created(
            wireItem({
              id: sent.id,
              type: sent.type,
              version: 1,
              properties: sent.properties,
            }),
          );
        },
      ],
      edges: [
        (request) => {
          const sent = JSON.parse(request.body) as {
            id: string;
            source_id: string;
            target_id: string;
            edge_type: string;
          };
          return writeAnswers.edge(sent);
        },
      ],
    });
    const drained = await device.drain();
    expect(drained.ok).toBe(true);
    if (!drained.ok) return;
    expect(
      drained.value.verdicts.map((entry) => entry.verdict),
      `the three writes were not each answered: ${JSON.stringify(drained.value)}`,
    ).toEqual(["accepted", "accepted", "accepted"]);
    const order = server.requests
      .filter((request) => request.method === "POST")
      .map((request) => request.pathname);
    expect(
      order,
      "the writes went out of order, so the server met a file item naming bytes it did not hold, or an edge to a row it did not hold",
    ).toEqual(["/blobs", "/items", "/edges"]);
    const link = JSON.parse(
      server.requests.find((request) => request.pathname === "/edges")?.body ??
        "{}",
    ) as Record<string, unknown>;
    expect(link).toMatchObject({
      source_id: item?.item_id,
      target_id: HELD.id,
      edge_type: "attached-to",
    });
  });

  it("refuses an upload whose bytes are no longer held", async () => {
    harness = await hydratedHarness("upload-gone", { rows: held() });
    const { device, server } = harness;
    const gone = Buffer.from("taken away before the drain\n");
    const kept = Buffer.from("still held\n");
    // Attached, so a file item and an edge wait on the upload that cannot go.
    expect((await device.attach(HELD.id, fileOf("gone.txt", gone))).ok).toBe(
      true,
    );
    expect((await device.putBlob(fileOf("kept.txt", kept))).ok).toBe(true);

    // Beside the store, in the folder named for it (`device.md` 38).
    const heldAt = `${device.store}.blobs/${hashOf(gone).slice("sha256:".length)}`;
    expect(
      existsSync(heldAt),
      "the bytes are not held beside the store, so nothing here is about bytes that went missing from there",
    ).toBe(true);
    rmSync(heldAt);

    acceptUploads(harness.server);
    holdsNoneOfIt(harness);
    const drained = await device.drain();
    expect(drained.ok).toBe(true);
    if (!drained.ok) return;
    const [missing, fileItem, link, present] = drained.value.verdicts;
    expect(
      missing?.verdict,
      "an upload whose bytes are gone was not refused, so it waits forever on bytes nothing can send",
    ).toBe("refused");
    expect(missing?.reason).toContain(hashOf(gone));
    expect(
      [fileItem?.verdict, link?.verdict],
      "what waits on an upload that can never be sent was left waiting rather than refused in the same drain",
    ).toEqual(["refused", "refused"]);
    // The witness: an upload whose bytes are held goes out in the same
    // drain, so the refusal is the missing bytes and not the door.
    expect(present?.verdict).toBe("accepted");
    expect(
      server.requests.filter((request) => request.pathname === "/blobs"),
      "an upload with nothing to send reached the server",
    ).toHaveLength(1);
  });

  it("leaves an upload whose held bytes cannot be opened unanswered, and says why", async () => {
    harness = await hydratedHarness("upload-unopened", { rows: held() });
    const { device, server } = harness;
    const bytes = Buffer.from("held and locked for now\n");
    expect((await device.putBlob(fileOf("locked.txt", bytes))).ok).toBe(true);
    const heldAt = `${device.store}.blobs/${hashOf(bytes).slice("sha256:".length)}`;
    chmodSync(heldAt, 0o000);
    acceptUploads(server);
    try {
      const drained = await device.drain();
      expect(drained.ok).toBe(true);
      if (!drained.ok) return;
      expect(
        drained.value.verdicts[0]?.verdict,
        "bytes held but not opened for now were refused for good, and the file item waiting on them with them",
      ).toBeNull();
      expect(drained.value.verdicts[0]?.reason).toContain(
        "could not be opened",
      );
      expect(drained.value.verdicts[0]?.refusals).toBe(0);
    } finally {
      chmodSync(heldAt, 0o644);
    }
    // The witness: the same upload goes once the bytes can be opened.
    const again = await device.drain();
    expect(again.ok).toBe(true);
    if (!again.ok) return;
    expect(again.value.verdicts[0]?.verdict).toBe("accepted");
  });

  it("refuses an attachment whose upload the server refuses, and what waits on it", async () => {
    harness = await hydratedHarness("upload-refused", { rows: held() });
    const { device, server } = harness;
    expect(
      (await device.attach(HELD.id, fileOf("refused.txt", "refused bytes\n")))
        .ok,
    ).toBe(true);
    server.answer(
      "POST",
      "/blobs",
      refusal(400, "validation_error", "Empty blob"),
    );
    holdsNoneOfIt(harness);
    const drained = await device.drain();
    expect(drained.ok).toBe(true);
    if (!drained.ok) return;
    expect(
      drained.value.verdicts.map((entry) => [entry.kind, entry.verdict]),
    ).toEqual([
      ["upload_blob", "refused"],
      ["create_item", "refused"],
      ["create_edge", "refused"],
    ]);
    expect(
      drained.value.verdicts[0]?.reason,
      "the upload's refusal did not carry the server's code",
    ).toBe("validation_error");
    expect(
      server.requests
        .filter((request) => request.method === "POST")
        .map((request) => request.pathname),
      "a file item or an edge waiting on a refused upload was sent",
    ).toEqual(["/blobs"]);
  });

  it("attaches under the title, type and tier it is given", async () => {
    harness = await hydratedHarness("upload-attach-options", {
      rows: held(),
    });
    const { device } = harness;
    const attached = await device.attach(
      HELD.id,
      fileOf("lease.png", Buffer.from([0x89, 0x50, 0x4e, 0x47, 1])),
      { title: "Lease, scanned", type: "core.file", tier: "feed" },
    );
    expect(attached.ok).toBe(true);
    if (!attached.ok) return;
    const file = await device.get(attached.value[1]?.item_id ?? "");
    expect(file.ok).toBe(true);
    if (!file.ok) return;
    expect(
      [file.value.type, file.value.properties.title, file.value.tier],
      "an attachment dropped the title, type or tier it was given",
    ).toEqual(["core.file", "Lease, scanned", "feed"]);
    // The witness: with nothing given, the same file would be an image
    // named for itself, so each value above is the one asked for.
    expect(file.value.properties.mime_type).toBe("image/png");
  });

  it("attaches only to an item the copy holds outside the bin", async () => {
    harness = await hydratedHarness("upload-attach-target", {
      rows: held(),
    });
    const { device } = harness;
    const file = fileOf("note.txt", "attached\n");
    const absent = await device.attach("no-such-item", file);
    expect(
      absent.ok,
      "a file was attached to an item the copy does not hold",
    ).toBe(false);
    if (!absent.ok) expect(absent.refusal.code).toBe("not_found");
    // The witness: the same file attaches to the held item.
    expect((await device.attach(HELD.id, file)).ok).toBe(true);
    expect((await device.deleteItem(HELD.id)).ok).toBe(true);
    const binned = await device.attach(HELD.id, file);
    expect(
      binned.ok,
      "a file was attached to an item in the bin, which reads as absent",
    ).toBe(false);
    if (!binned.ok) expect(binned.refusal.code).toBe("not_found");
    expect(
      (await queueOf(device)).map((row) => row.kind),
      "a refused attachment queued something",
    ).toEqual(["upload_blob", "create_item", "create_edge", "delete_item"]);
  });

  it("counts an upload whose answer names other bytes", async () => {
    harness = await hydratedHarness("upload-misnamed", { rows: held() });
    const { device } = harness;
    const bytes = Buffer.from("named one way\n");
    expect((await device.putBlob(fileOf("note.txt", bytes))).ok).toBe(true);

    harness.server.answer(
      "POST",
      "/blobs",
      uploaded(`sha256:${"b".repeat(64)}`),
      // A success that names nothing at all is no more readable.
      (request) => ({
        kind: "json",
        status: 201,
        body: {
          mime_type: request.headers["content-type"] ?? "",
          size_bytes: request.raw.length,
        },
      }),
      uploaded(),
    );
    const drained = await device.drain();
    expect(drained.ok).toBe(true);
    if (!drained.ok) return;
    expect(
      drained.value.verdicts[0]?.verdict,
      "an upload answered under another name was accepted, so a file item naming the queued bytes would name nothing the server holds",
    ).toBeNull();
    expect(drained.value.verdicts[0]?.refusals).toBe(1);
    const unnamed = await device.drain();
    expect(unnamed.ok).toBe(true);
    if (!unnamed.ok) return;
    expect(
      unnamed.value.verdicts[0]?.verdict,
      "an upload answered with no name was accepted",
    ).toBeNull();
    expect(unnamed.value.verdicts[0]?.refusals).toBe(2);

    // The witness: the same upload, answered under its own name, is
    // accepted, so the counts above are the name and not the door.
    const again = await device.drain();
    expect(again.ok).toBe(true);
    if (!again.ok) return;
    expect(again.value.verdicts[0]?.verdict).toBe("accepted");
  });
});
