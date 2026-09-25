import { describe, it, expect, afterEach } from "vitest";
import { FolderDoor, type DoorCreate } from "../../device/folder-door.js";
import {
  SERVED_SOURCE,
  answers,
  edgeEvent,
  itemEvent,
  refusal,
  replay,
  wireEdge,
  wireItem,
  writeAnswers,
} from "../../device/marfa-answers.js";
import type {
  DeviceUnderTest,
  DrainReport,
  QueuedWrite,
} from "../../device/protocol.js";
import type { Answer, Responder } from "../../device/scripted-server.js";
import { chmodSync, existsSync, readFileSync, rmSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import {
  KEY,
  acceptUploads,
  fileOf,
  hashOf,
  hydratedHarness,
  scriptHydration,
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

    // Waiting as statement 35 means it: unanswered, or held behind a write
    // ahead of it that is.
    const waiting = (await queueOf(device)).filter(
      (row) => row.verdict === null || row.verdict === "blocked",
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
    // The queue keeps the reason the drain reported (`queue-and-verdicts.md`
    // 12), which is what a caller reads after the pass.
    const kept = (await queueOf(device)).find(
      (row) => row.id === created.value.id,
    );
    expect([kept?.verdict, kept?.reason]).toEqual([
      "refused",
      "ancestor_unavailable",
    ]);

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
    // refused this way does (`queue-and-verdicts.md` 22, 23): on each of the
    // two refusals a create's natural key can meet.
    const GONE = "01a00000-0000-7000-8000-0000000000c9";
    const current = {
      id: GONE,
      version: 2,
      properties: { title: "gone" },
      tier: "library" as const,
      occurred_at: "2026-01-01T00:00:00.000Z",
      source_id: "gone.md",
    };
    for (const [label, refused, reason, read] of [
      [
        "unread",
        answers.ancestorUnavailable(current, 0),
        "ancestor_unavailable",
        refusal(404, "item_not_found", "Item not found"),
      ],
      // Out of this credential's reach: a read the server refuses `403` is
      // not one to ask again on every pass.
      [
        "unreadable",
        answers.ancestorUnavailable(current, 0),
        "ancestor_unavailable",
        refusal(403, "type_not_permitted", "No access to this type"),
      ],
      [
        "stale",
        answers.versionConflict(
          current,
          { ...current, version: 1 },
          ["title"],
          { fields: {}, default: "last_writer_wins" },
        ),
        "conflict_unresolved",
        refusal(404, "item_not_found", "Item not found"),
      ],
    ] as const) {
      const own = await hydratedHarness(
        `queue-create-refused-onto-gone-${label}`,
        {
          rows: held(),
        },
      );
      try {
        const created = await own.device.create({
          type: "core.note",
          properties: { title: "mine", body: "mine" },
          source: "notes",
          sourceId: "gone.md",
          version: 0,
        });
        expect(created.ok).toBe(true);
        if (!created.ok) return;
        const local = created.value.item_id ?? "";
        scriptWrites(own.server, {
          create: [refused],
          read: [read],
        });
        const drained = await own.device.drain();
        expect(drained.ok, JSON.stringify(drained)).toBe(true);
        if (!drained.ok) return;
        // The witness: the device did go to read the row it would have
        // moved onto.
        expect(
          own.server.requests.some(
            (request) =>
              request.method === "GET" && request.pathname === `/items/${GONE}`,
          ),
        ).toBe(true);
        const [verdict] = drained.value.verdicts;
        expect(
          [verdict?.verdict, verdict?.reason],
          "a create was refused onto a row the device could not hold, leaving its copy holding nothing under the key",
        ).toEqual(["blocked", reason]);
        expect((await own.device.get(local)).ok).toBe(true);
      } finally {
        await own.stop();
      }
    }
  });

  it("reads the row a create landed on again after a failure that clears on its own", async () => {
    // The read that holds the landed row fails for a reason no write caused:
    // the create is left unanswered and uncounted, and the next drain, which
    // the server answers the same way, reads again. A refused credential is
    // the exception that stops everything, as it does anywhere.
    const THEIRS = "01a00000-0000-7000-8000-0000000000c8";
    const current = {
      id: THEIRS,
      version: 1,
      properties: { title: "theirs", body: "theirs" },
      tier: "library" as const,
      occurred_at: "2026-01-01T00:00:00.000Z",
      source_id: "raced.md",
    };
    const theirs = answers.updated(
      wireItem({
        id: THEIRS,
        version: 1,
        properties: current.properties,
        source: "notes",
        source_id: "raced.md",
      }),
    );
    harness = await hydratedHarness("queue-landed-read-retries", {
      rows: held(),
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
    scriptWrites(server, {
      // First an answer the device cannot read, which is counted, so the
      // count below is one that moves on this row.
      create: [
        { kind: "json", status: 200, body: "not an answer" },
        answers.ancestorUnavailable(current, 0),
      ],
      read: [
        { kind: "drop" },
        answers.serverFault(),
        answers.rateLimited(),
        theirs,
      ],
    });
    const counted = await device.drain();
    expect(counted.ok, JSON.stringify(counted)).toBe(true);
    if (!counted.ok) return;
    expect(
      [counted.value.verdicts[0]?.verdict, counted.value.verdicts[0]?.refusals],
      "an answer the device could not read was not counted, so a count that stays put below says nothing",
    ).toEqual([null, 1]);
    const reads = () =>
      server.requests.filter(
        (request) =>
          request.method === "GET" && request.pathname === `/items/${THEIRS}`,
      ).length;
    for (const [attempt, waited] of [
      ["a dropped connection", null],
      ["a 503", null],
      ["a 429", 2],
    ] as const) {
      const drained = await device.drain();
      expect(drained.ok, JSON.stringify(drained)).toBe(true);
      if (!drained.ok) return;
      expect(
        [
          drained.value.verdicts[0]?.verdict,
          drained.value.verdicts[0]?.refusals,
        ],
        `the create was settled or counted on ${attempt} while reading the row it landed on, although that clears on its own`,
      ).toEqual([null, 1]);
      expect(drained.value.retry_after_seconds).toBe(waited);
    }
    expect(reads()).toBe(3);
    const landed = await device.drain();
    expect(landed.ok, JSON.stringify(landed)).toBe(true);
    if (!landed.ok) return;
    expect([
      landed.value.verdicts[0]?.verdict,
      landed.value.verdicts[0]?.item_id,
    ]).toEqual(["refused", THEIRS]);
    expect((await device.get(THEIRS)).ok).toBe(true);
  });

  it("blocks the whole queue when the read of a landed row meets a refused credential", async () => {
    const THEIRS = "01a00000-0000-7000-8000-0000000000c8";
    const current = {
      id: THEIRS,
      version: 1,
      properties: { title: "theirs", body: "theirs" },
      tier: "library" as const,
      occurred_at: "2026-01-01T00:00:00.000Z",
      source_id: "raced.md",
    };
    const refusedKey = await hydratedHarness("queue-landed-read-401", {
      rows: held(),
    });
    try {
      const again = await refusedKey.device.create({
        type: "core.note",
        properties: { title: "mine", body: "mine" },
        source: "notes",
        sourceId: "raced.md",
        version: 0,
      });
      const behind = await refusedKey.device.update(HELD.id, {
        properties: { title: "held, edited" },
        version: HELD.version,
      });
      expect(again.ok && behind.ok).toBe(true);
      scriptWrites(refusedKey.server, {
        create: [answers.ancestorUnavailable(current, 0)],
        read: [answers.unauthorized()],
      });
      const stopped = await refusedKey.device.drain();
      expect(stopped.ok, JSON.stringify(stopped)).toBe(true);
      if (!stopped.ok) return;
      expect(
        stopped.value.stopped,
        "the drain went on past a refused credential",
      ).not.toBeNull();
      expect(
        refusedKey.server.requests.filter(
          (request) => request.method === "PATCH",
        ),
        "a write went out behind a refused credential",
      ).toEqual([]);
      const queued = await queueOf(refusedKey.device);
      expect(queued.map((row) => [row.kind, row.verdict, row.reason])).toEqual([
        ["create_item", "blocked", "credential_refused"],
        ["update_item", "blocked", "credential_refused"],
      ]);
    } finally {
      await refusedKey.stop();
    }
  });

  it("refuses the writes behind a landed create that would take from the row, and sends those that add", async () => {
    // Each was made against the row this device created. On the row another
    // device made, one that replaces, removes or moves its state would do
    // to that device's item what was meant for this one; one that adds
    // takes nothing away.
    const OTHER = { id: "01a00000-0000-7000-8000-00000000000b", version: 1 };
    const THEIRS = "01a00000-0000-7000-8000-0000000000c7";
    harness = await hydratedHarness("queue-landed-takes", {
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
    const queued = {
      tag: await device.addTag(local, "kept"),
      edge: await device.createEdge({
        source: OTHER.id,
        target: local,
        type: "references",
      }),
      replaced: await device.writeMetadata(local, ["only"], "replace"),
      merged: await device.writeMetadata(local, ["more"], "merge"),
      untagged: await device.removeTag(local, "theirs"),
      extension: await device.writeExtension(local, "app.test", { a: 1 }),
      unextended: await device.deleteExtension(local, "app.test"),
      archived: await device.transitionItem(local, "archived"),
      deleted: await device.deleteItem(local),
      restored: await device.restoreItem(local),
    };
    for (const [name, write] of Object.entries(queued)) {
      expect(write.ok, `${name}: ${JSON.stringify(write)}`).toBe(true);
    }
    const idOf = (write: (typeof queued)[keyof typeof queued]) =>
      write.ok ? write.value.id : "";
    scriptWrites(server, {
      create: [
        answers.ancestorUnavailable(
          {
            id: THEIRS,
            version: 1,
            properties: { title: "theirs", body: "theirs" },
            tier: "library",
            occurred_at: "2026-01-01T00:00:00.000Z",
            source_id: "raced.md",
          },
          0,
        ),
      ],
      read: [
        answers.updated(
          wireItem({
            id: THEIRS,
            version: 1,
            properties: { title: "theirs", body: "theirs" },
            source: "notes",
            source_id: "raced.md",
          }),
          ["theirs"],
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
      drained.value.verdicts.find((entry) => entry.id === id)?.verdict;
    expect(
      [verdictOf(idOf(queued.tag)), verdictOf(idOf(queued.edge))],
      "a write that only adds to the row did not follow the create onto it",
    ).toEqual(["accepted", "accepted"]);
    expect(
      [
        verdictOf(idOf(queued.replaced)),
        verdictOf(idOf(queued.merged)),
        verdictOf(idOf(queued.untagged)),
        verdictOf(idOf(queued.extension)),
        verdictOf(idOf(queued.unextended)),
        verdictOf(idOf(queued.archived)),
        verdictOf(idOf(queued.deleted)),
        verdictOf(idOf(queued.restored)),
      ],
      "a write that takes from the row went to another device's item",
    ).toEqual(Array(8).fill("refused"));
    // Only the tag and the edge went out after the create.
    expect(
      server.requests
        .filter((request) => request.method !== "GET")
        .map((request) => `${request.method} ${request.pathname}`),
    ).toEqual(["POST /items", `POST /items/${THEIRS}/tags`, "POST /edges"]);
    // And the copy holds the other device's row as it is, not deleted.
    const holding = await device.get(THEIRS);
    expect(holding.ok && holding.value.state).toBe("active");
  });

  it("holds a write still waiting behind a landed create on the row it landed on", async () => {
    // The tag waited on the create and follows it onto the row another
    // device made; its own answer has not come, so a read of that row shows
    // it laid over the row as the server holds it (`queue-and-verdicts.md`
    // 35), rather than the tag seeming gone until it lands.
    const THEIRS = "01a00000-0000-7000-8000-0000000000c6";
    harness = await hydratedHarness("queue-landed-waiting-tag", {
      rows: held(),
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
    expect((await device.addTag(created.value.item_id ?? "", "kept")).ok).toBe(
      true,
    );
    const theirs = {
      id: THEIRS,
      version: 1,
      properties: { title: "theirs", body: "theirs" },
      source: "notes",
      source_id: "raced.md",
    };
    scriptWrites(server, {
      create: [
        answers.ancestorUnavailable(
          {
            id: THEIRS,
            version: 1,
            properties: theirs.properties,
            tier: "library",
            occurred_at: "2026-01-01T00:00:00.000Z",
            source_id: "raced.md",
          },
          0,
        ),
      ],
      read: [answers.updated(wireItem(theirs))],
      tags: [answers.serverFault()],
    });
    const drained = await device.drain();
    expect(drained.ok, JSON.stringify(drained)).toBe(true);
    if (!drained.ok) return;
    // The witness: the tag went to that row and was not answered.
    expect(
      server.requests.some(
        (request) =>
          request.method === "POST" &&
          request.pathname === `/items/${THEIRS}/tags`,
      ),
    ).toBe(true);
    expect(
      (await queueOf(device)).filter(
        (row) => row.kind === "add_tag" && row.verdict === null,
      ),
    ).toHaveLength(1);
    const holding = await device.get(THEIRS);
    expect(holding.ok, JSON.stringify(holding)).toBe(true);
    expect(
      holding.ok && holding.value.tags,
      "a tag still waiting was not laid over the row the create landed on",
    ).toContain("kept");
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
    server.answer(
      "POST",
      "/edges",
      writeAnswers.edge({
        id: edgeId,
        source_id: HELD.id,
        target_id: target,
        version: 1,
      }),
    );
    server.answer(
      "PATCH",
      /^\/edges\/[^/]+$/,
      writeAnswers.edge(
        {
          id: edgeId,
          source_id: HELD.id,
          target_id: target,
          version: 2,
          properties: { weight: 2 },
        },
        200,
      ),
    );
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
    // The witness: the queued tag is on the row, so its going is the
    // reconcile's doing.
    const queued = await device.get(HELD.id);
    expect(queued.ok, JSON.stringify(queued)).toBe(true);
    if (!queued.ok) return;
    expect(queued.value.tags).toContain("refused-here");
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
    const readBack = () =>
      server.requests.filter(
        (request) =>
          request.method === "GET" && request.pathname === `/items/${HELD.id}`,
      ).length;
    const readsBefore = readBack();
    expect((await device.drain()).ok).toBe(true);
    expect(readBack() - readsBefore, "the refused tag was not read back").toBe(
      1,
    );

    const read = await device.get(HELD.id);
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    // The refusal was reconciled, so the row took the server's copy and lost
    // the refused tag.
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

  it("names an upload's bytes in the queue and never holds them", async () => {
    harness = await hydratedHarness("upload-named-not-held", { rows: held() });
    const { device } = harness;
    const marker = "upload-bytes-f3a9c1e7";
    const bytes = Buffer.from(`${marker}\n`);
    const queued = await device.putBlob(fileOf("note.txt", bytes));
    expect(queued.ok, JSON.stringify(queued)).toBe(true);
    if (!queued.ok) return;
    // Nowhere in the store at all, in any table, before anything else put
    // the text there: the file and its log, read as bytes.
    const inTheStore = () =>
      [device.store, `${device.store}-wal`]
        .filter((path) => existsSync(path))
        .some((path) => readFileSync(path).includes(marker));
    expect(
      inTheStore(),
      "the upload's bytes are somewhere in the store itself",
    ).toBe(false);
    // Beside it, a create whose body carries the same text, so the scans
    // below are shown to find what the store does hold.
    const control = await device.create({
      type: "core.note",
      properties: { title: "control", body: marker },
    });
    expect(control.ok, JSON.stringify(control)).toBe(true);
    if (!control.ok) return;

    // What each queue row holds, read from the store itself: the queue's
    // own report is a projection, and bytes could sit in a column it leaves
    // out.
    const store = new DatabaseSync(device.store, { readOnly: true });
    let rows: Array<Record<string, unknown>>;
    try {
      rows = store.prepare("SELECT * FROM queue").all() as Array<
        Record<string, unknown>
      >;
    } finally {
      store.close();
    }
    const encodings = [
      marker,
      bytes.toString("base64"),
      bytes.toString("hex"),
      Buffer.from(marker).toString("base64"),
    ];
    const holdsTheBytes = (row: Record<string, unknown>) =>
      Object.values(row).some((value) =>
        value instanceof Uint8Array
          ? Buffer.from(value).includes(bytes) ||
            Buffer.from(value).includes(marker)
          : typeof value === "string" &&
            encodings.some((encoded) => value.includes(encoded)),
      );
    const rowOf = (id: string) => rows.find((row) => row.id === id);
    const upload = rowOf(queued.value.id);
    expect(
      upload,
      "the upload is not a row of the queue table, so nothing here reads it",
    ).toBeDefined();
    if (upload === undefined) return;
    expect(
      holdsTheBytes(rowOf(control.value.id) ?? {}),
      "the scan did not find text a create's row holds, so it cannot find bytes either",
    ).toBe(true);
    expect(
      inTheStore(),
      "the store scan did not find text a create put in the store",
    ).toBe(true);
    // What the row carries is the name and the type, and nothing else.
    expect(
      JSON.parse(String(upload.payload)),
      "the upload's payload carries something besides the bytes' name and type",
    ).toEqual({ hash: hashOf(bytes), mime_type: "text/plain" });
    expect(upload.blob).toBe(hashOf(bytes));
    expect(
      holdsTheBytes(upload),
      "the upload's queue row holds the bytes themselves, so a queue of photos is a copy of every photo in the store",
    ).toBe(false);
    // Where they are held: beside the store, under their hash.
    expect(
      readFileSync(
        `${device.store}.blobs/${hashOf(bytes).slice("sha256:".length)}`,
      ),
    ).toEqual(bytes);
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
    // First an answer naming other bytes, which is counted, so the count
    // the locked drain leaves is one that moves on this row.
    server.answer(
      "POST",
      "/blobs",
      uploaded(`sha256:${"b".repeat(64)}`),
      uploaded(),
    );
    const counted = await device.drain();
    expect(counted.ok).toBe(true);
    if (!counted.ok) return;
    expect(
      [counted.value.verdicts[0]?.verdict, counted.value.verdicts[0]?.refusals],
      "an upload answered under another name was not counted, so a count that stays put below says nothing",
    ).toEqual([null, 1]);
    chmodSync(heldAt, 0o000);
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
      expect(
        drained.value.verdicts[0]?.refusals,
        "bytes that could not be opened for now were counted as a refusal the server gave",
      ).toBe(1);
      expect(
        (await queueOf(device)).map((row) => row.refusals),
        "the queue counted the bytes that could not be opened, whatever the drain reported",
      ).toEqual([1]);
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

describe("an edit behind an edit of the same row", () => {
  /** A second row the copy holds, for a fixture that needs one nobody else touches. */
  const QUIET = { id: "01a00000-0000-7000-8000-00000000000b", version: 7 };
  /** A row held under a natural key, for a create that lands on it. */
  const KEYED = {
    id: "01a00000-0000-7000-8000-00000000000c",
    version: 3,
    sourceId: "keyed.md",
  };
  const EDGE = "01a00000-0000-7000-8000-0000000000e1";

  /** The three rows as the hydration serves them, the edge on the first. */
  function rows(): Record<
    string,
    Array<{ item: Parameters<typeof wireItem>[0] }>
  > {
    const properties = { title: "held", body: "held" };
    return {
      "core.note": [
        {
          item: {
            id: HELD.id,
            version: HELD.version,
            properties,
            edges: {
              references: {
                data: [edgeRow(EDGE, HELD.id, QUIET.id, 1, { weight: 1 })],
                next_cursor: null,
              },
            },
          },
        },
        { item: { id: QUIET.id, version: QUIET.version, properties } },
        {
          item: {
            id: KEYED.id,
            version: KEYED.version,
            properties,
            source_id: KEYED.sourceId,
          },
        },
      ],
    };
  }

  /** The item doors deciding as the server does, holding what `rows` serves. */
  function newDoor(): FolderDoor {
    return new FolderDoor(
      [HELD, QUIET, KEYED].map(({ id, version }) => [
        id,
        {
          properties: { title: "held", body: "held" },
          source: SERVED_SOURCE,
          source_id: id === KEYED.id ? KEYED.sourceId : null,
          type: "core.note",
          version,
        },
      ]),
    );
  }

  /**
   * The item doors, deciding as the server does (`FolderDoor`, which
   * `fidelity.test.ts` holds to the server's decisions): an edit on the
   * version a row is at lands, one on a version it has left is merged against
   * that version, and a collision on a keep-both property writes a conflicted
   * copy.
   *
   * `refuse` answers an edit in the door's place where it answers anything,
   * given the edit's place among the edits of its row. `between` runs after
   * each edit the door answers and before the next is sent, which is where a
   * fixture has another device write.
   */
  function scriptDoor(
    harnessUnderTest: Harness,
    options: {
      refuse?: (
        id: string,
        nth: number,
        door: FolderDoor,
      ) => Answer | undefined;
      between?: (door: FolderDoor, id: string, nth: number) => void;
    } = {},
  ): FolderDoor {
    const door = newDoor();
    const edits = new Map<string, number>();
    scriptWrites(harnessUnderTest.server, {
      create: [
        (request) => door.create(JSON.parse(request.body) as DoorCreate).answer,
      ],
      update: [
        (request) => {
          const id = request.pathname.split("/").at(-1) ?? "";
          const nth = (edits.get(id) ?? 0) + 1;
          edits.set(id, nth);
          const refused = options.refuse?.(id, nth, door);
          if (refused !== undefined) return refused;
          const answer = door.update(
            id,
            JSON.parse(request.body) as {
              properties?: Record<string, unknown>;
              version: number;
            },
            { resolve: request.query.get("conflict") === "auto" },
          );
          options.between?.(door, id, nth);
          return answer;
        },
      ],
      // A refused write is read back to reconcile the copy.
      read: [(request) => door.read(request.pathname.split("/").at(-1) ?? "")],
    });
    return door;
  }

  /**
   * The edge door as the server keeps it: an edit on the version the edge is
   * at is merged into its properties and moves it on, and one on any other is
   * refused naming the edge as it stands (`versions.md` 16, 17).
   */
  function scriptEdgeDoor(harnessUnderTest: Harness): {
    version: number;
    properties: Record<string, unknown>;
  } {
    const edge = {
      version: 1,
      properties: { weight: 1 } as Record<string, unknown>,
    };
    harnessUnderTest.server.answer("PATCH", /^\/edges\/[^/]+$/, (request) => {
      const sent = JSON.parse(request.body) as {
        properties: Record<string, unknown>;
        version: number;
      };
      if (sent.version !== edge.version) {
        return answers.edgeVersionConflict(
          edgeRow(EDGE, HELD.id, QUIET.id, edge.version, edge.properties),
        );
      }
      edge.version += 1;
      edge.properties = { ...edge.properties, ...sent.properties };
      return writeAnswers.edge(
        {
          id: EDGE,
          source_id: HELD.id,
          target_id: QUIET.id,
          version: edge.version,
          properties: edge.properties,
        },
        200,
      );
    });
    return edge;
  }

  /** Another device's edit of a row the door holds, on the version it is at. */
  function elsewhere(
    door: FolderDoor,
    id: string,
    properties: Record<string, unknown>,
  ): void {
    const row = door.rows.get(id);
    if (row === undefined) {
      throw new Error(`the door holds no ${id} for another device to edit`);
    }
    door.update(id, { properties, version: row.version });
  }

  /** The versions the edits sent to `path` went out on, in the order they went. */
  function sentOn(harnessUnderTest: Harness, path: string): unknown[] {
    return harnessUnderTest.server.requests
      .filter(
        (request) => request.method === "PATCH" && request.pathname === path,
      )
      .map(
        (request) =>
          (JSON.parse(request.body) as { version?: unknown }).version,
      );
  }

  /** What a drain reported for the edits of one row or edge, in order. */
  function verdictsOf(
    report: DrainReport,
    kind: string,
    itemId: string,
  ): Array<string | null> {
    return report.verdicts
      .filter((entry) => entry.kind === kind && entry.item_id === itemId)
      .map((entry) => entry.verdict);
  }

  /** The body each conflicted copy the door holds carries. */
  function copies(door: FolderDoor): unknown[] {
    return door.conflictedCopies().map(([, row]) => row.properties.body);
  }

  async function edit(
    device: DeviceUnderTest,
    id: string,
    properties: Record<string, unknown>,
    version: number,
  ): Promise<void> {
    const queued = await device.update(id, { properties, version });
    expect(
      queued.ok,
      `the device would not queue an edit of ${id} on version ${String(version)}: ${JSON.stringify(queued)}`,
    ).toBe(true);
  }

  async function editEdge(
    device: DeviceUnderTest,
    properties: Record<string, unknown>,
    version: number,
  ): Promise<void> {
    const queued = await device.updateEdge(EDGE, { properties, version });
    expect(queued.ok, JSON.stringify(queued)).toBe(true);
  }

  async function drained(device: DeviceUnderTest): Promise<DrainReport> {
    const report = await device.drain();
    expect(report.ok, JSON.stringify(report)).toBe(true);
    if (!report.ok) throw new Error("unreachable: the assertion above threw");
    return report.value;
  }

  it("sends a second edit of a row on the version the first was answered with", async () => {
    harness = await hydratedHarness("edit-behind-edit", { rows: rows() });
    const { device } = harness;
    // Both made before any drain, so both are based on the version the copy
    // holds: an edit waiting in the queue does not move it.
    await edit(device, HELD.id, { body: "first" }, HELD.version);
    await edit(device, HELD.id, { body: "second" }, HELD.version);
    const door = scriptDoor(harness);
    const report = await drained(device);

    expect(
      verdictsOf(report, "update_item", HELD.id),
      "the second edit was not taken as sent: the server merged it against the device's own first edit as though another device had written it",
    ).toEqual(["accepted", "accepted"]);
    // The witness: the same two edits, the second on the version both were
    // queued against, make this door keep the first on the row and write the
    // second to a conflicted copy.
    const control = newDoor();
    control.update(HELD.id, {
      properties: { body: "first" },
      version: HELD.version,
    });
    control.update(
      HELD.id,
      { properties: { body: "second" }, version: HELD.version },
      { resolve: true },
    );
    expect(copies(control)).toEqual(["second"]);
    expect(
      copies(door),
      "the server set the device's second edit aside in a conflicted copy, with its first edit left on the row",
    ).toEqual([]);
    expect(
      sentOn(harness, `/items/${HELD.id}`),
      "the second edit went out on the version both were queued against rather than the one the first came back with",
    ).toEqual([HELD.version, HELD.version + 1]);
    expect(door.rows.get(HELD.id)?.properties.body).toBe("second");
    const read = await device.get(HELD.id);
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect([read.value.version, read.value.properties.body]).toEqual([
      HELD.version + 2,
      "second",
    ]);
  });

  it("rebases a chain of three edits one answer at a time", async () => {
    harness = await hydratedHarness("edit-chain", { rows: rows() });
    const { device } = harness;
    for (const body of ["first", "second", "third"]) {
      await edit(device, HELD.id, { body }, HELD.version);
    }
    const door = scriptDoor(harness);
    const report = await drained(device);

    expect(
      sentOn(harness, `/items/${HELD.id}`),
      "an edit in the chain went out on a version other than the answer to the edit ahead of it",
    ).toEqual([HELD.version, HELD.version + 1, HELD.version + 2]);
    expect(
      verdictsOf(report, "update_item", HELD.id),
      "an edit in the chain was merged against the device's own edit ahead of it",
    ).toEqual(["accepted", "accepted", "accepted"]);
    expect(door.rows.get(HELD.id)?.properties.body).toBe("third");
  });

  it("rebases the edits of its own unanswered create onto each answer in turn", async () => {
    harness = await hydratedHarness("edit-chain-own-create", {
      rows: rows(),
    });
    const { device } = harness;
    const note = await device.create({
      type: "core.note",
      properties: { title: "made here", body: "made here" },
    });
    expect(note.ok).toBe(true);
    if (!note.ok) return;
    const id = note.value.item_id ?? "a";
    // Based on the placeholder the copy holds for an unanswered create.
    await edit(device, id, { body: "first" }, 0);
    await edit(device, id, { body: "second" }, 0);
    const door = scriptDoor(harness);
    const report = await drained(device);

    expect(
      sentOn(harness, `/items/${id}`),
      "the first edit did not go out on the create's answer, or the second not on the first's",
    ).toEqual([1, 2]);
    expect(verdictsOf(report, "update_item", id)).toEqual([
      "accepted",
      "accepted",
    ]);
    expect(door.rows.get(id)?.properties.body).toBe("second");
  });

  it("sends a second edit of an edge on the version the first was answered with", async () => {
    harness = await hydratedHarness("edge-edit-behind-edit", { rows: rows() });
    const { device } = harness;
    await editEdge(device, { weight: 2 }, 1);
    await editEdge(device, { weight: 3 }, 1);
    scriptEdgeDoor(harness);
    const report = await drained(device);

    expect(
      verdictsOf(report, "update_edge", HELD.id),
      "the second edit of the edge was blocked as stale, having gone out on the version the first had already moved the edge past",
    ).toEqual(["accepted", "accepted"]);
    expect(sentOn(harness, `/edges/${EDGE}`)).toEqual([1, 2]);
    const edges = await device.edgesFrom(HELD.id);
    expect(edges.ok).toBe(true);
    const stored = edges.ok
      ? edges.value.find((row) => row.id === EDGE)
      : undefined;
    expect([stored?.version, stored?.properties.weight]).toEqual([3, 3]);
  });

  it("holds an edit behind one that went out unanswered, and sends it on that answer", async () => {
    harness = await hydratedHarness("edit-behind-unanswered", {
      rows: rows(),
    });
    const { device, server } = harness;
    await edit(device, HELD.id, { body: "first" }, HELD.version);
    await edit(device, HELD.id, { body: "second" }, HELD.version);
    await editEdge(device, { weight: 2 }, 1);
    await editEdge(device, { weight: 3 }, 1);

    // A drain with no server: the first edit of each goes out and meets a
    // refused connection, so it has no answer.
    await server.offline();
    expect((await device.drain()).ok).toBe(true);
    const waiting = (await queueOf(device)).filter(
      (row) => row.kind === "update_item" || row.kind === "update_edge",
    );
    expect(
      waiting.map((row) => [row.kind, row.verdict, row.reason]),
      "the edit behind one that went out unanswered was not held for that answer",
    ).toEqual([
      ["update_item", null, null],
      ["update_item", "blocked", "awaiting_dependency"],
      ["update_edge", null, null],
      ["update_edge", "blocked", "awaiting_dependency"],
    ]);

    await server.online();
    const door = scriptDoor(harness);
    scriptEdgeDoor(harness);
    const report = await drained(device);
    expect(
      sentOn(harness, `/items/${HELD.id}`),
      "the second edit went out on the version both were queued against: it had gone out, unanswered, beside the first, and a body sent under its key cannot be moved",
    ).toEqual([HELD.version, HELD.version + 1]);
    expect(verdictsOf(report, "update_item", HELD.id)).toEqual([
      "accepted",
      "accepted",
    ]);
    expect(door.rows.get(HELD.id)?.properties.body).toBe("second");
    expect(sentOn(harness, `/edges/${EDGE}`)).toEqual([1, 2]);
    expect(verdictsOf(report, "update_edge", HELD.id)).toEqual([
      "accepted",
      "accepted",
    ]);
  });

  it("holds an edit behind one the server failed to answer, even one queued while that was blocked", async () => {
    harness = await hydratedHarness("edit-behind-failure", { rows: rows() });
    const { device, server } = harness;
    // The first drain meets a refused credential, which blocks the whole
    // queue. The next fails the first edit of the row and of the edge, and
    // the one after takes whatever it is sent, as the server decides.
    const door = newDoor();
    let itemEdits = 0;
    server.answer(
      "PATCH",
      /^\/items\/[^/]+$/,
      answers.unauthorized(),
      (request) => {
        itemEdits += 1;
        if (itemEdits === 1) return answers.serverFault();
        return door.update(
          HELD.id,
          JSON.parse(request.body) as {
            properties?: Record<string, unknown>;
            version: number;
          },
          { resolve: true },
        );
      },
    );
    const edge = {
      version: 1,
      properties: { weight: 1 } as Record<string, unknown>,
    };
    let edgeEdits = 0;
    server.answer("PATCH", /^\/edges\/[^/]+$/, (request) => {
      edgeEdits += 1;
      if (edgeEdits === 1) return answers.serverFault();
      const sent = JSON.parse(request.body) as {
        properties: Record<string, unknown>;
        version: number;
      };
      if (sent.version !== edge.version) {
        return answers.edgeVersionConflict(
          edgeRow(EDGE, HELD.id, QUIET.id, edge.version, edge.properties),
        );
      }
      edge.version += 1;
      edge.properties = { ...edge.properties, ...sent.properties };
      return writeAnswers.edge(
        {
          id: EDGE,
          source_id: HELD.id,
          target_id: QUIET.id,
          version: edge.version,
          properties: edge.properties,
        },
        200,
      );
    });

    await edit(device, HELD.id, { body: "first" }, HELD.version);
    await editEdge(device, { weight: 2 }, 1);
    expect((await device.drain()).ok).toBe(true);
    // Queued behind blocked edits, so neither waits on the one ahead
    // through a dependency.
    await edit(device, HELD.id, { body: "second" }, HELD.version);
    await editEdge(device, { weight: 3 }, 1);
    expect((await device.drain()).ok).toBe(true);
    const waiting = (await queueOf(device)).filter(
      (row) => row.kind === "update_item" || row.kind === "update_edge",
    );
    expect(
      waiting.map((row) => [row.kind, row.verdict, row.reason]),
      "an edit went out beside the edit ahead of it, which the server had failed to answer, rather than waiting for that answer",
    ).toEqual([
      ["update_item", null, null],
      ["update_edge", null, null],
      ["update_item", "blocked", "awaiting_dependency"],
      ["update_edge", "blocked", "awaiting_dependency"],
    ]);

    const report = await drained(device);
    expect(sentOn(harness, `/items/${HELD.id}`)).toEqual([
      HELD.version,
      HELD.version,
      HELD.version,
      HELD.version + 1,
    ]);
    expect(verdictsOf(report, "update_item", HELD.id)).toEqual([
      "accepted",
      "accepted",
    ]);
    expect(door.rows.get(HELD.id)?.properties.body).toBe("second");
    expect(sentOn(harness, `/edges/${EDGE}`)).toEqual([1, 1, 2]);
    expect(verdictsOf(report, "update_edge", HELD.id)).toEqual([
      "accepted",
      "accepted",
    ]);
    expect(edge.properties.weight).toBe(3);
  });

  it("sends an edge edit behind a blocked or refused one as it stands", async () => {
    const other = "01a00000-0000-7000-8000-0000000000e2";
    const served = [
      edgeRow(EDGE, HELD.id, QUIET.id, 1, { weight: 1 }),
      edgeRow(other, HELD.id, KEYED.id, 1, { weight: 1 }),
    ];
    harness = await hydratedHarness("edge-edit-behind-refusal", {
      rows: {
        "core.note": [
          {
            item: {
              id: HELD.id,
              version: HELD.version,
              edges: { references: { data: served, next_cursor: null } },
            },
          },
          { item: { id: QUIET.id, version: QUIET.version } },
          { item: { id: KEYED.id, version: KEYED.version } },
        ],
      },
    });
    const { device, server } = harness;
    for (const id of [EDGE, other]) {
      for (const weight of [2, 3]) {
        const queued = await device.updateEdge(id, {
          properties: { weight },
          version: 1,
        });
        expect(queued.ok, JSON.stringify(queued)).toBe(true);
      }
    }
    // One edge has moved on elsewhere, so every edit of it on 1 is refused
    // as stale and blocked. The first edit of the other is refused outright,
    // and the second meets a busy server. A refusal is reconciled against
    // the edges the server holds.
    let otherEdits = 0;
    server.answer("PATCH", /^\/edges\/[^/]+$/, (request) => {
      if (request.pathname === `/edges/${EDGE}`) {
        return answers.edgeVersionConflict(
          edgeRow(EDGE, HELD.id, QUIET.id, 2, { weight: 5 }),
        );
      }
      otherEdits += 1;
      return otherEdits === 1
        ? refusal(400, "validation_error", "not an edit this takes")
        : answers.serverFault();
    });
    server.answer("GET", `/items/${HELD.id}/edges`, {
      kind: "json",
      status: 200,
      body: { data: served, next_cursor: null },
    });
    expect((await device.drain()).ok).toBe(true);

    const edits = (await queueOf(device)).filter(
      (row) => row.kind === "update_edge",
    );
    expect(
      edits.map((row) => [row.edge_id, row.verdict, row.reason]),
      "an edge edit behind a blocked or refused one was held or refused with it, rather than sent as it stands",
    ).toEqual([
      [EDGE, "blocked", "conflict_unresolved"],
      [EDGE, "blocked", "conflict_unresolved"],
      [other, "refused", "validation_error"],
      [other, null, null],
    ]);
    // The queue names the write ahead of each second edit, so the two
    // going out is the rule and not edits the queue never ordered.
    expect(edits.map((row) => row.follows)).toEqual([
      null,
      edits[0]?.id,
      null,
      edits[2]?.id,
    ]);
    expect([
      sentOn(harness, `/edges/${EDGE}`),
      sentOn(harness, `/edges/${other}`),
    ]).toEqual([
      [1, 1],
      [1, 1],
    ]);
    // The refused edit was reconciled away and the one still waiting behind
    // it laid back over what the server holds.
    const held = await device.edgesFrom(HELD.id);
    expect(held.ok).toBe(true);
    expect(
      held.ok
        ? held.value.find((edge) => edge.id === other)?.properties.weight
        : undefined,
      "the reconcile of the refused edge edit erased the edit still waiting behind it",
    ).toBe(3);
  });

  it("sends an edge edit queued behind two blocked ones, which hold nothing", async () => {
    harness = await startHarness("edge-edit-behind-blocked");
    const { device, server } = harness;
    const edge = edgeRow(EDGE, HELD.id, QUIET.id, 1, { weight: 1 });
    scriptHydration(server, {
      head: "10",
      rows: {
        "core.note": [
          {
            item: {
              id: HELD.id,
              version: HELD.version,
              edges: { references: { data: [edge], next_cursor: null } },
            },
          },
          { item: { id: QUIET.id, version: QUIET.version } },
        ],
      },
    });
    // Another device's edit of the edge, which the copy takes in once its
    // own two edits are blocked.
    const moved = { ...edge, version: 2, properties: { weight: 5 } };
    server.answer(
      "GET",
      "/events",
      replay("11", [edgeEvent("11", "edge.updated", moved)]),
    );
    // The edge door as the server keeps it: an edit on the version the edge
    // is at is taken, and one on any other is refused naming the edge.
    const held = { version: 2, properties: { weight: 5 } };
    server.answer("PATCH", /^\/edges\/[^/]+$/, (request) => {
      const sent = JSON.parse(request.body) as {
        properties: Record<string, unknown>;
        version: number;
      };
      if (sent.version !== held.version) {
        return answers.edgeVersionConflict(
          edgeRow(EDGE, HELD.id, QUIET.id, held.version, held.properties),
        );
      }
      held.version += 1;
      held.properties = { ...held.properties, ...sent.properties };
      return writeAnswers.edge(
        {
          id: EDGE,
          source_id: HELD.id,
          target_id: QUIET.id,
          version: held.version,
          properties: held.properties,
        },
        200,
      );
    });
    expect((await device.hydrate(["core.note"], "library")).ok).toBe(true);
    await editEdge(device, { weight: 2 }, 1);
    await editEdge(device, { weight: 3 }, 1);
    expect((await device.drain()).ok).toBe(true);
    expect((await device.catchUp()).ok).toBe(true);
    await editEdge(device, { weight: 4 }, 2);
    const report = await drained(device);

    const edits = (await queueOf(device)).filter(
      (row) => row.kind === "update_edge",
    );
    expect(
      edits.map((row) => [row.verdict, row.reason]),
      "an edge edit queued behind two the server blocked was held behind them, and nothing it waits for can ever answer",
    ).toEqual([
      ["blocked", "conflict_unresolved"],
      ["blocked", "conflict_unresolved"],
      ["accepted", null],
    ]);
    expect(verdictsOf(report, "update_edge", HELD.id)).toEqual(["accepted"]);
    expect(sentOn(harness, `/edges/${EDGE}`)).toEqual([1, 1, 2]);
    expect(held.properties.weight).toBe(4);
  });

  it("sends a delete of a row only once the edits of it ahead are answered", async () => {
    harness = await hydratedHarness("delete-behind-edits", { rows: rows() });
    const { device, server } = harness;
    await edit(device, HELD.id, { body: "first" }, HELD.version);
    await edit(device, HELD.id, { body: "second" }, HELD.version);
    const deleted = await device.deleteItem(HELD.id);
    expect(deleted.ok, JSON.stringify(deleted)).toBe(true);
    // The first drain fails the first edit; the next takes everything, and
    // a delete puts the row in the bin, where an edit finds nothing.
    const door = scriptDoor(harness, {
      refuse: (_id, nth) => (nth === 1 ? answers.serverFault() : undefined),
    });
    server.answer("DELETE", /^\/items\/[^/]+$/, (request) => {
      door.trash(request.pathname.split("/").at(-1) ?? "");
      return writeAnswers.ok();
    });
    expect((await device.drain()).ok).toBe(true);

    const writes = (await queueOf(device)).filter(
      (row) => row.item_id === HELD.id,
    );
    expect(
      writes.map((row) => [row.kind, row.verdict, row.reason]),
      "the delete went out while an edit of the row ahead of it had no answer, which puts the row in the bin before the edit reaches it",
    ).toEqual([
      ["update_item", null, null],
      ["update_item", "blocked", "awaiting_dependency"],
      ["delete_item", "blocked", "awaiting_dependency"],
    ]);
    // What holds each: the write ahead of it to the row, which the queue
    // names.
    expect(writes.map((row) => [row.depends_on, row.follows])).toEqual([
      [[], null],
      [[], writes[0]?.id],
      [[], writes[1]?.id],
    ]);

    const report = await drained(device);
    expect(verdictsOf(report, "update_item", HELD.id)).toEqual([
      "accepted",
      "accepted",
    ]);
    expect(verdictsOf(report, "delete_item", HELD.id)).toEqual(["accepted"]);
    expect(
      server.requests
        .filter((request) => request.pathname === `/items/${HELD.id}`)
        .map((request) => request.method),
    ).toEqual(["PATCH", "PATCH", "PATCH", "DELETE"]);
    expect(door.rows.get(HELD.id)?.properties.body).toBe("second");
  });

  it("holds an edit behind one the server answered unreadably, and sends it as it stands once that one is dead", async () => {
    harness = await hydratedHarness("edit-behind-dead", { rows: rows() });
    const { device, server } = harness;
    await edit(device, HELD.id, { body: "first" }, HELD.version);
    await edit(device, HELD.id, { body: "second" }, HELD.version);
    await editEdge(device, { weight: 2 }, 1);
    await editEdge(device, { weight: 3 }, 1);
    // A success whose body names no row: an answer the device cannot read,
    // counted each time, until the ceiling makes the first edits dead.
    const unreadable: Answer = {
      kind: "json",
      status: 200,
      body: { nothing: "a device can read" },
    };
    // The witness: two edits of a row the server answers.
    await edit(device, QUIET.id, { body: "first" }, QUIET.version);
    await edit(device, QUIET.id, { body: "second" }, QUIET.version);
    const door = scriptDoor(harness, {
      refuse: (id, nth) =>
        id === HELD.id && nth <= 5 ? unreadable : undefined,
    });
    server.answer("PATCH", /^\/edges\/[^/]+$/, unreadable);
    server.answer("GET", `/items/${HELD.id}/edges`, {
      kind: "json",
      status: 200,
      body: {
        data: [edgeRow(EDGE, HELD.id, QUIET.id, 1, { weight: 1 })],
        next_cursor: null,
      },
    });
    for (let pass = 1; pass <= 4; pass += 1) {
      expect((await device.drain()).ok).toBe(true);
      const edits = (await queueOf(device)).filter(
        (row) => row.kind === "update_item" && row.item_id === HELD.id,
      );
      expect(
        edits.map((row) => [row.verdict, row.reason, row.refusals]),
        `on drain ${String(pass)} the second edit did not wait for an answer to the first, which the device could not read`,
      ).toEqual([
        [null, null, pass],
        ["blocked", "awaiting_dependency", 0],
      ]);
    }
    const report = await drained(device);

    expect(
      sentOn(harness, `/items/${QUIET.id}`),
      "the edit behind an accepted one did not move onto its answer, so nothing below is about which answers it moves onto",
    ).toEqual([QUIET.version, QUIET.version + 1]);
    expect(
      verdictsOf(report, "update_item", HELD.id),
      "the first edit did not die at the ceiling, or the second did not go once it had",
    ).toEqual(["dead", "accepted"]);
    expect(
      sentOn(harness, `/items/${HELD.id}`),
      "the edit behind a dead one moved off its own base, onto a version nothing this device read says the row reached",
    ).toEqual([3, 3, 3, 3, 3, 3]);
    expect(door.rows.get(HELD.id)?.properties.body).toBe("second");
    // And an edge's: behind a dead edit it goes as it stands, and meets the
    // same unreadable answer.
    const edges = (await queueOf(device)).filter(
      (row) => row.kind === "update_edge",
    );
    expect(
      edges.map((row) => [row.verdict, row.refusals]),
      "the edge edit behind a dead one was not sent as it stands",
    ).toEqual([
      ["dead", 5],
      [null, 1],
    ]);
    expect(sentOn(harness, `/edges/${EDGE}`)).toEqual([1, 1, 1, 1, 1, 1]);
  });

  it("sends the edit behind a conflicted one on its own base, not the version the conflict came back with", async () => {
    harness = await hydratedHarness("edit-behind-conflict", { rows: rows() });
    const { device } = harness;
    await edit(device, HELD.id, { title: "one" }, HELD.version);
    await edit(device, HELD.id, { body: "two" }, HELD.version);
    await edit(device, HELD.id, { body: "three" }, HELD.version);
    // Once the first edit lands, another device changes the body, so the
    // second comes back conflicted.
    const door = scriptDoor(harness, {
      between: (scripted, id, nth) => {
        if (nth === 1) elsewhere(scripted, id, { body: "elsewhere" });
      },
    });
    const report = await drained(device);
    const sent = sentOn(harness, `/items/${HELD.id}`);

    expect(
      verdictsOf(report, "update_item", HELD.id),
      "the edits did not come back as the fixture arranged, so nothing below is about what follows a conflict",
    ).toEqual(["accepted", "conflicted", "conflicted"]);
    // The witness: behind the accepted edit, the next one moved.
    expect(
      sent[1],
      "the edit behind an accepted one did not move onto its answer, so the next assertion says nothing about a conflict",
    ).toBe(HELD.version + 1);
    // The third was made against the second's body, which the answer to the
    // first does not hold, so it stayed on the version it read.
    expect(
      sent[2],
      "the edit behind a conflicted one moved onto a version holding a body it never read, where the server takes it over the other device's body as though this device had read it",
    ).toBe(HELD.version);
    expect(
      door.rows.get(HELD.id)?.properties.body,
      "the other device's body was overwritten by an edit that never read it",
    ).toBe("elsewhere");
    expect(copies(door)).toEqual(["two", "three"]);
  });

  it("sends the edit behind a refused or blocked one on its own base", async () => {
    harness = await hydratedHarness("edit-behind-refusal", { rows: rows() });
    const { device } = harness;
    for (const id of [HELD.id, QUIET.id]) {
      const version = id === HELD.id ? HELD.version : QUIET.version;
      await edit(device, id, { title: "one" }, version);
      await edit(device, id, { title: "two" }, version);
      await edit(device, id, { body: "three" }, version);
    }
    // After each row's first edit lands, another device changes its body.
    // The second edit of the first row is then refused as naming a version
    // no snapshot covers, naming the row as it now stands, and the second
    // edit of the other row is refused outright.
    const door = scriptDoor(harness, {
      between: (scripted, id, nth) => {
        if (nth === 1) elsewhere(scripted, id, { body: "elsewhere" });
      },
      refuse: (id, nth, scripted) => {
        if (nth !== 2) return undefined;
        if (id === QUIET.id) {
          return refusal(400, "validation_error", "not an edit this takes");
        }
        const row = scripted.rows.get(id);
        return answers.ancestorUnavailable(
          {
            id,
            version: row?.version ?? 0,
            properties: row?.properties ?? {},
            tier: "library",
            occurred_at: "2026-01-01T00:00:00.000Z",
            source_id: null,
          },
          HELD.version + 1,
        );
      },
    });
    const report = await drained(device);

    expect(
      [
        verdictsOf(report, "update_item", HELD.id),
        verdictsOf(report, "update_item", QUIET.id),
      ],
      "the edits did not come back as the fixture arranged, so nothing below is about what follows a refusal",
    ).toEqual([
      ["accepted", "blocked", "conflicted"],
      ["accepted", "refused", "conflicted"],
    ]);
    // The witness: behind each accepted edit, the next one moved.
    expect(
      [
        sentOn(harness, `/items/${HELD.id}`)[1],
        sentOn(harness, `/items/${QUIET.id}`)[1],
      ],
      "the edit behind an accepted one did not move onto its answer, so the next assertion says nothing about a refusal",
    ).toEqual([HELD.version + 1, QUIET.version + 1]);
    expect(
      [
        sentOn(harness, `/items/${HELD.id}`)[2],
        sentOn(harness, `/items/${QUIET.id}`)[2],
      ],
      "the edit behind a blocked or refused one moved onto a version the row reached without it, where the server takes it over the other device's body",
    ).toEqual([HELD.version + 1, QUIET.version + 1]);
    expect(
      [
        door.rows.get(HELD.id)?.properties.body,
        door.rows.get(QUIET.id)?.properties.body,
      ],
      "the other device's body was overwritten by an edit that never read it",
    ).toEqual(["elsewhere", "elsewhere"]);
  });

  it("leaves a change another device makes between two edits for the server to merge or conflict", async () => {
    harness = await hydratedHarness("edit-between-sends", { rows: rows() });
    const { device } = harness;
    await edit(device, HELD.id, { body: "first" }, HELD.version);
    await edit(device, HELD.id, { body: "second" }, HELD.version);
    const door = scriptDoor(harness, {
      between: (scripted, id, nth) => {
        if (nth === 1) elsewhere(scripted, id, { body: "elsewhere" });
      },
    });
    const report = await drained(device);

    expect(
      sentOn(harness, `/items/${HELD.id}`),
      "the second edit went out on some version other than the one the first came back with: on the version both were queued against it collides with the device's own first edit, and on the server's newest it is taken over the other device's body without a word",
    ).toEqual([HELD.version, HELD.version + 1]);
    expect(verdictsOf(report, "update_item", HELD.id)).toEqual([
      "accepted",
      "conflicted",
    ]);
    expect(
      door.rows.get(HELD.id)?.properties.body,
      "the other device's body did not survive on the row",
    ).toBe("elsewhere");
    expect(copies(door)).toEqual(["second"]);
  });

  it("sends an edit on its own base where the edit ahead of it was applied over another device's write", async () => {
    harness = await hydratedHarness("edit-behind-merge", { rows: rows() });
    const { device } = harness;
    await edit(device, HELD.id, { title: "mine" }, HELD.version);
    await edit(device, HELD.id, { body: "second" }, HELD.version);
    // The control: two edits of a row nobody else writes.
    await edit(device, QUIET.id, { body: "first" }, QUIET.version);
    await edit(device, QUIET.id, { body: "second" }, QUIET.version);
    const door = scriptDoor(harness);
    // Before anything is sent, another device changes the body of the first
    // row, which this copy never reads. The device's first edit changes the
    // title alone, so the server merges it over that change and answers it
    // accepted, a version past the one after its base.
    elsewhere(door, HELD.id, { body: "elsewhere" });
    const report = await drained(device);

    expect(
      sentOn(harness, `/items/${QUIET.id}`),
      "the edit behind an accepted one did not move onto its answer, so nothing below is about which answers it moves onto",
    ).toEqual([QUIET.version, QUIET.version + 1]);
    expect(
      sentOn(harness, `/items/${HELD.id}`),
      "the edit behind one the server merged over another device's write moved onto that answer, which holds a body this device never read, so the server took the edit over it as though it had",
    ).toEqual([HELD.version, HELD.version]);
    expect(verdictsOf(report, "update_item", HELD.id)).toEqual([
      "accepted",
      "conflicted",
    ]);
    expect(
      door.rows.get(HELD.id)?.properties,
      "the other device's body was overwritten, or the device's own title was lost",
    ).toEqual({ title: "mine", body: "elsewhere" });
    expect(copies(door)).toEqual(["second"]);
  });

  it("sends an edit on the answer to one merged over another device's write where that write left what it carries alone", async () => {
    harness = await hydratedHarness("edit-behind-merge-apart", {
      rows: rows(),
    });
    const { device } = harness;
    await edit(device, HELD.id, { body: "first" }, HELD.version);
    await edit(device, HELD.id, { body: "second" }, HELD.version);
    const door = scriptDoor(harness);
    // Before anything is sent, another device changes the title, which
    // neither edit carries. The first edit is merged over it and answered
    // accepted, a version past the one after its base.
    elsewhere(door, HELD.id, { title: "elsewhere" });
    const report = await drained(device);

    // The witness: sent on the version both were queued against, the
    // second edit collides with the first, which changed the body since.
    const control = newDoor();
    elsewhere(control, HELD.id, { title: "elsewhere" });
    control.update(HELD.id, {
      properties: { body: "first" },
      version: HELD.version,
    });
    control.update(
      HELD.id,
      { properties: { body: "second" }, version: HELD.version },
      { resolve: true },
    );
    expect(copies(control)).toEqual(["second"]);
    expect(
      sentOn(harness, `/items/${HELD.id}`),
      "the second edit went out on the version both were queued against, where the server merges it against the device's own first edit, though the answer to that edit held the body the second was made against",
    ).toEqual([HELD.version, HELD.version + 2]);
    expect(verdictsOf(report, "update_item", HELD.id)).toEqual([
      "accepted",
      "accepted",
    ]);
    expect(copies(door)).toEqual([]);
    expect(door.rows.get(HELD.id)?.properties).toEqual({
      title: "elsewhere",
      body: "second",
    });
  });

  it("keeps the later row a catch-up brought over an older answer replayed after it", async () => {
    harness = await startHarness("replay-after-catch-up");
    const { device, server } = harness;
    scriptHydration(server, { head: "10", rows: rows() });
    // The server took the edit at 4 and another device wrote 5; the device
    // hears of both from the stream while its own answer is still lost.
    const door = newDoor();
    door.update(HELD.id, { properties: { body: "first" }, version: 3 });
    const firstAnswer = answers.updated(door.wire(HELD.id));
    elsewhere(door, HELD.id, { title: "elsewhere" });
    const { edges: _four, ...four } = wireItem({
      id: HELD.id,
      version: 4,
      properties: { title: "held", body: "first" },
    });
    const { edges: _five, ...five } = door.wire(HELD.id);
    server.answer(
      "GET",
      "/events",
      replay("12", [
        itemEvent("11", "item.updated", four),
        itemEvent("12", "item.updated", five),
      ]),
    );
    // The first send is cut off; the second is answered from the server's
    // record, with the row as it was at 4; the edit behind it meets a busy
    // server once; the rest reach the door.
    let sends = 0;
    server.answer("PATCH", /^\/items\/[^/]+$/, (request) => {
      sends += 1;
      if (sends === 1) return answers.dropped();
      if (sends === 2 && firstAnswer.kind === "json") {
        return {
          ...firstAnswer,
          headers: { "Idempotency-Replayed": "true" },
        };
      }
      if (sends === 3) return answers.serverFault();
      return door.update(
        HELD.id,
        JSON.parse(request.body) as {
          properties?: Record<string, unknown>;
          version: number;
        },
        { resolve: true },
      );
    });
    expect((await device.hydrate(["core.note"], "library")).ok).toBe(true);
    await edit(device, HELD.id, { body: "first" }, HELD.version);
    await edit(device, HELD.id, { notes: "behind" }, HELD.version);
    expect((await device.drain()).ok).toBe(true);
    expect((await device.catchUp()).ok).toBe(true);
    const replayed = await drained(device);
    // The witness: the answer that came was the replay, at 4.
    expect(
      replayed.verdicts.map((entry) => [entry.verdict, entry.replayed]),
    ).toEqual([
      ["accepted", true],
      [null, false],
    ]);

    const read = await device.get(HELD.id);
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(
      [read.value.version, read.value.properties],
      "the copy took the replayed answer at 4 over the row at 5 the stream had brought, and lost the other device's title",
    ).toEqual([
      HELD.version + 2,
      { title: "elsewhere", body: "first", notes: "behind" },
    ]);
    // The edit behind the replayed one went out on its answer, 4, and lands
    // on the row the other device moved on.
    const behind = await drained(device);
    expect(verdictsOf(behind, "update_item", HELD.id)).toEqual(["accepted"]);
    expect(sentOn(harness, `/items/${HELD.id}`)).toEqual([
      HELD.version,
      HELD.version,
      HELD.version + 1,
      HELD.version + 1,
    ]);
    // An edit made now is based on the row the copy holds, and lands on it.
    await edit(device, HELD.id, { body: "third" }, HELD.version + 3);
    const report = await drained(device);
    expect(verdictsOf(report, "update_item", HELD.id)).toEqual(["accepted"]);
    expect(door.rows.get(HELD.id)?.properties).toEqual({
      title: "elsewhere",
      body: "third",
      notes: "behind",
    });
  });

  it("sends an edit on the answer to one the server answered merged, where the collision left what it carries alone", async () => {
    harness = await hydratedHarness("edit-behind-merged", { rows: rows() });
    const { device } = harness;
    await edit(device, HELD.id, { title: "mine" }, HELD.version);
    await edit(device, HELD.id, { body: "second" }, HELD.version);
    const door = scriptDoor(harness);
    // Another device retitles the row first, so the device's own title
    // collides and the server resolves it by the last writer: an answer of
    // `merged`, not `accepted`, naming the title.
    elsewhere(door, HELD.id, { title: "elsewhere" });
    const report = await drained(device);

    expect(
      verdictsOf(report, "update_item", HELD.id),
      "the first edit was not answered merged, so nothing here is about moving onto a merged answer",
    ).toEqual(["merged", "accepted"]);
    expect(
      sentOn(harness, `/items/${HELD.id}`),
      "the edit behind a merged one did not move onto its answer, which holds the body it was made against, and went out on the version both were queued against",
    ).toEqual([HELD.version, HELD.version + 2]);
    expect(copies(door)).toEqual([]);
    expect(door.rows.get(HELD.id)?.properties).toEqual({
      title: "mine",
      body: "second",
    });
  });

  it("sends each of three edits on the answer ahead of it, the first merged over another device's write", async () => {
    harness = await hydratedHarness("edit-chain-behind-merge", {
      rows: rows(),
    });
    const { device } = harness;
    for (const body of ["first", "second", "third"]) {
      await edit(device, HELD.id, { body }, HELD.version);
    }
    const door = scriptDoor(harness);
    elsewhere(door, HELD.id, { title: "elsewhere" });
    const report = await drained(device);

    expect(
      sentOn(harness, `/items/${HELD.id}`),
      "the third edit did not reach the second's answer, which holds the body it was made against, and went out on the version all three were queued against",
    ).toEqual([HELD.version, HELD.version + 2, HELD.version + 3]);
    expect(verdictsOf(report, "update_item", HELD.id)).toEqual([
      "accepted",
      "accepted",
      "accepted",
    ]);
    // The witness: the three sent on the version they were queued against
    // leave the first on the row and set the other two aside in copies.
    const control = newDoor();
    elsewhere(control, HELD.id, { title: "elsewhere" });
    for (const body of ["first", "second", "third"]) {
      control.update(
        HELD.id,
        { properties: { body }, version: HELD.version },
        { resolve: true },
      );
    }
    expect(copies(control)).toEqual(["second", "third"]);
    expect(
      copies(door),
      "an edit of the chain was set aside in a conflicted copy, colliding with the device's own edit ahead of it",
    ).toEqual([]);
    expect(door.rows.get(HELD.id)?.properties).toEqual({
      title: "elsewhere",
      body: "third",
    });
  });

  it("orders the writes a create moves onto a row behind that row's own writes still waiting", async () => {
    harness = await hydratedHarness("landing-behind-waiting", {
      rows: rows(),
    });
    const { device, server } = harness;
    // A create under the natural key of a row the copy holds, which lands on
    // the row, then an edit of that row, and an edit of the create.
    const keyed = await device.create({
      type: "core.note",
      source: SERVED_SOURCE,
      sourceId: KEYED.sourceId,
      version: KEYED.version,
      properties: { title: "created", body: "held" },
    });
    expect(keyed.ok, JSON.stringify(keyed)).toBe(true);
    if (!keyed.ok) return;
    await edit(device, KEYED.id, { body: "first" }, KEYED.version);
    await edit(device, keyed.value.item_id ?? "k", { body: "second" }, 0);
    // The edit of the row meets a busy server; the rest reach the door.
    server.answer("PATCH", /^\/items\/[^/]+$/, answers.serverFault());
    scriptDoor(harness);
    expect((await device.drain()).ok).toBe(true);

    const writes = (await queueOf(device)).filter(
      (row) => row.item_id === KEYED.id,
    );
    // The witness: the create landed on the row and took its edit with it.
    expect(writes.map((row) => [row.kind, row.verdict])).toEqual([
      ["create_item", "accepted"],
      ["update_item", null],
      ["update_item", "blocked"],
    ]);
    expect(
      [writes[2]?.reason, writes[2]?.follows],
      "the edit moved onto the row with the create went out beside the row's own edit, which had no answer",
    ).toEqual(["awaiting_dependency", writes[1]?.id]);
    expect(
      server.requests
        .filter((request) => request.method === "PATCH")
        .map((request) => request.pathname),
    ).toEqual([`/items/${KEYED.id}`]);
  });

  it("orders a create carrying the natural key of a row the copy holds behind that row's edit still waiting", async () => {
    harness = await hydratedHarness("keyed-create-behind-waiting", {
      rows: rows(),
    });
    const { device, server } = harness;
    // An edit of the row the key names, then a create under that key, which
    // the server will land on the same row.
    await edit(device, KEYED.id, { body: "first" }, KEYED.version);
    const keyed = await device.create({
      type: "core.note",
      source: SERVED_SOURCE,
      sourceId: KEYED.sourceId,
      version: KEYED.version,
      properties: { title: "created" },
    });
    expect(keyed.ok, JSON.stringify(keyed)).toBe(true);
    if (!keyed.ok) return;
    // The first drain finds the server busy; the next reaches the door.
    const door = scriptDoor(harness, {
      refuse: (_id, nth) => (nth === 1 ? answers.serverFault() : undefined),
    });
    expect((await device.drain()).ok).toBe(true);

    const create = (await queueOf(device)).find(
      (row) => row.kind === "create_item",
    );
    const rowEdit = (await queueOf(device)).find(
      (row) => row.kind === "update_item",
    );
    expect(
      [create?.verdict, create?.reason, create?.follows],
      "the create went out beside the edit of the row it lands on, which had no answer",
    ).toEqual(["blocked", "awaiting_dependency", rowEdit?.id]);
    expect(
      server.requests.filter(
        (request) => request.method === "POST" && request.pathname === "/items",
      ),
    ).toEqual([]);

    // With the edit answered, the create goes after it, and lands on the
    // row the edit moved on.
    const report = await drained(device);
    expect(verdictsOf(report, "create_item", KEYED.id)).toEqual(["accepted"]);
    expect(
      server.requests
        .filter(
          (request) =>
            (request.method === "PATCH" &&
              request.pathname === `/items/${KEYED.id}`) ||
            (request.method === "POST" && request.pathname === "/items"),
        )
        .map((request) => request.method),
    ).toEqual(["PATCH", "PATCH", "POST"]);
    expect(door.rows.get(KEYED.id)?.properties).toEqual({
      title: "created",
      body: "first",
    });
  });

  it("holds an edit of a row behind a create carrying its natural key that had no answer", async () => {
    harness = await hydratedHarness("edit-behind-keyed-create", {
      rows: rows(),
    });
    const { device, server } = harness;
    const keyed = await device.create({
      type: "core.note",
      source: SERVED_SOURCE,
      sourceId: KEYED.sourceId,
      version: KEYED.version,
      properties: { title: "created" },
    });
    expect(keyed.ok, JSON.stringify(keyed)).toBe(true);
    if (!keyed.ok) return;
    await edit(device, KEYED.id, { body: "first" }, KEYED.version);
    // The create meets a busy server; the edit would reach the door.
    server.answer("POST", "/items", answers.serverFault());
    scriptDoor(harness);
    expect((await device.drain()).ok).toBe(true);

    const queue = await queueOf(device);
    const rowEdit = queue.find((row) => row.kind === "update_item");
    // The witness: the create went out and had no answer.
    expect(
      server.requests.filter(
        (request) => request.method === "POST" && request.pathname === "/items",
      ),
      "the create went out other than once, so the edit is not waiting on the one answer it lacks",
    ).toHaveLength(1);
    expect(queue.find((row) => row.kind === "create_item")?.verdict).toBe(null);
    expect(
      [rowEdit?.verdict, rowEdit?.reason, rowEdit?.follows],
      "the edit of the row went out beside a create the server lands on that row, which had no answer",
    ).toEqual(["blocked", "awaiting_dependency", keyed.value.id]);
    expect(sentOn(harness, `/items/${KEYED.id}`)).toEqual([]);
  });

  it("orders a tag a refused create moves onto a row behind that row's own edit still waiting", async () => {
    harness = await hydratedHarness("landing-refused-behind-waiting", {
      rows: rows(),
    });
    const { device, server } = harness;
    // A create under the natural key of a row the copy holds, claiming there
    // is no row, then an edit of that row, and a tag on the create.
    const created = await device.create({
      type: "core.note",
      source: SERVED_SOURCE,
      sourceId: KEYED.sourceId,
      version: 0,
      properties: { title: "mine", body: "mine" },
    });
    expect(created.ok, JSON.stringify(created)).toBe(true);
    if (!created.ok) return;
    await edit(device, KEYED.id, { body: "first" }, KEYED.version);
    expect((await device.addTag(created.value.item_id ?? "", "kept")).ok).toBe(
      true,
    );
    // The row's edit meets a busy server, and the create is refused, its
    // envelope naming the row, which the device reads (39).
    scriptWrites(server, {
      update: [answers.serverFault()],
      read: [
        answers.updated(
          wireItem({
            id: KEYED.id,
            version: KEYED.version,
            source_id: KEYED.sourceId,
            properties: { title: "held", body: "held" },
          }),
        ),
      ],
      create: [
        answers.ancestorUnavailable(
          {
            id: KEYED.id,
            version: KEYED.version,
            properties: { title: "held", body: "held" },
            tier: "library",
            occurred_at: "2026-01-01T00:00:00.000Z",
            source_id: KEYED.sourceId,
          },
          0,
        ),
      ],
      tags: [writeAnswers.metadata(KEYED.id, ["kept"])],
    });
    expect((await device.drain()).ok).toBe(true);

    const queue = await queueOf(device);
    const tag = queue.find((row) => row.kind === "add_tag");
    const rowEdit = queue.find(
      (row) => row.kind === "update_item" && row.item_id === KEYED.id,
    );
    // The witness: the create was refused onto the row and the tag, which
    // adds to it, moved there with it.
    expect([
      queue.find((row) => row.kind === "create_item")?.verdict,
      tag?.item_id,
    ]).toEqual(["refused", KEYED.id]);
    expect(
      [tag?.verdict, tag?.reason, tag?.follows],
      "the tag moved onto the row went out beside the row's own edit, which had no answer",
    ).toEqual(["blocked", "awaiting_dependency", rowEdit?.id]);
    const sent = (method: string, pathname: string | RegExp) =>
      server.requests.filter(
        (request) =>
          request.method === method &&
          (typeof pathname === "string"
            ? request.pathname === pathname
            : pathname.test(request.pathname)),
      ).length;
    // The create and the row's edit went out, the edit to meet the busy
    // server, and no tag went anywhere.
    expect(
      [sent("POST", "/items"), sent("PATCH", `/items/${KEYED.id}`)],
      "the create or the row's edit went out other than once, so the tag is not waiting on the one edit that had no answer",
    ).toEqual([1, 1]);
    expect(sent("POST", /^\/items\/[^/]+\/tags$/)).toBe(0);
  });

  it("keeps the later edge a catch-up brought over an older edge answer replayed after it", async () => {
    harness = await startHarness("edge-replay-after-catch-up");
    const { device, server } = harness;
    scriptHydration(server, { head: "10", rows: rows() });
    // The server took the edit at 2 and another device wrote 3; the device
    // hears of both from the stream while its own answer is still lost.
    server.answer(
      "GET",
      "/events",
      replay("12", [
        edgeEvent(
          "11",
          "edge.updated",
          edgeRow(EDGE, HELD.id, QUIET.id, 2, { weight: 2 }),
        ),
        edgeEvent(
          "12",
          "edge.updated",
          edgeRow(EDGE, HELD.id, QUIET.id, 3, { weight: 2, color: "red" }),
        ),
      ]),
    );
    const atTwo = writeAnswers.edge(
      {
        id: EDGE,
        source_id: HELD.id,
        target_id: QUIET.id,
        version: 2,
        properties: { weight: 2 },
      },
      200,
    );
    let sends = 0;
    server.answer("PATCH", /^\/edges\/[^/]+$/, () => {
      sends += 1;
      if (sends === 1) return answers.dropped();
      return atTwo.kind === "json"
        ? { ...atTwo, headers: { "Idempotency-Replayed": "true" } }
        : atTwo;
    });
    expect((await device.hydrate(["core.note"], "library")).ok).toBe(true);
    await editEdge(device, { weight: 2 }, 1);
    expect((await device.drain()).ok).toBe(true);
    expect((await device.catchUp()).ok).toBe(true);
    const report = await drained(device);
    // The witness: the answer that came was the replay, at 2.
    expect(
      report.verdicts.map((entry) => [entry.verdict, entry.replayed]),
    ).toEqual([["accepted", true]]);

    const edges = await device.edgesFrom(HELD.id);
    expect(edges.ok).toBe(true);
    const stored = edges.ok
      ? edges.value.find((row) => row.id === EDGE)
      : undefined;
    expect(
      [stored?.version, stored?.properties],
      "the copy took the replayed edge answer at 2 over the edge at 3 the stream had brought",
    ).toEqual([3, { weight: 2, color: "red" }]);
  });

  it("never changes the body of an edit that went out unanswered when a write ahead of it lands", async () => {
    harness = await hydratedHarness("sent-body-kept", { rows: rows() });
    const { device, server } = harness;
    const first = await device.update(HELD.id, {
      properties: { body: "first" },
      version: HELD.version,
    });
    await edit(device, HELD.id, { title: "second" }, HELD.version);
    expect(first.ok, JSON.stringify(first)).toBe(true);
    if (!first.ok) return;
    // The first edit's key is answered as spent, which blocks it, so the
    // second goes as it stands and meets a busy server. Released, the first
    // goes again under a fresh key and lands at 4.
    let version = HELD.version;
    let patches = 0;
    server.answer("PATCH", /^\/items\/[^/]+$/, (request) => {
      patches += 1;
      if (patches === 1) return answers.keyReused();
      if (patches === 2) return answers.serverFault();
      version += 1;
      const sent = JSON.parse(request.body) as {
        properties: Record<string, unknown>;
      };
      return answers.updated(
        wireItem({
          id: HELD.id,
          version,
          properties: { title: "held", body: "held", ...sent.properties },
        }),
      );
    });
    expect((await device.drain()).ok).toBe(true);
    const released = await device.release({ id: first.value.id });
    expect(released.ok, JSON.stringify(released)).toBe(true);
    const report = await drained(device);

    const sent = server.requests.filter(
      (request) => request.method === "PATCH",
    );
    const [, secondSent, firstAgain, secondAgain] = sent;
    // The witness: the first landed at 4, the version after the second's
    // base, which would move an edit behind it that had not gone out.
    expect(verdictsOf(report, "update_item", HELD.id)).toEqual([
      "accepted",
      "accepted",
    ]);
    expect(
      (JSON.parse(firstAgain?.body ?? "{}") as { version?: number }).version,
    ).toBe(HELD.version);
    expect(secondAgain?.headers["idempotency-key"]).toBe(
      secondSent?.headers["idempotency-key"],
    );
    expect(
      secondAgain?.body,
      "a body that went out under its key was moved onto the answer to a write ahead of it, and a server answering the key from its record would refuse it as the key reused",
    ).toBe(secondSent?.body);
  });

  it("never moves an edit made on the version a catch-up brought back onto an older answer", async () => {
    harness = await startHarness("edit-not-moved-back");
    const { device, server } = harness;
    scriptHydration(server, { head: "10", rows: rows() });
    const at = (version: number, properties: Record<string, unknown>) => {
      const { edges: _edges, ...row } = wireItem({
        id: HELD.id,
        version,
        properties,
      });
      return row;
    };
    server.answer(
      "GET",
      "/events",
      replay("12", [
        itemEvent(
          "11",
          "item.updated",
          at(4, { title: "held", body: "first" }),
        ),
        itemEvent(
          "12",
          "item.updated",
          at(5, { title: "elsewhere", body: "first" }),
        ),
      ]),
    );
    const replayed = answers.updated(
      wireItem({
        id: HELD.id,
        version: 4,
        properties: { title: "held", body: "first" },
      }),
    );
    let sends = 0;
    server.answer("PATCH", /^\/items\/[^/]+$/, (request) => {
      sends += 1;
      if (sends === 1) return answers.dropped();
      if (sends === 2 && replayed.kind === "json") {
        return { ...replayed, headers: { "Idempotency-Replayed": "true" } };
      }
      const sent = JSON.parse(request.body) as {
        properties: Record<string, unknown>;
      };
      return answers.updated(
        wireItem({
          id: HELD.id,
          version: 6,
          properties: { title: "elsewhere", body: "first", ...sent.properties },
        }),
      );
    });
    expect((await device.hydrate(["core.note"], "library")).ok).toBe(true);
    await edit(device, HELD.id, { body: "first" }, HELD.version);
    expect((await device.drain()).ok).toBe(true);
    expect((await device.catchUp()).ok).toBe(true);
    await edit(device, HELD.id, { notes: "later" }, HELD.version + 2);
    const report = await drained(device);
    // The witness: the answer ahead of it was the replay, at 4.
    expect(report.verdicts.map((entry) => entry.replayed)).toEqual([
      true,
      false,
    ]);
    expect(
      sentOn(harness, `/items/${HELD.id}`),
      "an edit based on the version a catch-up brought was moved back onto an older answer",
    ).toEqual([HELD.version, HELD.version, HELD.version + 2]);
  });

  it("sends an edit made after a catch-up back onto the base of the edit it was made against where that one conflicted", async () => {
    harness = await startHarness("edit-after-catch-up-behind-conflict");
    const { device, server } = harness;
    scriptHydration(server, { head: "10", rows: rows() });
    // Another device's body, which the copy takes in while its own first
    // edit of the body is still waiting, and lays that edit back over.
    const { edges: _edges, ...theirs } = wireItem({
      id: HELD.id,
      version: HELD.version + 1,
      properties: { title: "held", body: "theirs" },
    });
    server.answer(
      "GET",
      "/events",
      replay("11", [itemEvent("11", "item.updated", theirs)]),
    );
    expect((await device.hydrate(["core.note"], "library")).ok).toBe(true);
    await edit(device, HELD.id, { body: "first" }, HELD.version);
    expect((await device.catchUp()).ok).toBe(true);
    const shown = await device.get(HELD.id);
    // The witness: the copy is on the other device's version and shows the
    // first edit, so the second is made against that edit's body.
    expect(
      shown.ok ? [shown.value.version, shown.value.properties.body] : [],
    ).toEqual([HELD.version + 1, "first"]);
    await edit(device, HELD.id, { body: "second" }, HELD.version + 1);
    const door = scriptDoor(harness);
    elsewhere(door, HELD.id, { body: "theirs" });
    const report = await drained(device);

    expect(verdictsOf(report, "update_item", HELD.id)).toEqual([
      "conflicted",
      "conflicted",
    ]);
    expect(
      sentOn(harness, `/items/${HELD.id}`),
      "the second edit went out on the version the catch-up brought, where the server takes its body over the other device's, which this device never read",
    ).toEqual([HELD.version, HELD.version]);
    expect(
      door.rows.get(HELD.id)?.properties.body,
      "the other device's body is on no row and in no copy",
    ).toBe("theirs");
    expect(copies(door)).toEqual(["first", "second"]);
  });

  it("holds a second metadata replace, and a restore, behind the write of the row ahead that had no answer", async () => {
    harness = await hydratedHarness("row-writes-behind-unanswered", {
      rows: rows(),
    });
    const { device, server } = harness;
    const first = await device.writeMetadata(HELD.id, ["one"], "replace");
    const second = await device.writeMetadata(HELD.id, ["two"], "replace");
    const deleted = await device.deleteItem(QUIET.id);
    const restored = await device.restoreItem(QUIET.id);
    for (const queued of [first, second, deleted, restored]) {
      expect(queued.ok, JSON.stringify(queued)).toBe(true);
    }
    if (!first.ok || !deleted.ok) return;
    // The first write of each row goes out and its answer is lost.
    scriptWrites(server, { tags: [answers.dropped()] });
    server.answer("DELETE", /^\/items\/[^/]+$/, answers.dropped());
    expect((await device.drain()).ok).toBe(true);

    const queue = await queueOf(device);
    const behind = (kind: string) => queue.find((row) => row.kind === kind);
    const replaces = queue.filter((row) => row.kind === "replace_metadata");
    expect(
      [replaces[1]?.verdict, replaces[1]?.follows],
      "the second replace went out beside the first, which had no answer",
    ).toEqual(["blocked", first.value.id]);
    expect(
      [behind("restore_item")?.verdict, behind("restore_item")?.follows],
      "the restore went out beside the delete, which had no answer",
    ).toEqual(["blocked", deleted.value.id]);
    // The witness: each first write went out.
    expect(
      server.requests.map((request) => `${request.method} ${request.pathname}`),
    ).toEqual(
      expect.arrayContaining([
        `PUT /items/${HELD.id}/metadata`,
        `DELETE /items/${QUIET.id}`,
      ]),
    );
    expect(
      server.requests.filter(
        (request) =>
          request.pathname === `/items/${HELD.id}/metadata` ||
          request.pathname === `/items/${QUIET.id}/restore`,
      ),
    ).toHaveLength(1);
  });

  it("holds an edit behind a dead one released and sent again without an answer", async () => {
    harness = await hydratedHarness("edit-behind-released-dead", {
      rows: rows(),
    });
    const { device, server } = harness;
    const first = await device.update(HELD.id, {
      properties: { body: "first" },
      version: HELD.version,
    });
    expect(first.ok, JSON.stringify(first)).toBe(true);
    if (!first.ok) return;
    // Five answers the device cannot read make the first dead; the next
    // send of it, after its release, is cut off.
    const unreadable: Answer = {
      kind: "json",
      status: 200,
      body: { nothing: "a device can read" },
    };
    let sends = 0;
    server.answer("PATCH", /^\/items\/[^/]+$/, () => {
      sends += 1;
      return sends <= 5 ? unreadable : answers.dropped();
    });
    for (let pass = 0; pass < 5; pass += 1) {
      expect((await device.drain()).ok).toBe(true);
    }
    const dead = (await queueOf(device)).find(
      (row) => row.id === first.value.id,
    );
    expect(dead?.verdict).toBe("dead");
    // Queued behind the dead edit, which a release can send again.
    await edit(device, HELD.id, { title: "second" }, HELD.version);
    const released = await device.release({ id: first.value.id });
    expect(released.ok, JSON.stringify(released)).toBe(true);
    expect((await device.drain()).ok).toBe(true);

    const second = (await queueOf(device)).find(
      (row) => row.kind === "update_item" && row.id !== first.value.id,
    );
    expect(
      [second?.verdict, second?.reason, second?.follows],
      "the edit queued behind a dead one went out beside it once it was released, while it had no answer",
    ).toEqual(["blocked", "awaiting_dependency", first.value.id]);
    // The witness: the released edit went out again.
    expect(sends).toBe(6);
  });

  it("sends an edit on its own base where another device touched only the later of the two properties it changed", async () => {
    harness = await hydratedHarness("edit-two-properties-behind-merge", {
      rows: rows(),
    });
    const { device } = harness;
    await edit(device, HELD.id, { body: "first" }, HELD.version);
    await edit(
      device,
      HELD.id,
      { body: "second", notes: "mine" },
      HELD.version,
    );
    const door = scriptDoor(harness);
    // Another device sets notes, the second of the two properties the later
    // edit changed, and the first edit is merged over it.
    elsewhere(door, HELD.id, { notes: "theirs" });
    const report = await drained(device);

    expect(verdictsOf(report, "update_item", HELD.id)[0]).toBe("accepted");
    expect(
      sentOn(harness, `/items/${HELD.id}`),
      "the later edit went onto an answer holding notes it never read, checked on its first property alone",
    ).toEqual([HELD.version, HELD.version]);
    expect(
      door.rows.get(HELD.id)?.properties.notes,
      "the other device's notes were overwritten by an edit that never read them",
    ).toBe("theirs");
  });

  it("says in words which writes hold a queued write", async () => {
    harness = await hydratedHarness("queue-text", { rows: rows() });
    const { device } = harness;
    const note = await device.create({
      type: "core.note",
      properties: { title: "made here", body: "made here" },
    });
    expect(note.ok, JSON.stringify(note)).toBe(true);
    if (!note.ok) return;
    const queued = await device.text([
      "items",
      "update",
      note.value.item_id ?? "n",
      "--properties",
      JSON.stringify({ body: "edited" }),
      "--version",
      "0",
    ]);
    expect(queued.ok, JSON.stringify(queued)).toBe(true);
    if (!queued.ok) return;
    expect(queued.value).toContain(
      "waiting on 1 write(s) it cannot go without",
    );
    expect(queued.value).toContain(
      `after ${note.value.id}, the write ahead of it to the same row or edge`,
    );
    const listed = await device.text(["queue"]);
    expect(listed.ok, JSON.stringify(listed)).toBe(true);
    if (!listed.ok) return;
    const line = listed.value
      .split("\n")
      .find((text) => text.startsWith("update_item"));
    expect(line).toContain(`waiting on ${note.value.id}`);
    expect(line).toContain(`after ${note.value.id}`);
    // The witness: the create itself waits on nothing and follows nothing.
    const create = listed.value
      .split("\n")
      .find((text) => text.startsWith("create_item"));
    expect(create).not.toContain("waiting on");
    expect(create).not.toContain("after");
  });

  it("sends an edit made after a catch-up on the version the edit ahead of it was answered with", async () => {
    harness = await startHarness("edit-after-catch-up");
    const { device, server } = harness;
    scriptHydration(server, { head: "10", rows: rows() });
    // Another device's edit, which the copy takes in while its own first
    // edit is still waiting.
    server.answer(
      "GET",
      "/events",
      replay("11", [
        itemEvent(
          "11",
          "item.updated",
          wireItem({
            id: HELD.id,
            version: HELD.version + 1,
            properties: { title: "elsewhere", body: "held" },
          }),
        ),
      ]),
    );
    expect((await device.hydrate(["core.note"], "library")).ok).toBe(true);
    await edit(device, HELD.id, { body: "first" }, HELD.version);
    expect((await device.catchUp()).ok).toBe(true);
    // Made on the copy as it now stands: the other device's title, and the
    // first edit laid over it.
    await edit(device, HELD.id, { body: "second" }, HELD.version + 1);
    const door = scriptDoor(harness);
    elsewhere(door, HELD.id, { title: "elsewhere" });
    const report = await drained(device);

    expect(
      sentOn(harness, `/items/${HELD.id}`),
      "the second edit went out on the version the catch-up brought rather than the one the first edit came back with, and collides with the device's own first edit",
    ).toEqual([HELD.version, HELD.version + 2]);
    expect(verdictsOf(report, "update_item", HELD.id)).toEqual([
      "accepted",
      "accepted",
    ]);
    expect(door.rows.get(HELD.id)?.properties).toEqual({
      title: "elsewhere",
      body: "second",
    });
  });

  it("sends an edit of its own create on the version the create was based on where the server applied it over another device's write", async () => {
    harness = await hydratedHarness("edit-behind-merged-create", {
      rows: rows(),
    });
    const { device } = harness;
    // A create carrying the natural key of a row the copy holds, conditional
    // on the version it holds, and a whole-document edit of it behind.
    const keyed = await device.create({
      type: "core.note",
      source: SERVED_SOURCE,
      sourceId: KEYED.sourceId,
      version: KEYED.version,
      properties: { title: "held", body: "created" },
    });
    // The control: a create nobody else writes, with an edit behind it.
    const fresh = await device.create({
      type: "core.note",
      properties: { title: "fresh", body: "fresh" },
    });
    expect(keyed.ok && fresh.ok).toBe(true);
    if (!keyed.ok || !fresh.ok) return;
    await edit(
      device,
      keyed.value.item_id ?? "k",
      { title: "held", body: "edited", notes: "mine" },
      0,
    );
    await edit(
      device,
      fresh.value.item_id ?? "f",
      { title: "fresh", body: "edited" },
      0,
    );
    const door = scriptDoor(harness);
    // Before anything is sent, another device sets the row's notes, which
    // the edit sets too. The create changes the body alone, so the server
    // merges it over that and answers it accepted, a version past the one
    // after its base.
    elsewhere(door, KEYED.id, { notes: "elsewhere" });
    const report = await drained(device);

    expect(
      sentOn(harness, `/items/${fresh.value.item_id ?? "f"}`),
      "the edit behind a create did not move onto the create's answer, so nothing below is about which answers it moves onto",
    ).toEqual([1]);
    expect(
      verdictsOf(report, "create_item", KEYED.id),
      "the create did not land on the row its natural key names, merged over the other device's notes",
    ).toEqual(["accepted"]);
    expect(
      sentOn(harness, `/items/${KEYED.id}`),
      "the edit behind a create the server merged over another device's write moved onto that answer, which holds notes this device never read, so the server took the edit's notes over them",
    ).toEqual([KEYED.version]);
    // The other device's notes survive, and so does the create's body: the
    // edit's changes to both are set aside in a copy.
    expect(
      door.rows.get(KEYED.id)?.properties,
      "the other device's notes were overwritten by an edit that never read them",
    ).toEqual({ title: "held", body: "created", notes: "elsewhere" });
    expect(verdictsOf(report, "update_item", KEYED.id)).toEqual(["conflicted"]);
    expect(copies(door)).toEqual(["edited"]);
  });

  it("sends an edit of its own create on the version that create made where the server answers a repeat of it", async () => {
    harness = await hydratedHarness("edit-behind-repeated-create", {
      rows: rows(),
    });
    const { device, server } = harness;
    const note = await device.create({
      type: "core.note",
      properties: { title: "made here", body: "made here" },
    });
    // The control: a create carrying a natural key and no version, which
    // lands on the row the key names and is answered at that row's next
    // version.
    const keyed = await device.create({
      type: "core.note",
      source: SERVED_SOURCE,
      sourceId: KEYED.sourceId,
      properties: { title: "held", body: "created" },
    });
    expect(note.ok && keyed.ok).toBe(true);
    if (!note.ok || !keyed.ok) return;
    const id = note.value.item_id ?? "n";
    await edit(device, id, { title: "made here", body: "edited" }, 0);
    await edit(device, keyed.value.item_id ?? "k", { body: "edited" }, 0);
    // And an edge made here, edited before its create is answered.
    const link = await device.createEdge({
      source: HELD.id,
      target: QUIET.id,
      type: "references",
    });
    expect(link.ok).toBe(true);
    if (!link.ok) return;
    const linkId = link.value.edge_id ?? "e";
    const linkEdit = await device.updateEdge(linkId, {
      properties: { weight: 2 },
      version: 0,
    });
    expect(linkEdit.ok, JSON.stringify(linkEdit)).toBe(true);
    // The server took this create long ago and another device has edited
    // the row since, so it answers the create as a repeat, with the row as
    // it stands and nothing written.
    const door = scriptDoor(harness);
    door.create({
      id,
      type: "core.note",
      properties: { title: "made here", body: "made here" },
    });
    elsewhere(door, id, { title: "elsewhere" });
    // The edge likewise: taken long ago, edited twice since elsewhere, and
    // answered as a repeat with the edge as it stands. An edit of it on any
    // other version is refused naming the edge.
    const linkNow = {
      id: linkId,
      source_id: HELD.id,
      target_id: QUIET.id,
      version: 3,
      properties: { weight: 5 },
    };
    server.answer("POST", "/edges", writeAnswers.edgeRepeated(linkNow));
    server.answer("PATCH", /^\/edges\/[^/]+$/, (request) =>
      (JSON.parse(request.body) as { version: number }).version ===
      linkNow.version
        ? writeAnswers.edge(
            { ...linkNow, version: 4, properties: { weight: 2 } },
            200,
          )
        : answers.edgeVersionConflict(wireEdge(linkNow)),
    );
    const report = await drained(device);

    expect(
      sentOn(harness, `/edges/${linkId}`),
      "the edit behind an edge the server answered as a repeat moved onto the edge as it stands, which holds a weight another device wrote since, so the server took the edit over it",
    ).toEqual([1]);
    expect(verdictsOf(report, "update_edge", HELD.id)).toEqual(["blocked"]);
    expect(
      (await queueOf(device)).find(
        (row) => row.kind === "update_edge" && row.edge_id === linkId,
      )?.reason,
    ).toBe("conflict_unresolved");
    // Both repeats are reported as answered from what the server already
    // held; the upsert beside them, which wrote, is not.
    const replayed = (kind: string, itemId: string): boolean | undefined =>
      report.verdicts.find(
        (entry) => entry.kind === kind && entry.item_id === itemId,
      )?.replayed;
    expect([
      replayed("create_item", id),
      replayed("create_edge", HELD.id),
      replayed("create_item", KEYED.id),
    ]).toEqual([true, true, false]);
    expect(
      sentOn(harness, `/items/${KEYED.id}`),
      "the edit behind a create did not move onto the create's answer, so nothing below is about which answers it moves onto",
    ).toEqual([KEYED.version + 1]);
    expect(
      sentOn(harness, `/items/${id}`),
      "the edit behind a create the server answered as a repeat moved onto the row as it stands, which holds a title another device wrote since, so the server took the edit's title over it",
    ).toEqual([1]);
    expect(verdictsOf(report, "update_item", id)).toEqual(["accepted"]);
    expect(door.rows.get(id)?.properties).toEqual({
      title: "elsewhere",
      body: "edited",
    });
  });
});
