import { afterAll, afterEach, beforeAll, expect, it } from "vitest";
import { rmSync } from "node:fs";
import { dirname } from "node:path";
import { MarfaClient } from "../../client/api.js";
import type { TestContext } from "../../client/types.js";
import { CliDevice, newStore } from "../../device/cli-adapter.js";
import type { EdgeDraft, Outcome } from "../../device/protocol.js";
import { refusedCode, refusedDetails } from "../../device/refusal.js";
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

/** The class and the code a device refusal carries. */
function refusedAs(
  outcome: Outcome<unknown>,
  refusal: [string, string],
  what: string,
): void {
  expect(outcome.ok, `${what} was taken`).toBe(false);
  if (outcome.ok) return;
  expect(
    [outcome.refusal.code, refusedCode(outcome.refusal)],
    `${what} was refused, but not as the server refuses it: ${outcome.refusal.raw}`,
  ).toEqual(refusal);
}

/** The `details` beside the code a device refusal carries, or null. */
function detailsOf(outcome: Outcome<unknown>): unknown {
  if (outcome.ok) return undefined;
  return refusedDetails(outcome.refusal);
}

interface Served {
  ok: boolean;
  data?: unknown;
  error?: {
    error: { code: string; details?: Record<string, unknown> };
  } | null;
}

/** The server's code for a refused write. */
function serverCode(answer: Served, what: string): string | undefined {
  expect(answer.ok, `the server took ${what}`).toBe(false);
  return answer.error?.error.code;
}

/**
 * Each device refusal in `outcomes` carries the `details` the server gave
 * the same write, which an app reads `details.constraint` from.
 */
function detailsAlike(
  outcomes: Outcome<unknown>[],
  served: Served,
  what: string,
): void {
  const details = served.error?.error.details;
  expect(details, `the server gave ${what} no details`).toBeDefined();
  for (const outcome of outcomes) {
    expect(
      detailsOf(outcome),
      `${what}: the device's details are not the server's`,
    ).toEqual(details);
  }
}

/**
 * The check and the create refuse `draft` as `refusal`, the create queues
 * nothing, and the server refuses the same edge with the same code, and for
 * a `validation` refusal with the same details.
 */
async function refusedAlike(
  device: CliDevice,
  draft: EdgeDraft,
  refusal: [string, string],
  what: string,
): Promise<void> {
  const before = value(await device.queue()).length;
  const checked = await device.checkEdge(draft);
  const created = await device.createEdge(draft);
  refusedAs(checked, refusal, `${what}, checked`);
  refusedAs(created, refusal, what);
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
  if (refusal[0] === "validation")
    detailsAlike([checked, created], served, what);
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

/**
 * The server's details for a duplicate and for each full end, which share
 * the class and the code and differ by `details.constraint` and the end
 * named.
 */
const DUPLICATE = (draft: EdgeDraft) => ({
  edge_type: draft.type,
  source_id: draft.source,
  target_id: draft.target,
  constraint: "duplicate",
});
const SOURCE_FULL = (draft: EdgeDraft) => ({
  edge_type: draft.type,
  source_id: draft.source,
  constraint: "cardinality",
});
const TARGET_FULL = (draft: EdgeDraft) => ({
  edge_type: draft.type,
  target_id: draft.target,
  constraint: "cardinality",
});
type Details = (draft: EdgeDraft) => Record<string, unknown>;

/** A device refusal as `edge_constraint_violation` carrying `details`. */
function refusedWith(
  outcome: Outcome<unknown>,
  details: Record<string, unknown>,
  what: string,
): void {
  refusedAs(outcome, CONSTRAINT, what);
  expect(detailsOf(outcome), what).toEqual(details);
}

/** The server's code and details for a refused write. */
function servedRefusal(
  answer: Served,
  what: string,
): [string | undefined, unknown] {
  expect(answer.ok, `the server took ${what}`).toBe(false);
  return [answer.error?.error.code, answer.error?.error.details];
}

/**
 * The check and the create refuse `draft` with the details `details` gives,
 * the create queues nothing, and the server refuses the same edge with the
 * same details.
 */
async function constraintAlike(
  device: CliDevice,
  draft: EdgeDraft,
  details: Details,
  what: string,
): Promise<void> {
  const before = value(await device.queue()).length;
  refusedWith(
    await device.checkEdge(draft),
    details(draft),
    `${what}, checked`,
  );
  refusedWith(await device.createEdge(draft), details(draft), what);
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
  expect(
    servedRefusal(served, what),
    `the server refused ${what} otherwise`,
  ).toEqual([CONSTRAINT[1], details(draft)]);
}

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
  await refusedAlike(
    device,
    { source: top, target: top, type: "parent-of" },
    ["validation", "edge_cycle"],
    "a parent-of edge from top to itself",
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
    const refused = await device.update(id, {
      properties: {},
      version: 1,
      type,
    });
    refusedAs(refused, CONSTRAINT, what);
    const served = await client.updateItem(id, {
      type,
      retype: true,
      version: 1,
    });
    expect(serverCode(served, what)).toBe(CONSTRAINT[1]);
    detailsAlike([refused], served, what);
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
    const refused = await device.create({
      ...draft,
      source: ctx.source,
      properties: { title: what },
    });
    refusedAs(refused, CONSTRAINT, what);
    const served = await client.createItem({
      ...draft,
      source: ctx.source,
      tier: "library",
      properties: { title: what },
    });
    if (served.ok) trackItem(ctx, served.data.item.id);
    expect(serverCode(served, what)).toBe(CONSTRAINT[1]);
    // Each side names the id it made for the item, so only that differs.
    const details = served.error?.error.details;
    expect(
      detailsOf(refused),
      `${what}: the device's details are not the server's`,
    ).toEqual(
      details !== undefined && "source_id" in details
        ? { ...details, source_id: expect.any(String) }
        : details,
    );
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
    [
      link.id,
      link.version,
      { target_id: first },
      ["validation", "edge_cycle"],
      "a move of a notes edge onto its own source",
    ],
  ] as const) {
    const checked = await device.checkEdgeMove(id, ends);
    const moved = await device.updateEdge(id, {
      properties: {},
      version,
      ...ends,
    });
    refusedAs(checked, [...refusal], `${what}, checked`);
    refusedAs(moved, [...refusal], what);
    const served = await client.updateEdge(id, { version, ...ends });
    expect(serverCode(served, what)).toBe(refusal[1]);
    detailsAlike([checked, moved], served, what);
  }
  expect(value(await device.queue()).length, "a refused write was queued").toBe(
    before,
  );
  // The witness: the same edge moves onto a note.
  expect(
    value(await device.checkEdgeMove(link.id, { target_id: third })),
  ).toEqual({ refused: false });
  value(
    await device.updateEdge(link.id, {
      properties: {},
      version: link.version,
      target_id: third,
    }),
  );
});

it("refuses locally a duplicate, and an edge onto each end a cardinality holds to one, with the server's code", async () => {
  const a = await note("a");
  const b = await note("b");
  const c = await note("c");
  const d = await note("d");
  await edge(a, b, "references");
  await edge(a, b, "supersedes");
  await edge(a, b, "parent-of");
  await edge(b, a, "in-thread");
  const device = await hydrated("full-ends", ["core.note"]);

  await constraintAlike(
    device,
    { source: a, target: b, type: "references" },
    DUPLICATE,
    "a second references edge from a to b",
  );
  for (const [draft, details, what] of [
    [
      { source: a, target: c, type: "supersedes" },
      SOURCE_FULL,
      "a second one-to-one edge from a",
    ],
    [
      { source: c, target: b, type: "supersedes" },
      TARGET_FULL,
      "a second one-to-one edge to b",
    ],
    [
      { source: c, target: b, type: "parent-of" },
      TARGET_FULL,
      "a second parent of b",
    ],
    [
      { source: b, target: c, type: "in-thread" },
      SOURCE_FULL,
      "b in a second thread",
    ],
  ] satisfies Array<[EdgeDraft, Details, string]>) {
    await constraintAlike(device, draft, details, what);
  }

  // The witnesses: the end each cardinality leaves open takes another edge.
  await queuedAfterCheck(
    device,
    { source: a, target: c, type: "parent-of" },
    "a second child of a",
  );
  await queuedAfterCheck(
    device,
    { source: c, target: a, type: "in-thread" },
    "a second message in a's thread",
  );
  await queuedAfterCheck(
    device,
    { source: c, target: d, type: "supersedes" },
    "a one-to-one edge between two free ends",
  );
  const drained = value(await device.drain());
  expect(
    drained.verdicts.map((row) => row.verdict),
    "the server refused an edge the copy found nothing against",
  ).toEqual(["accepted", "accepted", "accepted"]);
});

it("counts an edge waiting to be sent, and frees the end a waiting delete leaves, as the server does once they reach it", async () => {
  const a = await note("a");
  const b = await note("b");
  const c = await note("c");
  const d = await note("d");
  const e = await note("e");
  const held = await edge(c, d, "supersedes");
  const device = await hydrated("queued", ["core.note"]);
  value(await device.createEdge({ source: a, target: b, type: "supersedes" }));
  const waiting = [
    [
      { source: a, target: b, type: "supersedes" },
      DUPLICATE,
      "the triple of an edge waiting to be sent",
    ],
    [
      { source: a, target: e, type: "supersedes" },
      SOURCE_FULL,
      "a second edge from a, whose first waits to be sent",
    ],
    [
      { source: e, target: b, type: "supersedes" },
      TARGET_FULL,
      "a second edge to b, whose first waits to be sent",
    ],
  ] satisfies Array<[EdgeDraft, Details, string]>;
  const before = value(await device.queue()).length;
  for (const [draft, details, what] of waiting) {
    refusedWith(
      await device.checkEdge(draft),
      details(draft),
      `${what}, checked`,
    );
    refusedWith(await device.createEdge(draft), details(draft), what);
  }
  const fromC = { source: c, target: e, type: "supersedes" };
  refusedWith(
    await device.createEdge(fromC),
    SOURCE_FULL(fromC),
    "a second edge from c while its held edge stands",
  );
  expect(value(await device.queue()).length, "a refused edge was queued").toBe(
    before,
  );

  value(await device.deleteEdge(held.id));
  await queuedAfterCheck(
    device,
    { source: c, target: e, type: "supersedes" },
    "an edge from c once the delete of its held edge waits to be sent",
  );
  const drained = value(await device.drain());
  expect(
    drained.verdicts.map((row) => [row.kind, row.verdict]),
    "the server refused a write the copy counted as it would",
  ).toEqual([
    ["create_edge", "accepted"],
    ["delete_edge", "accepted"],
    ["create_edge", "accepted"],
  ]);
  // The server now holds what the copy counted, and refuses the same edges
  // with the details the device gave.
  for (const [draft, details, what] of waiting) {
    const served = await client.createEdge({
      source_id: draft.source,
      target_id: draft.target,
      edge_type: draft.type,
    });
    if (served.ok) trackEdge(ctx, served.data.edge.id);
    expect(
      servedRefusal(served, what),
      `the server refused ${what} otherwise`,
    ).toEqual([CONSTRAINT[1], details(draft)]);
  }
});

it("does not count an edge whose create the server refused", async () => {
  const a = await note("a");
  const b = await note("b");
  const c = await note("c");
  const e = await note("e");
  const device = await hydrated("refused", ["core.note"]);
  const queued = value(
    await device.createEdge({ source: a, target: b, type: "supersedes" }),
  );
  // The server takes another edge from a first, so it refuses the queued one.
  await edge(a, c, "supersedes");
  const drained = value(await device.drain());
  expect(
    drained.verdicts.map((row) => [row.edge_id, row.verdict, row.reason]),
  ).toEqual([[queued.edge_id, "refused", "edge_constraint_violation"]]);

  await queuedAfterCheck(
    device,
    { source: e, target: b, type: "supersedes" },
    "an edge to b, which only the refused edge reached",
  );
  const sent = value(await device.drain());
  expect(
    sent.verdicts.map((row) => row.verdict),
    "the server refused an edge to an end it holds free",
  ).toEqual(["accepted"]);
});

it("refuses a move onto a full end, checked or made, and finds nothing against a move onto the edge's own end", async () => {
  const a = await note("a");
  const b = await note("b");
  const c = await note("c");
  const d = await note("d");
  const e = await note("e");
  const link = await edge(a, b, "supersedes");
  await edge(c, d, "supersedes");
  const device = await hydrated("move", ["core.note"]);
  const before = value(await device.queue()).length;

  for (const [ends, details, what] of [
    [
      { target_id: d },
      TARGET_FULL({ source: a, target: d, type: "supersedes" }),
      "a move onto d, which c's edge reaches",
    ],
    [
      { source_id: c },
      SOURCE_FULL({ source: c, target: b, type: "supersedes" }),
      "a move onto c, whose edge leaves it",
    ],
  ] as const) {
    refusedWith(
      await device.checkEdgeMove(link.id, ends),
      details,
      `${what}, checked`,
    );
    refusedWith(
      await device.updateEdge(link.id, {
        properties: {},
        version: link.version,
        ...ends,
      }),
      details,
      what,
    );
    const served = await client.updateEdge(link.id, {
      version: link.version,
      ...ends,
    });
    expect(
      servedRefusal(served, what),
      `the server refused ${what} otherwise`,
    ).toEqual([CONSTRAINT[1], details]);
  }

  // The edge does not count against itself at the ends it holds.
  for (const ends of [{ target_id: b }, { source_id: a }]) {
    expect(
      value(await device.checkEdgeMove(link.id, ends)),
      `a move onto ${JSON.stringify(ends)}, the edge's own end`,
    ).toEqual({ refused: false });
  }
  // The witness: a move onto a free end.
  expect(value(await device.checkEdgeMove(link.id, { target_id: e }))).toEqual({
    refused: false,
  });
  expect(
    value(await device.queue()).length,
    "a check or a refused move queued a write",
  ).toBe(before);
  // The server takes an end the edge holds as no move, so the edit carries
  // properties.
  const served = await client.updateEdge(link.id, {
    version: link.version,
    target_id: b,
    properties: {},
  });
  expect(
    served.ok,
    `the server refused a move onto the edge's own end: ${JSON.stringify(served.error)}`,
  ).toBe(true);
});

it("answers a duplicate before a full end, and a full end before a cycle, as the server does", async () => {
  const top = await note("top");
  const middle = await note("middle");
  const bottom = await note("bottom");
  await edge(top, middle, "parent-of");
  await edge(middle, bottom, "parent-of");
  const device = await hydrated("order", ["core.note"]);

  await constraintAlike(
    device,
    { source: top, target: middle, type: "parent-of" },
    DUPLICATE,
    "a second edge from top to middle, which also gives middle a second parent",
  );
  await constraintAlike(
    device,
    { source: bottom, target: middle, type: "parent-of" },
    TARGET_FULL,
    "a second parent of middle that also closes middle, bottom, middle",
  );
  // The witness: a cycle alone is refused as a cycle.
  await refusedAlike(
    device,
    { source: bottom, target: top, type: "parent-of" },
    ["validation", "edge_cycle"],
    "the edge that closes top, middle, bottom",
  );
});
