import { afterAll, afterEach, beforeAll, expect, it } from "vitest";
import { rmSync } from "node:fs";
import { dirname } from "node:path";
import { MarfaClient } from "../../client/api.js";
import type { TestContext } from "../../client/types.js";
import { CliDevice, newStore } from "../../device/cli-adapter.js";
import type { EdgeDraft, Outcome } from "../../device/protocol.js";
import {
  cleanup,
  createTestContext,
  trackEdge,
  trackEdgeType,
  trackItem,
} from "../../utils/setup.js";
import { requireBinary } from "./harness.js";

/**
 * An edge write a working copy judges on its own, against a real server and
 * the catalog it lists: each refusal the device gives is the one the server
 * gives the same write, and a write that turns on something the copy does
 * not hold is queued for the server to judge.
 */

let client: MarfaClient;
let ctx: TestContext;
let apiUrl: string;
let apiKey: string;
const stores: string[] = [];

beforeAll(async () => {
  ({ client, ctx, apiUrl, apiKey } = await createTestContext(
    "device",
    "edge-checks",
  ));
});
afterEach(() => {
  for (const store of stores.splice(0))
    rmSync(dirname(store), { recursive: true, force: true });
});
afterAll(async () => {
  if (ctx) await cleanup(ctx);
});

function value<T>(result: Outcome<T>): T {
  expect(result.ok, JSON.stringify(result)).toBe(true);
  if (!result.ok) throw new Error(result.refusal.raw);
  return result.value;
}

/** A device over a fresh store, hydrated with `types` at the library tier. */
async function hydrated(label: string, types: string[]): Promise<CliDevice> {
  const store = newStore(`edge-checks-${label}`);
  stores.push(store);
  const device = new CliDevice({
    binary: requireBinary(),
    store,
    url: apiUrl,
    key: apiKey,
  });
  value(await device.hydrate(types, "library"));
  return device;
}

async function item(
  type: string,
  properties: Record<string, unknown>,
): Promise<string> {
  const made = await client.createItem({
    type,
    source: ctx.source,
    tier: "library",
    properties,
  });
  expect(made.ok, JSON.stringify(made.error)).toBe(true);
  trackItem(ctx, made.data.item.id);
  return made.data.item.id;
}

const note = (title: string) => item("core.note", { title, body: title });
const task = (title: string) => item("core.task", { title });
const collection = (title: string) => item("core.collection", { title });

async function edge(
  source: string,
  target: string,
  edgeType: string,
): Promise<{ id: string; version: number }> {
  const made = await client.createEdge({
    source_id: source,
    target_id: target,
    edge_type: edgeType,
  });
  expect(made.ok, JSON.stringify(made.error)).toBe(true);
  trackEdge(ctx, made.data.edge.id);
  return made.data.edge;
}

async function edgeType(
  name: string,
  cardinality: "many-to-many" | "one-to-one",
  source: string[],
  target: string[],
): Promise<string> {
  const id = `mock.${name}.${ctx.runId}`;
  const made = await client.registerEdgeType({
    id,
    label: name,
    cardinality,
    source_type_constraints: source,
    target_type_constraints: target,
    cascade_on_delete: "orphan",
  });
  expect(made.ok, JSON.stringify(made.error)).toBe(true);
  trackEdgeType(ctx, id);
  return id;
}

/** The class and the server's code a device refusal carries. */
function refusedAs(
  outcome: Outcome<unknown>,
  refusal: [string, string],
  what: string,
): void {
  expect(outcome.ok, `${what} was taken`).toBe(false);
  if (outcome.ok) return;
  const envelope = JSON.parse(outcome.refusal.raw) as {
    error: { code: string; server: { code: string | null } | null };
  };
  expect(
    [envelope.error.code, envelope.error.server?.code],
    `${what} was refused, but not as the server refuses it: ${outcome.refusal.raw}`,
  ).toEqual(refusal);
}

/** The server's code for a refused write, tracking anything it took. */
function serverCode(
  answer: {
    ok: boolean;
    data?: unknown;
    error?: { error: { code: string } } | null;
  },
  what: string,
): string | undefined {
  expect(answer.ok, `the server took ${what}`).toBe(false);
  return answer.error?.error.code;
}

/**
 * The check and the create refuse `draft` as `refusal`, the create queues
 * nothing, and the server refuses the same edge with the same code.
 */
async function refusedAlike(
  device: CliDevice,
  draft: EdgeDraft,
  refusal: [string, string],
  what: string,
): Promise<void> {
  const before = value(await device.queue()).length;
  refusedAs(await device.checkEdge(draft), refusal, `${what}, checked`);
  refusedAs(await device.createEdge(draft), refusal, what);
  expect(
    value(await device.queue()).length,
    `${what} was queued all the same`,
  ).toBe(before);
  const served = await client.createEdge({
    source_id: draft.source,
    target_id: draft.target,
    edge_type: draft.type,
  });
  if (served.ok) trackEdge(ctx, served.data.edge.id);
  expect(serverCode(served, what), `the server refused ${what} otherwise`).toBe(
    refusal[1],
  );
}

/** The check passes without queueing, and the create queues the edge. */
async function queuedAfterCheck(
  device: CliDevice,
  draft: EdgeDraft,
  what: string,
): Promise<void> {
  const before = value(await device.queue()).length;
  expect(value(await device.checkEdge(draft)), what).toEqual({
    refused: false,
  });
  expect(
    value(await device.queue()).length,
    `the check of ${what} queued a write`,
  ).toBe(before);
  value(await device.createEdge(draft));
  expect(value(await device.queue()).length, `${what} was not queued`).toBe(
    before + 1,
  );
}

const CONSTRAINT: [string, string] = [
  "validation",
  "edge_constraint_violation",
];

it("refuses locally each edge the server refuses for its ends, with the server's code", async () => {
  const aboutPeople = await edgeType(
    "checks-people",
    "many-to-many",
    ["core.note"],
    ["core.entity"],
  );
  const first = await note("first");
  const second = await note("second");
  const chore = await task("chore");
  const person = await item("core.entity.person", { name: "Someone" });
  const shelf = await collection("shelf");
  const box = await collection("box");
  const binned = await note("binned");
  expect((await client.deleteItem(binned)).status).toBe(200);
  const device = await hydrated("ends", [
    "core.note",
    "core.task",
    "core.collection",
    "core.entity",
  ]);

  // The witnesses: an end beneath a type the edge type names, and a type
  // that plays the role it names, are taken.
  await queuedAfterCheck(
    device,
    { source: first, target: person, type: aboutPeople },
    "a person, beneath the entity type the edge type admits",
  );
  await queuedAfterCheck(
    device,
    { source: first, target: shelf, type: "in-collection" },
    "a note joining a collection",
  );

  await refusedAlike(
    device,
    { source: first, target: second, type: aboutPeople },
    CONSTRAINT,
    "a note as the target of an edge type that takes entities",
  );
  await refusedAlike(
    device,
    { source: chore, target: person, type: aboutPeople },
    CONSTRAINT,
    "a task as the source of an edge type that takes notes",
  );
  await refusedAlike(
    device,
    { source: first, target: chore, type: "in-collection" },
    CONSTRAINT,
    "a task, which plays no container role, as a collection",
  );
  await refusedAlike(
    device,
    { source: box, target: shelf, type: "in-collection" },
    CONSTRAINT,
    "a collection joining a collection, as nesting",
  );
  await refusedAlike(
    device,
    { source: first, target: binned, type: "about" },
    ["not_found", "item_not_found"],
    "an edge to a note in the bin",
  );
  await refusedAlike(
    device,
    { source: binned, target: first, type: "about" },
    ["not_found", "item_not_found"],
    "an edge from a note in the bin",
  );

  const drained = value(await device.drain());
  expect(
    drained.verdicts.map((row) => row.verdict),
    "the server refused an edge the copy found nothing against",
  ).toEqual(["accepted", "accepted"]);
});

it("refuses locally an edge that closes a cycle through edges the copy holds, with the server's code", async () => {
  const top = await note("top");
  const middle = await note("middle");
  const bottom = await note("bottom");
  await edge(top, middle, "parent-of");
  await edge(middle, bottom, "parent-of");
  const device = await hydrated("cycle", ["core.note"]);

  await refusedAlike(
    device,
    { source: bottom, target: top, type: "parent-of" },
    ["validation", "edge_cycle"],
    "the parent-of edge that closes top, middle, bottom",
  );
  // The witness: the same edge of a type that takes a cycle is queued.
  await queuedAfterCheck(
    device,
    { source: bottom, target: top, type: "references" },
    "a reference that closes the same loop",
  );
});

it("queues an edge whose cycle closes through an edge outside the copy, and the server refuses it", async () => {
  const upper = await note("upper");
  const lower = await note("lower");
  const between = await task("between");
  await edge(upper, between, "parent-of");
  await edge(between, lower, "parent-of");
  // The copy holds notes, so it holds the edge from upper and not the one
  // from the task: the cycle below is the server's to find.
  const device = await hydrated("cycle-outside", ["core.note"]);
  expect(value(await device.edgesTo(lower))).toEqual([]);

  await queuedAfterCheck(
    device,
    { source: lower, target: upper, type: "parent-of" },
    "an edge whose cycle runs through a task outside the slice",
  );
  const drained = value(await device.drain());
  expect(
    drained.verdicts.map((row) => [row.verdict, row.reason]),
    "the server took an edge that closes a cycle",
  ).toEqual([["refused", "edge_cycle"]]);
});

it("refuses locally a move to a type an edge at the item does not admit, with the server's code", async () => {
  const notesOnly = await edgeType(
    "checks-notes",
    "many-to-many",
    ["core.note"],
    ["core.note"],
  );
  const source = await note("source");
  const target = await note("target");
  const member = await note("member");
  const loose = await note("loose");
  const shelf = await collection("shelf");
  await edge(source, target, notesOnly);
  await edge(member, shelf, "in-collection");
  const device = await hydrated("retype", [
    "core.note",
    "core.task",
    "core.collection",
  ]);
  const before = value(await device.queue()).length;

  for (const [id, type, what] of [
    [source, "core.task", "the source of a notes edge made a task"],
    [target, "core.task", "the target of a notes edge made a task"],
    [member, "core.collection", "a collection's member made a collection"],
  ] as const) {
    refusedAs(
      await device.update(id, { properties: {}, version: 1, type }),
      CONSTRAINT,
      what,
    );
    const served = await client.updateItem(id, {
      type,
      retype: true,
      version: 1,
    });
    expect(serverCode(served, what)).toBe(CONSTRAINT[1]);
  }
  expect(value(await device.queue()).length, "a refused move was queued").toBe(
    before,
  );
  // The witness: a note with no edge moves to a task.
  value(
    await device.update(loose, {
      properties: {},
      version: 1,
      type: "core.task",
    }),
  );
});

it("refuses an inline edge of a create and a move of an edge as the server refuses them", async () => {
  const nextNote = await edgeType(
    "checks-next",
    "one-to-one",
    ["core.note"],
    ["core.note"],
  );
  const first = await note("first");
  const second = await note("second");
  const third = await note("third");
  const chore = await task("chore");
  const shelf = await collection("shelf");
  const link = await edge(first, second, nextNote);
  const top = await note("top");
  const middle = await note("middle");
  const bottom = await note("bottom");
  const upper = await edge(top, middle, "parent-of");
  await edge(middle, bottom, "parent-of");
  const device = await hydrated("inline-and-move", [
    "core.note",
    "core.task",
    "core.collection",
  ]);
  const before = value(await device.queue()).length;

  for (const [draft, what] of [
    [
      { type: "core.task", edges: { [nextNote]: [first] } },
      "a task made as the source of a notes edge",
    ],
    [
      { type: "core.collection", edges: { "in-collection": [shelf] } },
      "a collection made inside a collection",
    ],
  ] satisfies Array<
    [{ type: string; edges: Record<string, string[]> }, string]
  >) {
    refusedAs(
      await device.create({
        ...draft,
        source: ctx.source,
        properties: { title: what },
      }),
      CONSTRAINT,
      what,
    );
    const served = await client.createItem({
      ...draft,
      source: ctx.source,
      tier: "library",
      properties: { title: what },
    });
    if (served.ok) trackItem(ctx, served.data.item.id);
    expect(serverCode(served, what)).toBe(CONSTRAINT[1]);
  }

  for (const [id, version, ends, refusal, what] of [
    [
      link.id,
      link.version,
      { target_id: chore },
      CONSTRAINT,
      "a move of a notes edge onto a task",
    ],
    [
      upper.id,
      upper.version,
      { source_id: bottom },
      ["validation", "edge_cycle"],
      "a move of top to middle onto bottom, closing middle, bottom, middle",
    ],
  ] as const) {
    refusedAs(
      await device.updateEdge(id, { properties: {}, version, ...ends }),
      [...refusal],
      what,
    );
    const served = await client.updateEdge(id, { version, ...ends });
    expect(serverCode(served, what)).toBe(refusal[1]);
  }
  expect(value(await device.queue()).length, "a refused write was queued").toBe(
    before,
  );
  // The witness: the same edge moves onto a note.
  value(
    await device.updateEdge(link.id, {
      properties: {},
      version: link.version,
      target_id: third,
    }),
  );
});
