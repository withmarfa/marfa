import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MarfaClient } from "../../client/api.js";
import {
  approvedAppToken,
  bootFreshServer,
  FRESH_SERVER_TIMEOUT_MS,
  type FreshServer,
} from "../../utils/fresh-server.js";
import { expectMatchesSchema } from "../../utils/openapi.js";
import { newRunId } from "../../utils/setup.js";

interface Count {
  id: string;
  total: number;
  status_groups?: Record<string, number>;
}

const NO_GROUPS = {
  not_started: 0,
  in_progress: 0,
  completed: 0,
  canceled: 0,
};
const UNKNOWN_ID = "019537a0-7b80-7000-8000-000000000000";
const WORDS = [
  { value: "todo", group: "not_started" },
  { value: "doing", group: "in_progress" },
  { value: "done", group: "completed" },
  { value: "dropped", group: "canceled" },
];

let server: FreshServer;
let owner: MarfaClient;
let hiddenWriter: MarfaClient;
let shownSource: string;
const run = newRunId()
  .replaceAll(/[^a-z0-9]/gi, "")
  .toLowerCase();
const taskType = `user.counts-task-${run}`;
const memoType = `user.counts-memo-${run}`;
const secretType = `user.counts-secret-${run}`;
const driftType = `user.counts-drift-${run}`;
const ledgerType = `user.counts-ledger-${run}`;

/** What the seed made, by role. */
const ids: Record<string, string> = {};

beforeAll(async () => {
  server = await bootFreshServer("item-counts");
  owner = new MarfaClient({
    baseUrl: server.apiUrl,
    apiKey: server.workingKey,
  });
  const status = { type: "status", status_values: WORDS };
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
    {
      id: ledgerType,
      fields: { title: { type: "string" } },
      tables: { lines: { columns: { amount: { type: "number" } } } },
    },
  ]) {
    const made = await owner.registerType(schema as never);
    expect(made.status, JSON.stringify(made.error)).toBe(201);
  }

  const hidden = await owner.createKey({
    label: "item-counts-hidden",
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

  ids.parent = await item(taskType, { title: "parent" });
  const shown = await owner.getItem(ids.parent);
  shownSource = shown.data.item.source ?? "";

  const children: [string, string, Record<string, unknown>][] = [
    ["todo", taskType, { stage: "todo" }],
    ["doing", taskType, { stage: "doing" }],
    ["done", taskType, { stage: "done" }],
    ["dropped", taskType, { stage: "dropped" }],
    ["valueless", taskType, {}],
    ["memo", memoType, { title: "no status field" }],
    ["secret", secretType, { title: "unreadable type" }],
    ["trashed", taskType, { stage: "todo" }],
    ["archived", taskType, { stage: "done" }],
  ];
  for (const [role, type, properties] of children) {
    ids[role] = await item(type, properties);
    await link("parent-of", ids.parent, ids[role]);
  }
  ids.hidden = await item(taskType, { stage: "done" }, hiddenWriter);
  await link("parent-of", ids.parent, ids.hidden);

  // A word the type no longer declares: the item keeps it.
  ids.drifted = await item(driftType, { stage: "waiting" });
  await link("parent-of", ids.parent, ids.drifted);
  const dropped = await owner.replaceType(driftType, {
    id: driftType,
    fields: { stage: status },
  } as never);
  expect(dropped.status, JSON.stringify(dropped.error)).toBe(200);

  expect((await owner.deleteItem(ids.trashed)).ok).toBe(true);
  expect((await owner.transitionItem(ids.archived, "archived")).ok).toBe(true);

  // The same count under the other direction, and an edge from an unreadable item.
  ids.collection = await item("core.collection", { title: "members" });
  for (const [role, stage] of [
    ["memberTodo", "todo"],
    ["memberDone", "done"],
  ]) {
    ids[role] = await item(taskType, { stage });
    await link("in-collection", ids[role], ids.collection);
  }
  ids.target = await item(taskType, { stage: "todo" });
  ids.fromSecret = await item(secretType, { title: "from" });
  ids.fromTask = await item(taskType, { stage: "doing" });
  await link("references", ids.fromSecret, ids.target);
  await link("references", ids.fromTask, ids.target);
  ids.secretParent = await item(secretType, { title: "secret parent" });
  ids.orphan = await item(taskType, { stage: "todo" });
  ids.secretAnchor = await item(secretType, { title: "unreadable anchor" });
  ids.pointer = await item(taskType, { stage: "todo" });
  await link("references", ids.pointer, ids.secretAnchor);
  ids.hiddenAnchor = await item(taskType, { stage: "done" }, hiddenWriter);
  ids.pointerToHidden = await item(taskType, { stage: "doing" });
  await link("references", ids.pointerToHidden, ids.hiddenAnchor);
  ids.hiddenTarget = await item(taskType, { stage: "todo" });
  await link("references", ids.hiddenAnchor, ids.hiddenTarget);
  await link("parent-of", ids.secretParent, ids.orphan);

  ids.ledger = await item(ledgerType, { title: "three rows" });
  await rows(ids.ledger, 3);
  ids.emptyLedger = await item(ledgerType, { title: "no rows" });
  ids.binnedLedger = await item(ledgerType, { title: "binned" });
  await rows(ids.binnedLedger, 2);
  expect((await owner.deleteItem(ids.binnedLedger)).ok).toBe(true);
}, FRESH_SERVER_TIMEOUT_MS);

afterAll(async () => {
  await server?.stop();
}, FRESH_SERVER_TIMEOUT_MS);

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

async function mint(label: string, body: Record<string, unknown>) {
  const made = await owner.createKey({
    label: `item-counts-${label}`,
    source: `${label}-${run}`,
    permissions: [],
    ...body,
  } as never);
  expect(made.status, JSON.stringify(made.error)).toBe(201);
  return new MarfaClient({ baseUrl: server.apiUrl, apiKey: made.data.key });
}

function ask(
  as: MarfaClient,
  body: Record<string, unknown>,
  headers?: Record<string, string>,
) {
  return as.rawRequest<{ counts: Count[] }>("/items/counts", {
    method: "POST",
    body,
    headers,
  });
}

async function counts(
  as: MarfaClient,
  body: Record<string, unknown>,
): Promise<Count[]> {
  const answered = await ask(as, body);
  expect(answered.status, JSON.stringify(answered.error)).toBe(200);
  await expectMatchesSchema("POST", "/items/counts", 200, answered.data);
  return answered.data.counts;
}

async function listed(filter: string, as = owner): Promise<number> {
  const found = await as.rawRequest<{ data: unknown[] }>(
    `/items?limit=200&filter=${encodeURIComponent(filter)}`,
  );
  expect(found.status, JSON.stringify(found.error)).toBe(200);
  return found.data.data.length;
}

const groups = (
  not_started: number,
  in_progress: number,
  completed: number,
) => ({
  not_started,
  in_progress,
  completed,
  canceled: NO_GROUPS.canceled,
});

describe("POST /items/counts", () => {
  it("counts what each anchor links, by status group, and equals the listing", async () => {
    const [answer] = await counts(owner, {
      ids: [ids.parent],
      backref: "parent-of",
    });
    expect(answer).toEqual({
      id: ids.parent,
      total: 9,
      status_groups: { ...groups(1, 1, 2), canceled: 1 },
    });

    const filter = `backref[parent-of] eq "${ids.parent}"`;
    expect(await listed(filter)).toBe(answer?.total);
    for (const [group, count] of Object.entries(answer?.status_groups ?? {})) {
      expect(await listed(`${filter} AND status_group eq "${group}"`)).toBe(
        count,
      );
    }
    const binned = await owner.rawRequest<{ data: unknown[] }>(
      `/items?state=trashed&filter=${encodeURIComponent(filter)}`,
    );
    expect(binned.data.data).toHaveLength(1);
  });

  it("counts the items that link to an anchor as well as the items it links to", async () => {
    const [members, ofMember] = await counts(owner, {
      ids: [ids.collection, ids.memberTodo],
      edge: "in-collection",
    });
    expect(members).toEqual({
      id: ids.collection,
      total: 2,
      status_groups: groups(1, 0, 1),
    });
    expect(ofMember).toEqual({
      id: ids.memberTodo,
      total: 0,
      status_groups: NO_GROUPS,
    });
    const [collections] = await counts(owner, {
      ids: [ids.memberTodo],
      backref: "in-collection",
    });
    expect(collections).toEqual({
      id: ids.memberTodo,
      total: 1,
      status_groups: NO_GROUPS,
    });
    expect(await listed(`edge[in-collection] eq "${ids.collection}"`)).toBe(2);
  });

  it("counts only what the credential reads, through the edges it reads, under its source filter", async () => {
    const reader = await mint("no-secret", {
      type_permissions: { [taskType]: "read", [memoType]: "read" },
      edge_permissions: { "*": "read" },
    });
    // The secret child and the drifted child's type drop out.
    const [kept] = await counts(reader, {
      ids: [ids.parent],
      backref: "parent-of",
    });
    expect(kept?.total).toBe(7);
    expect(kept?.status_groups).toEqual({ ...groups(1, 1, 2), canceled: 1 });

    // An edge from an unreadable item is not counted; the owner counts both.
    const [fromBoth] = await counts(owner, {
      ids: [ids.target],
      edge: "references",
    });
    expect(fromBoth?.total).toBe(2);
    const [fromReadable] = await counts(reader, {
      ids: [ids.target],
      edge: "references",
    });
    expect(fromReadable?.total).toBe(1);
    expect(fromReadable?.status_groups).toEqual(groups(0, 1, 0));

    const shownOnly = await mint("shown-source", {
      type_permissions: { "*": "read" },
      edge_permissions: { "*": "read" },
      enforcement_override: {
        source_filter: {
          types: [taskType, memoType, secretType, driftType],
          sources: [shownSource],
        },
      },
    });
    const [shown] = await counts(shownOnly, {
      ids: [ids.parent],
      backref: "parent-of",
    });
    // The owner's count minus the child a hidden source wrote.
    expect(shown?.total).toBe(8);
    expect(shown?.status_groups).toEqual({ ...groups(1, 1, 1), canceled: 1 });
  });

  it("counts the readable items that link to an anchor the credential cannot read, as the listing does", async () => {
    const reader = await mint("no-secret-anchor", {
      type_permissions: { [taskType]: "read" },
      edge_permissions: { "*": "read" },
    });
    const body = { ids: [ids.secretAnchor], edge: "references" };
    const [byOwner] = await counts(owner, body);
    const [byReader] = await counts(reader, body);
    expect(byOwner?.total).toBe(1);
    expect(byReader).toEqual({
      id: ids.secretAnchor,
      total: 1,
      status_groups: groups(1, 0, 0),
    });
    expect(
      await listed(`edge[references] eq "${ids.secretAnchor}"`, reader),
    ).toBe(byReader?.total);
  });

  it("counts through an anchor the source filter hides exactly as the listing does", async () => {
    const shownOnly = await mint("shown-anchor", {
      type_permissions: { "*": "read" },
      edge_permissions: { "*": "read" },
      enforcement_override: {
        source_filter: { types: [taskType], sources: [shownSource] },
      },
    });
    const [linked] = await counts(shownOnly, {
      ids: [ids.hiddenAnchor],
      edge: "references",
    });
    expect(linked?.total).toBe(1);
    expect(linked?.status_groups).toEqual(groups(0, 1, 0));
    expect(
      await listed(`edge[references] eq "${ids.hiddenAnchor}"`, shownOnly),
    ).toBe(linked?.total);

    // The witness: without the source filter the anchor's own edge counts.
    const leavingFilter = `backref[references] eq "${ids.hiddenAnchor}"`;
    const [leavingByOwner] = await counts(owner, {
      ids: [ids.hiddenAnchor],
      backref: "references",
    });
    expect(leavingByOwner?.total).toBe(1);
    expect(await listed(leavingFilter)).toBe(1);

    const [leaving] = await counts(shownOnly, {
      ids: [ids.hiddenAnchor],
      backref: "references",
    });
    expect(leaving).toEqual({
      id: ids.hiddenAnchor,
      total: 0,
      status_groups: NO_GROUPS,
    });
    expect(await listed(leavingFilter, shownOnly)).toBe(0);
  });

  it("answers a missing and an unreadable anchor alike for backref and for tables", async () => {
    const reader = await mint("no-secret-no-ledger", {
      type_permissions: { [taskType]: "read" },
      edge_permissions: { "*": "read" },
    });
    // The witnesses: the owner counts what the reader is not told of.
    const [secretLinks] = await counts(owner, {
      ids: [ids.secretParent],
      backref: "parent-of",
    });
    expect(secretLinks?.total).toBeGreaterThanOrEqual(1);
    const [ledgerRows] = await counts(owner, {
      ids: [ids.ledger],
      table: "lines",
    });
    expect(ledgerRows?.total).toBeGreaterThanOrEqual(1);

    for (const [body, anchor] of [
      [{ backref: "parent-of" }, ids.secretParent],
      [{ table: "lines" }, ids.ledger],
    ] as const) {
      const [unreadable, missing] = await counts(reader, {
        ids: [anchor, UNKNOWN_ID],
        ...body,
      });
      expect({ ...unreadable, id: "" }, JSON.stringify(body)).toEqual({
        ...missing,
        id: "",
      });
      expect(unreadable?.total, JSON.stringify(body)).toBe(0);
      if ("backref" in body) {
        expect(unreadable?.status_groups).toEqual(NO_GROUPS);
        expect(missing?.status_groups).toEqual(NO_GROUPS);
      }
    }
  });

  it("counts a table's rows, and answers 0 for a table the type does not declare", async () => {
    const answers = await counts(owner, {
      ids: [ids.ledger, ids.emptyLedger, ids.binnedLedger, ids.parent],
      table: "lines",
    });
    expect(answers).toEqual([
      { id: ids.ledger, total: 3 },
      { id: ids.emptyLedger, total: 0 },
      { id: ids.binnedLedger, total: 0 },
      { id: ids.parent, total: 0 },
    ]);
  });

  it("answers in request order, once for a repeated id, and refuses more than 100 ids", async () => {
    const answers = await counts(owner, {
      ids: [ids.collection, UNKNOWN_ID, ids.parent, ids.collection],
      backref: "parent-of",
    });
    expect(answers.map((a) => a.id)).toEqual([
      ids.collection,
      UNKNOWN_ID,
      ids.parent,
    ]);

    const hundred = Array.from(
      { length: 100 },
      (_, n) => `019537a0-7b80-7000-8000-${String(n).padStart(12, "0")}`,
    );
    expect(
      await counts(owner, { ids: hundred, edge: "parent-of" }),
    ).toHaveLength(100);
    const over = await ask(owner, {
      ids: [...hundred, UNKNOWN_ID],
      edge: "parent-of",
    });
    expect(over.status).toBe(400);
    expect(over.error?.error.code).toBe("validation_error");
    expect(over.error?.error.details).toMatchObject({
      cap: 100,
      provided: 101,
    });
  });

  it("refuses a request that does not name what to count, with the codes the other doors use", async () => {
    const witness = await ask(owner, {
      ids: [ids.parent],
      backref: "parent-of",
    });
    expect(witness.status).toBe(200);

    const refused: [Record<string, unknown>, number, string][] = [
      [{ backref: "parent-of" }, 400, "missing_required_field"],
      [{ ids: "one", backref: "parent-of" }, 400, "validation_error"],
      [{ ids: ["not-an-id"], backref: "parent-of" }, 400, "invalid_id"],
      [{ ids: [ids.parent] }, 400, "validation_error"],
      [
        { ids: [ids.parent], backref: "parent-of", edge: "parent-of" },
        400,
        "validation_error",
      ],
      [
        { ids: [ids.parent], backref: "parent-of", table: "lines" },
        400,
        "validation_error",
      ],
      [{ ids: [ids.parent], backref: "has space" }, 400, "validation_error"],
      [{ ids: [ids.parent], edge: "closing]" }, 400, "validation_error"],
      [{ ids: [ids.parent], table: "Lines" }, 400, "validation_error"],
      [
        { ids: [ids.parent], backref: "parent-of", filter: "x" },
        400,
        "validation_error",
      ],
    ];
    for (const [body, status, code] of refused) {
      const answered = await ask(owner, body);
      expect(answered.status, JSON.stringify(body)).toBe(status);
      expect(answered.error?.error.code, JSON.stringify(body)).toBe(code);
    }

    const nothing = await mint("reads-nothing", {
      type_permissions: {},
      edge_permissions: { "*": "read" },
    });
    const none = await ask(nothing, {
      ids: [ids.parent],
      backref: "parent-of",
    });
    expect(none.status).toBe(403);
    expect(none.error?.error.code).toBe("type_not_permitted");

    const noEdges = await mint("reads-no-edges", {
      type_permissions: { "*": "read" },
      edge_permissions: {},
    });
    const edgeless = await ask(noEdges, {
      ids: [ids.parent],
      backref: "parent-of",
    });
    expect(edgeless.status).toBe(403);
    expect(edgeless.error?.error.code).toBe("edge_type_not_permitted");
    // The witness: rows need no edge.
    expect(
      await counts(noEdges, { ids: [ids.ledger], table: "lines" }),
    ).toEqual([{ id: ids.ledger, total: 3 }]);
  });

  it("is a read, open to a read-only key and to an app token for chosen types, and takes no reach header", async () => {
    const readOnly = await mint("read-only", {
      type_permissions: { "*": "read" },
      edge_permissions: { "*": "read" },
    });
    const [byKey] = await counts(readOnly, {
      ids: [ids.parent],
      backref: "parent-of",
    });
    expect(byKey?.total).toBe(9);

    const token = await approvedAppToken(server, [
      `${taskType}:read`,
      "edge.parent-of:read",
    ]);
    const app = new MarfaClient({ baseUrl: server.apiUrl, apiKey: token });
    const [byApp] = await counts(app, {
      ids: [ids.parent],
      backref: "parent-of",
    });
    // Only the chosen type: the memo, secret and drifted children are not counted.
    expect(byApp?.total).toBe(6);
    expect(byApp?.status_groups).toEqual({ ...groups(1, 1, 2), canceled: 1 });

    const withReach = await ask(
      owner,
      { ids: [ids.parent], backref: "parent-of" },
      { "X-Marfa-Reach": "any" },
    );
    expect(withReach.status).toBe(400);
    expect(withReach.error?.error.code).toBe("validation_error");
  });
});
