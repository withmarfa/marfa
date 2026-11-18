import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import type { AddressInfo } from "node:net";
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
const secretType = `user.counted-secret-${run}`;
const heldLedger = `user.counted-held-${run}`;
const servedLedger = `user.counted-served-${run}`;
const EDGES = ["parent-of", "in-collection"];
const NOT_LISTENING = "http://127.0.0.1:1";
const UNKNOWN_ID = "019537a0-7b80-7000-8000-000000000000";
const NO_GROUPS = {
  not_started: 0,
  in_progress: 0,
  completed: 0,
  canceled: 0,
};

let server: FreshServer;
let owner: MarfaClient;
let hiddenWriter: MarfaClient;
let reader: string;
let shownOnly: string;
let shownSource = "";
let counter = 0;
let proxy: CountsProxy | undefined;
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
    { id: secretType, fields: { title: { type: "string" } } },
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

  const hidden = await owner.createKey({
    label: "device-counts-hidden",
    source: `hidden-${run}`,
    permissions: [],
    type_permissions: { "*": "write" },
    edge_permissions: { "*": "write" },
  });
  expect(hidden.status, JSON.stringify(hidden.error)).toBe(201);
  hiddenWriter = new MarfaClient({
    baseUrl: server.apiUrl,
    apiKey: hidden.data.key,
  });
  reader = await mint("reader", {
    type_permissions: { [taskType]: "read", [memoType]: "read" },
    edge_permissions: { "*": "read" },
  });

  ids.parent = await item(taskType, { title: "parent" });
  shownSource = (await owner.getItem(ids.parent)).data.item.source ?? "";
  shownOnly = await mint("shown-only", {
    type_permissions: { "*": "read" },
    edge_permissions: { "*": "read" },
    enforcement_override: {
      source_filter: {
        types: [taskType, memoType, secretType, driftType],
        sources: [shownSource],
      },
    },
  });
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

  // A parent the key that reads the task type does not read, and a child of it.
  ids.secretParent = await item(secretType, { title: "secret parent" });
  ids.orphan = await item(taskType, { stage: "todo" });
  await link("parent-of", ids.secretParent, ids.orphan);
  // An anchor of a type the key cannot read, and one a source filter hides, each linked to.
  ids.secretAnchor = await item(secretType, { title: "unreadable anchor" });
  ids.pointer = await item(taskType, { stage: "todo" });
  await link("references", ids.pointer, ids.secretAnchor);
  ids.hiddenAnchor = await item(taskType, { stage: "done" }, hiddenWriter);
  ids.pointerToHidden = await item(taskType, { stage: "doing" });
  await link("references", ids.pointerToHidden, ids.hiddenAnchor);
  // Anchors with two linkers, one of a type a narrow copy leaves out.
  ids.secretAnchorTwo = await item(secretType, { title: "second anchor" });
  ids.hiddenAnchorTwo = await item(taskType, { stage: "done" }, hiddenWriter);
  for (const anchor of [ids.secretAnchorTwo, ids.hiddenAnchorTwo]) {
    for (const [type, properties] of [
      [taskType, { stage: "todo" }],
      [memoType, { title: "linker" }],
    ] as [string, Record<string, unknown>][]) {
      await link("references", await item(type, properties), anchor);
    }
  }
  // A task placed in a folder, an edge to an item no slice holds.
  const folder = await owner.createFolder({ title: "counted folder" });
  expect(folder.status, JSON.stringify(folder.error)).toBe(201);
  ids.placed = await item(taskType, { stage: "todo" });
  const placed = await owner.createEdge({
    from_id: ids.placed,
    to_id: folder.data.item.id,
    edge_type: "in-folder",
    properties: { path: "counted.md" },
  });
  expect(placed.status, JSON.stringify(placed.error)).toBe(201);
  // A parent outside a copy of the task type, whose children are tasks.
  ids.outsideParent = await item(memoType, { title: "outside parent" });
  for (const [role, stage] of [
    ["outsideTodo", "todo"],
    ["outsideDone", "done"],
  ]) {
    ids[role] = await item(taskType, { stage });
    await link("parent-of", ids.outsideParent, ids[role]);
  }
  // A parent with a child a source filter hides.
  ids.sourceParent = await item(taskType, { title: "source parent" });
  ids.shownChild = await item(taskType, { stage: "doing" });
  ids.hiddenChild = await item(taskType, { stage: "done" }, hiddenWriter);
  await link("parent-of", ids.sourceParent, ids.shownChild);
  await link("parent-of", ids.sourceParent, ids.hiddenChild);

  ids.held = await item(heldLedger, { title: "three rows" });
  ids.heldEmpty = await item(heldLedger, { title: "no rows" });
  ids.served = await item(servedLedger, { title: "two rows" });
  await rows(ids.held, 3);
  await rows(ids.served, 2);
}, FRESH_SERVER_TIMEOUT_MS);

afterAll(async () => {
  await proxy?.stop();
  await server?.stop();
}, FRESH_SERVER_TIMEOUT_MS);

function value<T>(outcome: Outcome<T>): T {
  expect(outcome.ok, JSON.stringify(outcome)).toBe(true);
  if (!outcome.ok) throw new Error(outcome.refusal.raw);
  return outcome.value;
}

async function mint(
  label: string,
  body: Record<string, unknown>,
): Promise<string> {
  const made = await owner.createKey({
    label: `device-counts-${label}`,
    source: `${label}-${run}`,
    permissions: [],
    ...body,
  } as never);
  expect(made.status, JSON.stringify(made.error)).toBe(201);
  return made.data.key;
}

async function item(
  type: string,
  properties: Record<string, unknown>,
  writer = owner,
): Promise<string> {
  const made = await writer.createItem({ type, properties } as never);
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
  as: MarfaClient = owner,
): Promise<Omit<DeviceCount, "held">[]> {
  const answered = await as.rawRequest<{
    counts: Omit<DeviceCount, "held">[];
  }>("/items/counts", { method: "POST", body: { ids: asked, ...counted } });
  expect(answered.status, JSON.stringify(answered.error)).toBe(200);
  return answered.data.counts;
}

function copyOf(
  label: string,
  url = server.apiUrl,
  store = "",
  key = server.workingKey,
): CliDevice {
  counter += 1;
  return new CliDevice({
    binary: requireBinary(),
    store:
      store === "" ? newStore(`counts-${label}-${String(counter)}`) : store,
    url,
    key,
  });
}

async function hydrated(
  label: string,
  types: string[],
  edgeTypes: string[],
  key = server.workingKey,
  tier: "library" | "all" = "library",
): Promise<CliDevice> {
  const device = copyOf(label, server.apiUrl, "", key);
  value(await device.hydrate(types, tier, { edgeTypes }));
  return device;
}

/** A minted key's client. */
function clientOf(key: string): MarfaClient {
  return new MarfaClient({ baseUrl: server.apiUrl, apiKey: key });
}

type ServedCount = {
  id: string;
  total: number;
  status_groups?: Record<string, number>;
};

/**
 * Passes everything on, rewriting each answer to `POST /items/counts` as
 * `answer` says and the root's `instance_id` to `instance` when set.
 */
class CountsProxy {
  answer:
    | { counts: (counts: ServedCount[]) => ServedCount[] }
    | { status: number; code: string } = { counts: (counts) => counts };
  instance: string | undefined;
  /** The `POST /items/counts` requests passed on. */
  counted = 0;
  /** The `X-Marfa-Instance-Id` of each `POST /items/counts` passed on. */
  named: (string | undefined)[] = [];

  private constructor(
    private readonly listener: Server,
    readonly url: string,
  ) {}

  static async start(): Promise<CountsProxy> {
    const listener = createServer();
    await new Promise<void>((resolve) =>
      listener.listen(0, "127.0.0.1", resolve),
    );
    const { port } = listener.address() as AddressInfo;
    const made = new CountsProxy(listener, `http://127.0.0.1:${String(port)}`);
    listener.on("request", (request, response) => {
      made.pass(request, response).catch(() => response.destroy());
    });
    return made;
  }

  private async pass(
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const headers = new Headers();
    for (const [name, sent] of Object.entries(request.headers)) {
      if (
        sent !== undefined &&
        !["host", "connection", "content-length"].includes(name)
      )
        headers.set(name, Array.isArray(sent) ? sent.join(", ") : sent);
    }
    const path = request.url ?? "/";
    const method = request.method ?? "GET";
    const forwarded = await fetch(`${server.apiUrl}${path}`, {
      method,
      headers,
      body: method === "GET" ? undefined : Buffer.concat(chunks),
    });
    let body = Buffer.from(await forwarded.arrayBuffer());
    let status = forwarded.status;
    if (method === "GET" && path === "/" && this.instance !== undefined) {
      const root = JSON.parse(body.toString("utf8")) as Record<string, unknown>;
      root.instance_id = this.instance;
      body = Buffer.from(JSON.stringify(root));
    }
    if (method === "POST" && path.startsWith("/items/counts")) {
      this.counted += 1;
      const named = request.headers["x-marfa-instance-id"];
      this.named.push(Array.isArray(named) ? named.join(", ") : named);
      const rewrite = this.answer;
      if ("counts" in rewrite) {
        const answer = JSON.parse(body.toString("utf8")) as {
          counts: ServedCount[];
        };
        answer.counts = rewrite.counts(answer.counts);
        body = Buffer.from(JSON.stringify(answer));
      } else {
        status = rewrite.status;
        body = Buffer.from(
          JSON.stringify({
            error: { code: rewrite.code, message: "refused by the proxy" },
          }),
        );
      }
    }
    const answered: Record<string, string> = {};
    forwarded.headers.forEach((sent, name) => {
      if (
        ![
          "connection",
          "content-encoding",
          "content-length",
          "transfer-encoding",
        ].includes(name)
      )
        answered[name] = sent;
    });
    response.writeHead(status, answered);
    response.end(body);
  }

  async stop(): Promise<void> {
    await new Promise<void>((resolve) => this.listener.close(() => resolve()));
  }
}

function refusedNotAnswerable(outcome: Outcome<unknown>, what: string) {
  expect(outcome.ok, `${what} was answered`).toBe(false);
  if (outcome.ok) return;
  const envelope = JSON.parse(outcome.refusal.raw) as {
    error: { code: string; server?: { code: string | null } | null };
  };
  expect(
    [envelope.error.code, envelope.error.server?.code ?? null],
    `${what} was refused as though the server refuses it: ${outcome.refusal.raw}`,
  ).toEqual(["not_answerable", null]);
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

  it("counts the readable items that link to an anchor of a type the credential cannot read, as the server does", async () => {
    const device = await hydrated(
      "edge-anchor",
      [taskType, memoType],
      ["references"],
      reader,
    );
    const asked = [ids.secretAnchor];
    const local = value(await device.counts(asked, { edge: "references" }));
    // The witness: a real item links to the anchor, and the anchor is not in the copy.
    expect(local.counts[0]).toMatchObject({ total: 1, held: true });
    expect(value(await device.list({ type: secretType })).length).toBe(0);
    expect(local.counts.map(({ held: _held, ...rest }) => rest)).toEqual(
      await served(asked, { edge: "references" }, clientOf(reader)),
    );
    // With two linkers and one of them not held, the copy refuses where the server counts 2.
    const two = [ids.secretAnchorTwo];
    const narrow = await hydrated(
      "edge-anchor-narrow",
      [taskType],
      ["references"],
      reader,
    );
    const refused = await narrow.counts(two, { edge: "references" });
    refusedNotAnswerable(
      refused,
      "an anchor with a linker the copy does not hold",
    );
    expect(
      (await served(two, { edge: "references" }, clientOf(reader)))[0]?.total,
    ).toBe(2);
    expect(
      value(await device.counts(two, { edge: "references" })).counts[0]?.total,
    ).toBe(2);
  });

  it("counts the items that link to an anchor the source filter hides, as the server does", async () => {
    const device = await hydrated(
      "edge-anchor-source",
      [taskType],
      ["references"],
      shownOnly,
    );
    const asked = [ids.hiddenAnchor];
    const local = value(await device.counts(asked, { edge: "references" }));
    expect(local.counts[0]).toMatchObject({
      total: 1,
      status_groups: { ...NO_GROUPS, in_progress: 1 },
      held: true,
    });
    expect(local.counts.map(({ held: _held, ...rest }) => rest)).toEqual(
      await served(asked, { edge: "references" }, clientOf(shownOnly)),
    );
    // With two linkers and one of them not held, the copy refuses where the server counts 2.
    const two = [ids.hiddenAnchorTwo];
    const narrow = await hydrated(
      "edge-anchor-source-narrow",
      [taskType],
      ["references"],
      shownOnly,
    );
    refusedNotAnswerable(
      await narrow.counts(two, { edge: "references" }),
      "a hidden anchor with a linker the copy does not hold",
    );
    expect(
      (await served(two, { edge: "references" }, clientOf(shownOnly)))[0]
        ?.total,
    ).toBe(2);
    const wide = await hydrated(
      "edge-anchor-source-wide",
      [taskType, memoType],
      ["references"],
      shownOnly,
    );
    expect(
      value(await wide.counts(two, { edge: "references" })).counts[0]?.total,
    ).toBe(2);
  });

  it("answers a missing and an unreadable anchor of a count of links out and of rows as the server does", async () => {
    const device = await hydrated(
      "anchors",
      [taskType, memoType],
      ["parent-of"],
      reader,
    );
    // The witnesses: the owner counts what the reader is not told of.
    expect(
      (await served([ids.secretParent], { backref: "parent-of" }))[0]?.total,
    ).toBe(1);
    expect((await served([ids.held], { table: "lines" }))[0]?.total).toBe(3);
    const asked = [ids.secretParent, UNKNOWN_ID];
    const links = value(await device.counts(asked, { backref: "parent-of" }));
    expect(links.counts.map(({ id: _id, ...rest }) => rest)).toEqual([
      { total: 0, status_groups: NO_GROUPS, held: true },
      { total: 0, status_groups: NO_GROUPS, held: true },
    ]);
    expect(links.counts.map(({ held: _held, ...rest }) => rest)).toEqual(
      await served(asked, { backref: "parent-of" }, clientOf(reader)),
    );
    const rowsAsked = [ids.held, UNKNOWN_ID];
    const rowCounts = value(await device.counts(rowsAsked, { table: "lines" }));
    expect(rowCounts.counts.map(({ total }) => total)).toEqual([0, 0]);
    expect(rowCounts.counts.map(({ held: _held, ...rest }) => rest)).toEqual(
      await served(rowsAsked, { table: "lines" }, clientOf(reader)),
    );
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

  it("does not count a pinned child the source filter hides, as the server does not", async () => {
    const asked = [ids.sourceParent];
    const counted = { backref: "parent-of" };
    const unfiltered = await hydrated(
      "listed-pin",
      ["*"],
      EDGES,
      server.workingKey,
      "all",
    );
    value(await unfiltered.pin(ids.hiddenChild));
    expect(
      value(await unfiltered.counts(asked, counted)).counts[0]?.total,
    ).toBe(2);
    const device = await hydrated("unlisted", ["*"], EDGES, shownOnly, "all");
    const before = value(await device.counts(asked, counted));
    expect(before.counts[0]?.total).toBe(1);
    // The witness: the pin brings the hidden child into the copy.
    value(await device.pin(ids.hiddenChild));
    expect(value(await device.get(ids.hiddenChild)).id).toBe(ids.hiddenChild);
    const after = value(await device.counts(asked, counted));
    expect(after.counts.map(({ held: _held, ...rest }) => rest)).toEqual(
      await served(asked, counted, clientOf(shownOnly)),
    );
    expect(after.counts[0]?.total).toBe(1);
  });

  it("answers a count of an anchor outside the slice when every item its edges reach is held", async () => {
    const device = await hydrated("held-ends", [taskType], ["parent-of"]);
    const asked = [ids.outsideParent];
    const local = value(await device.counts(asked, { backref: "parent-of" }));
    // The witness: the anchor is not in the copy and two held children are counted.
    expect(value(await device.list({ type: memoType })).length).toBe(0);
    expect(local.counts[0]?.total).toBe(2);
    expect(local.counts.map(({ held: _held, ...rest }) => rest)).toEqual(
      await served(asked, { backref: "parent-of" }),
    );
  });

  it("answers a count that reaches an item the source filter hides when the copy holds every item the credential lists", async () => {
    const asked = [ids.sourceParent];
    const whole = await hydrated(
      "every-listed",
      ["*"],
      EDGES,
      shownOnly,
      "all",
    );
    const local = value(await whole.counts(asked, { backref: "parent-of" }));
    expect(local.counts.map(({ held: _held, ...rest }) => rest)).toEqual(
      await served(asked, { backref: "parent-of" }, clientOf(shownOnly)),
    );
    expect(local.counts[0]?.total).toBe(1);
    const edges = value(await whole.edgesFrom(ids.sourceParent));
    expect(edges.map((edge) => edge.to_id)).toContain(ids.hiddenChild);
    expect(value(await whole.get(ids.shownChild)).id).toBe(ids.shownChild);
    expect(await whole.get(ids.hiddenChild)).toMatchObject({
      ok: false,
      refusal: { code: "not_found", local: "not_held" },
    });
    const narrow = await hydrated(
      "every-listed-narrow",
      [taskType],
      EDGES,
      shownOnly,
    );
    const refused = await narrow.counts(asked, { backref: "parent-of" });
    expect(refused.ok).toBe(false);
  });

  it("answers a count the copy can answer from a closed store with no server and no credential", async () => {
    const store = newStore(`counts-closed-${String(counter)}`);
    const device = copyOf("closed", server.apiUrl, store);
    value(await device.hydrate(EVERY_TYPE, "library", { edgeTypes: EDGES }));
    const closed = new CliDevice({ binary: requireBinary(), store });
    const local = value(
      await closed.counts(linked(), { backref: "parent-of" }),
    ).counts;
    expect(local.map(({ held: _held, ...rest }) => rest)).toEqual(
      await served(linked(), { backref: "parent-of" }),
    );
    // The witness: a count that needs the server is refused with no server named.
    const needs = await closed.counts([ids.served], { table: "lines" });
    expect(needs.ok).toBe(false);
    if (!needs.ok) expect(needs.refusal.code).toBe("no_server");
    // A host the copy holds no table of is the server's to count: 0 with it, none without.
    expect(
      value(await device.counts([UNKNOWN_ID], { table: "lines" })).counts[0],
    ).toMatchObject({ total: 0, held: false });
    const missing = await closed.counts([UNKNOWN_ID], { table: "lines" });
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(missing.refusal.code).toBe("no_server");
  });

  it("refuses a count of rows whose served answer is not the asked ids once each in order, answering no total", async () => {
    const store = newStore(`counts-incomplete-${String(counter)}`);
    const device = copyOf("incomplete", server.apiUrl, store);
    value(await device.hydrate([heldLedger, servedLedger], "library"));
    const asked = [ids.served, ids.held];
    // The witness: asked of the server itself, and through the proxy unchanged, the copy answers both.
    expect(
      value(await device.counts(asked, { table: "lines" })).counts.map(
        (count) => [count.id, count.total],
      ),
    ).toEqual([
      [ids.served, 2],
      [ids.held, 3],
    ]);
    proxy ??= await CountsProxy.start();
    const proxied = copyOf("incomplete", proxy.url, store);
    proxy.answer = { counts: (counts) => counts };
    expect(
      value(await proxied.counts(asked, { table: "lines" })).counts.map(
        (count) => count.total,
      ),
    ).toEqual([2, 3]);
    const rewrites: [string, (counts: ServedCount[]) => ServedCount[]][] = [
      ["missing", (counts) => counts.slice(0, -1)],
      ["reordered", (counts) => [...counts].reverse()],
      ["repeated", (counts) => [counts[0]!, counts[0]!]],
      ["extra", (counts) => [...counts, { id: UNKNOWN_ID, total: 0 }]],
    ];
    for (const [what, rewrite] of rewrites) {
      proxy.answer = { counts: rewrite };
      const refused = await proxied.counts(asked, { table: "lines" });
      expect(refused.ok, `${what}: ${JSON.stringify(refused)}`).toBe(false);
      if (!refused.ok) expect(refused.refusal.code, what).toBe("decoding");
    }
    proxy.answer = { counts: (counts) => counts };
  });

  it("refuses a count of rows the server fails with the failure's own code, never not_answerable", async () => {
    const store = newStore(`counts-failed-${String(counter)}`);
    const device = copyOf("failed", server.apiUrl, store);
    value(await device.hydrate([heldLedger, servedLedger], "library"));
    // The witness: the same count is answered by the server, and a count the copy cannot answer is not_answerable.
    expect(
      value(await device.counts([ids.served], { table: "lines" })).counts[0],
    ).toMatchObject({ total: 2, held: false });
    refusedNotAnswerable(
      await device.counts([ids.parent], { backref: "parent-of" }),
      "a count of an edge type the copy does not hold",
    );
    proxy ??= await CountsProxy.start();
    const proxied = copyOf("failed", proxy.url, store);
    for (const [status, code] of [
      [429, "rate_limited"],
      [401, "unauthorized"],
      [403, "forbidden"],
      [503, "server"],
    ] as const) {
      proxy.answer = { status, code: status === 503 ? "unavailable" : code };
      const refused = await proxied.counts([ids.served], { table: "lines" });
      expect(refused.ok, JSON.stringify(refused)).toBe(false);
      if (!refused.ok) expect(refused.refusal.code, String(status)).toBe(code);
    }
    proxy.answer = { counts: (counts) => counts };
    const unreachable = await copyOf("failed", NOT_LISTENING, store).counts(
      [ids.served],
      { table: "lines" },
    );
    expect(unreachable.ok).toBe(false);
    if (!unreachable.ok) expect(unreachable.refusal.code).toBe("network");
  });

  it("asks its own server for every count when told to, refusing an answer whose status groups do not fit the count", async () => {
    const store = newStore(`counts-from-server-${String(counter)}`);
    const device = copyOf("from-server", server.apiUrl, store);
    value(await device.hydrate([taskType], "library"));
    // The witness: the copy, holding no edge type whole, cannot answer the count itself.
    refusedNotAnswerable(
      await device.counts([ids.parent], { backref: "parent-of" }),
      "a count of an edge type the copy does not hold",
    );
    const asked = [ids.parent, ids.lone, ids.parent];
    const remote = await served(asked, { backref: "parent-of" });
    expect(
      value(
        await device.counts(
          asked,
          { backref: "parent-of" },
          { fromServer: true },
        ),
      ).counts,
    ).toEqual(remote.map((count) => ({ ...count, held: false })));
    expect(
      value(
        await device.counts(
          [ids.held],
          { table: "lines" },
          { fromServer: true },
        ),
      ).counts,
    ).toEqual([{ id: ids.held, total: 3, held: false }]);
    proxy ??= await CountsProxy.start();
    const proxied = copyOf("from-server", proxy.url, store);
    const rewrites: [
      string,
      Counted,
      (counts: ServedCount[]) => ServedCount[],
    ][] = [
      [
        "reordered",
        { backref: "parent-of" },
        (counts) => [...counts].reverse(),
      ],
      [
        "a link without status groups",
        { backref: "parent-of" },
        (counts) => counts.map(({ id, total }) => ({ id, total })),
      ],
      [
        "rows with status groups",
        { table: "lines" },
        (counts) =>
          counts.map((count) => ({ ...count, status_groups: NO_GROUPS })),
      ],
    ];
    for (const [what, counted, rewrite] of rewrites) {
      proxy.answer = { counts: rewrite };
      const refused = await proxied.counts([ids.parent, ids.held], counted, {
        fromServer: true,
      });
      expect(refused.ok, `${what}: ${JSON.stringify(refused)}`).toBe(false);
      if (!refused.ok) expect(refused.refusal.code, what).toBe("decoding");
    }
    proxy.answer = { counts: (counts) => counts };
  });

  it("asks the server under the key the copy is opened with now, not the one it was hydrated with", async () => {
    const store = newStore(`counts-key-${String(counter)}`);
    value(
      await copyOf("key", server.apiUrl, store).hydrate([taskType], "library"),
    );
    const asked = [ids.parent];
    const counted = { backref: "parent-of" } as const;
    const asOwner = await served(asked, counted);
    const asReader = await served(asked, counted, clientOf(reader));
    // The witness: the two keys get different answers, so the answer tells which key was sent.
    expect(asReader[0]?.total).not.toBe(asOwner[0]?.total);
    expect(
      value(
        await copyOf("key", server.apiUrl, store, reader).counts(
          asked,
          counted,
          { fromServer: true },
        ),
      ).counts,
    ).toEqual(asReader.map((count) => ({ ...count, held: false })));
  });

  it("sends no id to a server at another origin that answers as an instance other than its copy's", async () => {
    proxy ??= await CountsProxy.start();
    proxy.answer = { counts: (counts) => counts };
    const atAnotherOrigin = async (label: string) => {
      const store = newStore(`counts-${label}-${String(counter)}`);
      value(
        await copyOf(label, server.apiUrl, store).hydrate(
          [taskType],
          "library",
        ),
      );
      return copyOf(label, proxy!.url, store);
    };
    const ask = (copy: CliDevice) =>
      copy.counts([ids.parent], { backref: "parent-of" }, { fromServer: true });
    // The witness: a copy at another origin whose server answers as its instance asks it.
    const before = proxy.counted;
    value(await ask(await atAnotherOrigin("moved-same")));
    expect(proxy.counted).toBe(before + 1);
    const moved = await atAnotherOrigin("moved-other");
    proxy.instance = UNKNOWN_ID;
    try {
      const refused = await ask(moved);
      expect(refused.ok, JSON.stringify(refused)).toBe(false);
      if (!refused.ok) expect(refused.refusal.code).toBe("wrong_server");
      expect(
        proxy.counted,
        "an id reached a server that is not the copy's",
      ).toBe(before + 1);
    } finally {
      proxy.instance = undefined;
    }
  });

  it("sends no id to another instance that takes the copy's own address, and names its instance on each count", async () => {
    proxy ??= await CountsProxy.start();
    proxy.answer = { counts: (counts) => counts };
    const instance = (
      (await (await fetch(`${server.apiUrl}/`)).json()) as {
        instance_id: string;
      }
    ).instance_id;
    const cases: [string, Counted, string, string[]][] = [
      ["links", { backref: "parent-of" }, ids.parent, [taskType]],
      ["rows", { table: "lines" }, ids.served, [heldLedger, servedLedger]],
    ];
    for (const [what, counted, id, types] of cases) {
      const store = newStore(`counts-same-address-${what}-${String(counter)}`);
      value(await copyOf(what, server.apiUrl, store).hydrate(types, "library"));
      // The copy follows its instance to the proxy's address, and records it as its own.
      const device = copyOf(what, proxy.url, store);
      const ask = () =>
        device.counts(
          [id],
          counted,
          "table" in counted ? undefined : { fromServer: true },
        );
      // The witness: the instance the copy was built from is asked, and named on the request.
      const before = proxy.counted;
      const answered = value(await ask()).counts;
      expect(answered[0], what).toMatchObject({ id, held: false });
      expect(proxy.counted, what).toBe(before + 1);
      expect(proxy.named.at(-1), what).toBe(instance);
      proxy.instance = UNKNOWN_ID;
      try {
        const refused = await ask();
        expect(refused.ok, `${what}: ${JSON.stringify(refused)}`).toBe(false);
        if (!refused.ok)
          expect(refused.refusal.code, what).toBe("copy_expired");
        expect(
          proxy.counted,
          `${what}: an id reached another instance at the copy's address`,
        ).toBe(before + 1);
      } finally {
        proxy.instance = undefined;
      }
    }
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
      refusedNotAnswerable(
        await device.counts([ids.collection], counted),
        JSON.stringify(counted),
      );
    }
    // Whichever the id: an id no item holds is refused too, where the held type answers 0.
    refusedNotAnswerable(
      await device.counts([UNKNOWN_ID], { backref: "in-collection" }),
      "a count of an id no item holds",
    );
    expect(
      value(await device.counts([UNKNOWN_ID], { backref: "parent-of" }))
        .counts[0],
    ).toMatchObject({ total: 0, held: true });
    const bare = await hydrated("none-whole", EVERY_TYPE, []);
    refusedNotAnswerable(
      await bare.counts([ids.parent], { backref: "parent-of" }),
      "a count on a copy that holds no edge type whole",
    );
  });

  it("refuses a count of links that reaches an item the copy does not hold, carrying no server code", async () => {
    const slice = await hydrated("gap", [taskType], ["parent-of"]);
    // The parent's children of other types are outside the slice.
    refusedNotAnswerable(
      await slice.counts([ids.parent], { backref: "parent-of" }),
      "a count that reaches the memo and the undeclared-word children",
    );
    // The witness: an anchor whose children are all held is counted.
    expect(
      value(await slice.counts([ids.todo], { backref: "parent-of" })).counts[0]
        ?.total,
    ).toBe(1);
  });

  it("refuses a count the copy could answer when its slice names every type one by one and a source filter hides a child", async () => {
    const asked = [ids.sourceParent];
    const counted = { backref: "parent-of" };
    const types = await owner.listTypes();
    expect(types.status, JSON.stringify(types.error)).toBe(200);
    const named = types.data.data
      .map((type) => type.id)
      .filter((id) => !id.startsWith("system."));
    const each = await hydrated("each-type", named, EDGES, shownOnly, "all");
    refusedNotAnswerable(
      await each.counts(asked, counted),
      "a slice that names every type one by one",
    );
    // The witnesses: the server counts 1, and the slice that names `*` answers it.
    expect((await served(asked, counted, clientOf(shownOnly)))[0]?.total).toBe(
      1,
    );
    const star = await hydrated(
      "each-type-star",
      ["*"],
      EDGES,
      shownOnly,
      "all",
    );
    expect(value(await star.counts(asked, counted)).counts[0]?.total).toBe(1);
  });

  it("refuses a count the copy could answer when an edge reaches a system folder and the slice is narrow", async () => {
    const asked = [ids.placed];
    const counted = { backref: "in-folder" };
    const narrow = await hydrated("folder-narrow", [taskType], ["in-folder"]);
    refusedNotAnswerable(
      await narrow.counts(asked, counted),
      "a narrow copy with an edge to a system folder",
    );
    // The witnesses: the server counts 0, and a slice that names `*` answers it.
    expect((await served(asked, counted))[0]?.total).toBe(0);
    const star = await hydrated(
      "folder-star",
      ["*"],
      ["in-folder"],
      server.workingKey,
      "all",
    );
    expect(value(await star.counts(asked, counted)).counts[0]).toMatchObject({
      total: 0,
      held: true,
    });
  });
});
