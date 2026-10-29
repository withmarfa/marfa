import { rmSync } from "node:fs";
import { dirname } from "node:path";
import { afterAll, beforeAll, expect, it } from "vitest";
import type { MarfaClient } from "../../client/api.js";
import type { TestContext } from "../../client/types.js";
import { CliDevice, newStore } from "../../device/cli-adapter.js";
import type { Item, Outcome } from "../../device/protocol.js";
import {
  cleanup,
  createTestContext,
  trackEdge,
  trackItem,
  trackView,
} from "../../utils/setup.js";
import { requireBinary } from "./harness.js";

let client: MarfaClient;
let ctx: TestContext;
let device: CliDevice;
let root: string;

interface Case {
  name: string;
  settings: Record<string, unknown>;
  /** The least a listing holds, so a pair of empty answers cannot agree. */
  atLeast: number;
}

const cases: Case[] = [];
const views = new Map<string, string>();

function value<T>(answer: Outcome<T>): T {
  expect(answer.ok, JSON.stringify(answer)).toBe(true);
  if (!answer.ok) throw new Error(answer.refusal.raw);
  return answer.value;
}

async function made(input: Parameters<MarfaClient["createItem"]>[0]) {
  const created = await client.createItem({
    source: ctx.source,
    ...input,
  });
  expect(created.ok, JSON.stringify(created.error)).toBe(true);
  trackItem(ctx, created.data.item.id);
  return created.data.item.id;
}

beforeAll(async () => {
  const context = await createTestContext("device", "views-items");
  ({ client, ctx } = context);
  const mark = ctx.source;
  const probes = [
    -2,
    0.5,
    10,
    true,
    false,
    "10",
    "2",
    "é",
    null,
    undefined,
    {},
    [],
  ];
  const ids: string[] = [];
  for (const [i, probe] of probes.entries()) {
    const type = ["core.note", "core.entity", "core.media.book"][i % 3]!;
    ids.push(
      await made({
        type,
        tags: [mark, i % 3 === 0 ? "0-first" : "z-last"],
        tier: i % 4 === 0 ? "feed" : "library",
        occurred_at:
          i % 2 === 0
            ? "2026-03-29T01:30:00Z"
            : `2026-0${String(1 + (i % 6))}-10T00:00:00Z`,
        properties: {
          ...(type === "core.entity"
            ? { name: i % 2 === 0 ? `Name ${String(i)}` : "Name tie" }
            : {
                title: i % 2 === 0 ? `Title ${String(i)}` : "Title tie",
                body: "",
              }),
          ...(probe === undefined ? {} : { probe }),
        },
      }),
    );
  }
  await made({
    type: "core.note",
    tags: [mark],
    properties: { body: "untitled" },
  });
  const archived = ids[1]!;
  expect((await client.transitionItem(archived, "archived")).ok).toBe(true);

  const parent = await made({
    type: "core.note",
    tags: [mark],
    properties: { title: "Tree root", body: "" },
  });
  root = parent;
  const child = await made({
    type: "core.note",
    tags: [mark],
    properties: { title: "Tree child", body: "" },
  });
  const sibling = await made({
    type: "core.entity",
    tags: [mark],
    properties: { name: "Tree sibling" },
  });
  const grandchild = await made({
    type: "core.note",
    tags: [mark],
    properties: { title: "Tree grandchild", body: "" },
  });
  const trashedChild = await made({
    type: "core.note",
    tags: [mark],
    properties: { title: "Tree trashed", body: "" },
  });
  for (const [from, to] of [
    [parent, child],
    [parent, sibling],
    [child, grandchild],
    [parent, trashedChild],
  ] as const) {
    const edge = await client.createEdge({
      source_id: from,
      target_id: to,
      edge_type: "parent-of",
    });
    expect(edge.ok, JSON.stringify(edge.error)).toBe(true);
    trackEdge(ctx, edge.data.edge.id);
  }
  expect((await client.deleteItem(trashedChild)).ok).toBe(true);

  const filter = `tags contains "${mark}"`;
  const asc = (by: string) => ({ by, direction: "asc" });
  const desc = (by: string) => ({ by, direction: "desc" });
  const add = (
    name: string,
    settings: Record<string, unknown>,
    atLeast = 10,
  ) => {
    const query = {
      filter,
      ...((settings.query as Record<string, unknown> | undefined) ?? {}),
    };
    cases.push({ name, settings: { ...settings, query }, atLeast });
  };
  add("no sort", {});
  add("title ascending", { sort: [asc("title")] });
  add("title descending", { sort: [desc("title")] });
  add("type ascending", { sort: [asc("type")] });
  add("state then title", { sort: [asc("state"), asc("title")] });
  add("tier descending", { sort: [desc("tier")] });
  add("tags ascending", { sort: [asc("tags")] });
  add("tags descending", { sort: [desc("tags")] });
  add("probe ascending", { sort: [asc("properties.probe")] });
  add("probe descending", { sort: [desc("properties.probe")] });
  add("a property no item holds", { sort: [asc("properties.absent")] });
  add("occurred_at ascending", { sort: [asc("occurred_at")] });
  add("occurred_at descending", { sort: [desc("occurred_at")] });
  add("created_at descending", { sort: [desc("created_at")] });
  add("several keys", {
    sort: [asc("tier"), desc("properties.probe"), asc("title"), asc("type")],
  });
  add("ten keys", {
    sort: [
      asc("type"),
      desc("tier"),
      asc("state"),
      asc("tags"),
      desc("title"),
      asc("properties.probe"),
      desc("properties.absent"),
      asc("occurred_at"),
      desc("updated_at"),
      asc("created_at"),
    ],
  });
  add("archived only", { query: { state: ["archived"] } }, 1);
  add("feed only", { query: { tier: "feed" }, sort: [asc("title")] }, 2);
  add(
    "two types with subtypes",
    {
      query: { types: ["core.entity", "core.media"] },
      sort: [asc("title"), desc("type")],
    },
    4,
  );
  add(
    "beneath a parent",
    { query: { beneath: root }, sort: [asc("title")] },
    4,
  );
  add("beneath a leaf", { query: { beneath: grandchild } }, 1);

  for (const item of cases) {
    const saved = await client.createView({
      title: `Parity ${item.name}`,
      ...item.settings,
    });
    expect(saved.ok, `${item.name}: ${JSON.stringify(saved.error)}`).toBe(true);
    views.set(item.name, saved.data.item.id);
    trackView(ctx, saved.data.item.id);
  }
  device = new CliDevice({
    binary: requireBinary(),
    store: newStore("views-items-parity"),
    url: context.apiUrl,
    key: context.apiKey,
  });
  value(
    await device.hydrate(
      ["core.note", "core.entity", "core.media.book", "system.view"],
      "all",
      { edgeTypes: ["parent-of"] },
    ),
  );
});

afterAll(async () => {
  if (device) rmSync(dirname(device.store), { recursive: true, force: true });
  if (ctx) await cleanup(ctx);
});

it("lists a view's items in the order the server does, for each sort and query", async () => {
  for (const item of cases) {
    const id = views.get(item.name)!;
    const remote: string[] = [];
    let cursor: string | undefined;
    do {
      const page = await client.listViewItems(id, { limit: 3, cursor });
      expect(page.ok, `${item.name}: ${JSON.stringify(page.error)}`).toBe(true);
      remote.push(...page.data.data.map((row) => row.id));
      cursor = page.data.next_cursor ?? undefined;
    } while (cursor !== undefined);
    expect(
      remote.length,
      `${item.name}: the server listed too little`,
    ).toBeGreaterThanOrEqual(item.atLeast);
    expect(new Set(remote).size, `${item.name}: an item twice`).toBe(
      remote.length,
    );

    const local: string[] = [];
    for (let offset = 0; offset < remote.length + 4; offset += 4) {
      const page = value(
        await device.attempt([
          "items",
          "list",
          "--view",
          id,
          "--limit",
          "4",
          "--offset",
          String(offset),
        ]),
      ) as { items: Item[] };
      local.push(...page.items.map((row) => row.id));
    }
    expect(local, item.name).toEqual(remote);
  }
});
