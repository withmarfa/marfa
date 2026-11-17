import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MarfaClient } from "../../client/api.js";
import {
  CliDevice,
  newStore,
  type DeviceCount,
} from "../../device/cli-adapter.js";
import type { Outcome } from "../../device/protocol.js";
import {
  bootFreshServer,
  FRESH_SERVER_TIMEOUT_MS,
  type FreshServer,
} from "../../utils/fresh-server.js";
import { newRunId } from "../../utils/setup.js";
import { requireBinary } from "./harness.js";

/**
 * What a device counts (`device.md`, "Counting on a device"): the same data
 * counted by the server's `POST /items/counts` and by a working copy that
 * holds it, against a fresh server and the real binary.
 */

const WORDS = [
  { value: "todo", group: "not_started" },
  { value: "doing", group: "in_progress" },
  { value: "done", group: "completed" },
  { value: "dropped", group: "canceled" },
];
const GROUPS = ["not_started", "in_progress", "completed", "canceled"];
const run = newRunId()
  .replaceAll(/[^a-z0-9]/gi, "")
  .toLowerCase();
const taskType = `user.counted-task-${run}`;
const memoType = `user.counted-memo-${run}`;
const driftType = `user.counted-drift-${run}`;
const heldLedger = `user.counted-held-${run}`;
const servedLedger = `user.counted-served-${run}`;
const EDGES = ["parent-of", "in-collection"];
const NOT_LISTENING = "http://127.0.0.1:1";

let server: FreshServer;
let owner: MarfaClient;
let counter = 0;
const ids: Record<string, string> = {};

beforeAll(async () => {
  server = await bootFreshServer("device-counts");
  owner = new MarfaClient({
    baseUrl: server.apiUrl,
    apiKey: server.workingKey,
  });
  const status = { type: "status", status_values: WORDS };
  const lines = { lines: { columns: { amount: { type: "number" } } } };
  for (const schema of [
    { id: taskType, fields: { title: { type: "string" }, stage: status } },
    { id: memoType, fields: { title: { type: "string" } } },
    {
      id: driftType,
      fields: {
        stage: {
          type: "status",
          status_values: [...WORDS, { value: "waiting", group: "in_progress" }],
        },
      },
    },
    { id: heldLedger, fields: { title: { type: "string" } }, tables: lines },
    { id: servedLedger, fields: { title: { type: "string" } }, tables: lines },
  ]) {
    const made = await owner.registerType(schema as never);
    expect(made.status, JSON.stringify(made.error)).toBe(201);
  }

  ids.parent = await item(taskType, { title: "parent" });
  ids.lone = await item(taskType, { title: "no children" });
  const children: [string, string, Record<string, unknown>][] = [
    ["todo", taskType, { stage: "todo" }],
    ["todo2", taskType, { stage: "todo" }],
    ["doing", taskType, { stage: "doing" }],
    ["done", taskType, { stage: "done" }],
    ["dropped", taskType, { stage: "dropped" }],
    ["valueless", taskType, {}],
    ["memo", memoType, { title: "no status field" }],
    ["trashed", taskType, { stage: "done" }],
    ["archived", taskType, { stage: "done" }],
  ];
  for (const [role, type, properties] of children) {
    ids[role] = await item(type, properties);
    await link("parent-of", ids.parent, ids[role]);
  }
  ids.drifted = await item(driftType, { stage: "waiting" });
  await link("parent-of", ids.parent, ids.drifted);
  const dropped = await owner.replaceType(driftType, {
    id: driftType,
    fields: { stage: status },
  } as never);
  expect(dropped.status, JSON.stringify(dropped.error)).toBe(200);
  expect((await owner.deleteItem(ids.trashed)).ok).toBe(true);
  expect((await owner.transitionItem(ids.archived, "archived")).ok).toBe(true);
  // A grandchild, so the anchor under the parent has a child of its own.
  ids.grandchild = await item(taskType, { stage: "done" });
  await link("parent-of", ids.todo, ids.grandchild);

  ids.collection = await item("core.collection", { title: "members" });
  for (const [role, stage] of [
    ["memberTodo", "todo"],
    ["memberDone", "done"],
  ]) {
    ids[role] = await item(taskType, { stage });
    await link("in-collection", ids[role], ids.collection);
  }

  ids.held = await item(heldLedger, { title: "three rows" });
  ids.heldEmpty = await item(heldLedger, { title: "no rows" });
  ids.served = await item(servedLedger, { title: "two rows" });
  await rows(ids.held, 3);
  await rows(ids.served, 2);
}, FRESH_SERVER_TIMEOUT_MS);

afterAll(async () => {
  await server?.stop();
}, FRESH_SERVER_TIMEOUT_MS);

function value<T>(outcome: Outcome<T>): T {
  expect(outcome.ok, JSON.stringify(outcome)).toBe(true);
  if (!outcome.ok) throw new Error(outcome.refusal.raw);
  return outcome.value;
}

async function item(
  type: string,
  properties: Record<string, unknown>,
): Promise<string> {
  const made = await owner.createItem({ type, properties } as never);
  expect(made.status, JSON.stringify(made.error)).toBe(201);
  return made.data.item.id;
}

async function link(edgeType: string, from: string, to: string) {
  const made = await owner.createEdge({
    from_id: from,
    to_id: to,
    edge_type: edgeType,
  });
  expect(made.status, JSON.stringify(made.error)).toBe(201);
}

async function rows(host: string, count: number) {
  const written = await owner.writeRows(host, "lines", {
    operations: Array.from({ length: count }, (_, n) => ({
      op: "put",
      values: { amount: n },
    })),
  } as never);
  expect(written.status, JSON.stringify(written.error)).toBe(200);
}

type Counted = { backref: string } | { edge: string } | { table: string };

/** `POST /items/counts`, as the server answers it. */
async function served(
  asked: string[],
  counted: Counted,
): Promise<Omit<DeviceCount, "held">[]> {
  const answered = await owner.rawRequest<{
    counts: Omit<DeviceCount, "held">[];
  }>("/items/counts", { method: "POST", body: { ids: asked, ...counted } });
  expect(answered.status, JSON.stringify(answered.error)).toBe(200);
  return answered.data.counts;
}

function copyOf(label: string, url = server.apiUrl, store = ""): CliDevice {
  counter += 1;
  return new CliDevice({
    binary: requireBinary(),
    store:
      store === "" ? newStore(`counts-${label}-${String(counter)}`) : store,
    url,
    key: server.workingKey,
  });
}

async function hydrated(
  label: string,
  types: string[],
  edgeTypes: string[],
): Promise<CliDevice> {
  const device = copyOf(label);
  value(await device.hydrate(types, "library", { edgeTypes }));
  return device;
}

const EVERY_TYPE = [taskType, memoType, driftType, "core.collection"];
const linked = () => [
  ids.parent,
  ids.lone,
  ids.todo,
  ids.collection,
  ids.grandchild,
  ids.memberDone,
];

describe("a device counts as the server does", () => {
  it("answers each count of links as the server does, across every group, the bin, archived, an undeclared word, no status and both directions", async () => {
    const device = await hydrated("equal", EVERY_TYPE, EDGES);
    for (const counted of [
      { backref: "parent-of" },
      { edge: "parent-of" },
      { edge: "in-collection" },
      { backref: "in-collection" },
    ] as Counted[]) {
      const local = value(await device.counts(linked(), counted)).counts;
      const remote = await served(linked(), counted);
      expect(
        local.map(({ held, ...rest }) => {
          expect(held, JSON.stringify(counted)).toBe(true);
          return rest;
        }),
        JSON.stringify(counted),
      ).toEqual(remote);
    }
    // The witness: the data reaches every group, and the bin, archived,
    // undeclared and valueless children are in no group or not counted.
    const [parent, lone] = value(
      await device.counts([ids.parent, ids.lone], { backref: "parent-of" }),
    ).counts;
    expect(parent?.total).toBe(8);
    expect(parent?.status_groups).toEqual({
      not_started: 2,
      in_progress: 1,
      completed: 1,
      canceled: 1,
    });
    expect(lone).toMatchObject({ total: 0, held: true });
    expect(Object.keys(parent?.status_groups ?? {}).sort()).toEqual(
      [...GROUPS].sort(),
    );
    const members = value(
      await device.counts([ids.collection], { edge: "in-collection" }),
    ).counts;
    expect(members[0]?.total).toBe(2);
  });

  it("answers a count of an id the copy does not hold as the server answers one no item holds", async () => {
    const device = await hydrated("unknown", EVERY_TYPE, EDGES);
    const nothing = "019537a0-7b80-7000-8000-000000000000";
    const local = value(
      await device.counts([nothing], { backref: "parent-of" }),
    );
    expect(local.counts).toEqual([
      {
        id: nothing,
        total: 0,
        status_groups: {
          not_started: 0,
          in_progress: 0,
          completed: 0,
          canceled: 0,
        },
        held: true,
      },
    ]);
    expect(await served([nothing], { backref: "parent-of" })).toEqual([
      { id: nothing, total: 0, status_groups: local.counts[0]?.status_groups },
    ]);
  });

  it("answers each id once, in the order they first appear, and refuses more than 100 ids and an id that is no id", async () => {
    const device = await hydrated("ids", EVERY_TYPE, EDGES);
    const asked = [ids.lone, ids.parent, ids.lone];
    const local = value(await device.counts(asked, { backref: "parent-of" }));
    expect(local.counts.map((count) => count.id)).toEqual([
      ids.lone,
      ids.parent,
    ]);
    expect(
      (await served(asked, { backref: "parent-of" })).map((c) => c.id),
    ).toEqual([ids.lone, ids.parent]);
    for (const refused of [
      Array.from({ length: 101 }, () => ids.parent),
      ["not-an-id"],
    ]) {
      const outcome = await device.counts(refused, { backref: "parent-of" });
      expect(outcome.ok, JSON.stringify(refused.slice(0, 2))).toBe(false);
      if (outcome.ok) continue;
      expect(outcome.refusal.code).toBe("validation");
      expect(outcome.refusal.server).toBeNull();
    }
    // The witness: 100 ids are counted.
    const hundred = Array.from({ length: 100 }, () => ids.parent);
    expect(
      value(await device.counts(hundred, { backref: "parent-of" })).counts,
    ).toHaveLength(1);
  });

  it("counts a table's rows from the copy where it holds the table whole and from the server otherwise, and says which", async () => {
    const device = await hydrated("rows", [heldLedger, servedLedger], []);
    value(await device.holdTable(heldLedger, "lines"));
    const asked = [ids.held, ids.heldEmpty, ids.served];
    const local = value(await device.counts(asked, { table: "lines" })).counts;
    expect(local.map((count) => [count.id, count.total, count.held])).toEqual([
      [ids.held, 3, true],
      [ids.heldEmpty, 0, true],
      [ids.served, 2, false],
    ]);
    expect(local.every((count) => count.status_groups === undefined)).toBe(
      true,
    );
    expect(local.map(({ id, total }) => ({ id, total }))).toEqual(
      await served(asked, { table: "lines" }),
    );
  });

  it("answers a count of an edge type it holds whole while the server cannot be reached", async () => {
    const store = newStore(`counts-offline-${String(counter)}`);
    const device = copyOf("offline", server.apiUrl, store);
    value(await device.hydrate(EVERY_TYPE, "library", { edgeTypes: EDGES }));
    const offline = copyOf("offline", NOT_LISTENING, store);
    const local = value(
      await offline.counts(linked(), { backref: "parent-of" }),
    ).counts;
    expect(local.every((count) => count.held)).toBe(true);
    expect(local.map(({ held: _held, ...rest }) => rest)).toEqual(
      await served(linked(), { backref: "parent-of" }),
    );
    // The witness: a table the copy does not hold needs the server, which is not there.
    const rowsOf = await offline.counts([ids.served], { table: "lines" });
    expect(rowsOf.ok).toBe(false);
  });

  it("gives the server's counts once the copy has caught up, and not before", async () => {
    const device = await hydrated("caught-up", EVERY_TYPE, EDGES);
    const before = value(
      await device.counts([ids.parent], { backref: "parent-of" }),
    ).counts[0];
    const late = await item(taskType, { stage: "doing" });
    await link("parent-of", ids.parent, late);
    const stale = value(
      await device.counts([ids.parent], { backref: "parent-of" }),
    ).counts[0];
    expect(stale?.total, "the copy changed before it caught up").toBe(
      before?.total,
    );
    value(await device.catchUp());
    const [remote] = await served([ids.parent], { backref: "parent-of" });
    const now = value(
      await device.counts([ids.parent], { backref: "parent-of" }),
    ).counts[0];
    expect(now?.total).toBe((before?.total ?? 0) + 1);
    expect({ ...now, held: undefined }).toEqual({ ...remote, held: undefined });
  });
});

describe("a device refuses a count its copy cannot answer as the server does", () => {
  function refusedInvalid(outcome: Outcome<unknown>, what: string) {
    expect(outcome.ok, `${what} was answered`).toBe(false);
    if (outcome.ok) return;
    const envelope = JSON.parse(outcome.refusal.raw) as {
      error: { code: string; server?: { code: string | null } | null };
    };
    expect(
      [envelope.error.code, envelope.error.server?.code ?? null],
      `${what} was refused as though the server refuses it: ${outcome.refusal.raw}`,
    ).toEqual(["invalid", null]);
  }

  it("refuses a count of an edge type the copy does not hold whole, carrying no server code", async () => {
    const device = await hydrated("not-whole", EVERY_TYPE, ["parent-of"]);
    // The witness: the edge type held whole is counted, from the same copy.
    const [held] = value(
      await device.counts([ids.parent], { backref: "parent-of" }),
    ).counts;
    expect(held?.total).toBeGreaterThan(0);
    expect({ ...held, held: undefined }).toEqual({
      ...(await served([ids.parent], { backref: "parent-of" }))[0],
      held: undefined,
    });
    for (const counted of [
      { backref: "in-collection" },
      { edge: "in-collection" },
    ] as Counted[]) {
      refusedInvalid(
        await device.counts([ids.collection], counted),
        JSON.stringify(counted),
      );
    }
    const bare = await hydrated("none-whole", EVERY_TYPE, []);
    refusedInvalid(
      await bare.counts([ids.parent], { backref: "parent-of" }),
      "a count on a copy that holds no edge type whole",
    );
  });

  it("refuses a count of links that reaches an item the copy does not hold, carrying no server code", async () => {
    const slice = await hydrated("gap", [taskType], ["parent-of"]);
    // The parent's children of other types are outside the slice.
    refusedInvalid(
      await slice.counts([ids.parent], { backref: "parent-of" }),
      "a count that reaches the memo and the undeclared-word children",
    );
    // The witness: an anchor whose children are all held is counted.
    expect(
      value(await slice.counts([ids.todo], { backref: "parent-of" })).counts[0]
        ?.total,
    ).toBe(1);
  });
});
