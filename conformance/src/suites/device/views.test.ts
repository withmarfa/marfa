import { spawnSync } from "node:child_process";
import { afterEach, expect, it } from "vitest";
import {
  catchupTooOld,
  connected,
  copyReplay,
  copyStreamCursor,
  typeCatalog,
  type WireItemOptions,
} from "../../device/marfa-answers.js";
import type { Item, Outcome } from "../../device/protocol.js";
import type { Answer } from "../../device/scripted-server.js";
import {
  requireBinary,
  scriptHydration,
  startHarness,
  type Harness,
} from "./harness.js";

let harness: Harness | undefined;
const VIEW = "01a00000-0000-7000-8000-00000000face";
const id = (n: number) =>
  `01a00000-0000-7000-8000-${n.toString().padStart(12, "0")}`;
type Group = { key: unknown; count: number };
type Settings = Record<string, unknown>;

afterEach(async () => {
  await harness?.stop();
  harness = undefined;
});

function value<T>(answer: Outcome<T>): T {
  expect(answer.ok, JSON.stringify(answer)).toBe(true);
  if (!answer.ok) throw new Error(answer.refusal.raw);
  return answer.value;
}

async function copy(
  items: Array<{ item: WireItemOptions; tags?: string[] }>,
  settings: Settings,
  options: {
    query?: Record<string, unknown>;
    whole?: string[];
    slice?: string[];
    tier?: "library" | "all";
    partial?: boolean;
    replay?: (cursor: string) => Answer;
  } = {},
) {
  await harness?.stop();
  harness = await startHarness("views");
  scriptHydration(harness.server, {
    head: "1",
    rows: {
      "system.view": [
        {
          item: {
            id: VIEW,
            type: "system.view",
            properties: {
              title: "Offline view",
              query: { types: ["core.note"], ...options.query },
              ...settings,
            },
          },
        },
      ],
      "core.note": items.filter(
        ({ item }) => !item.type || item.type === "core.note",
      ),
      "core.task": items.filter(({ item }) => item.type === "core.task"),
    },
    catalog: typeCatalog([
      { id: "system.view", version: 0, fields: {} },
      { id: "core.task", version: 0, fields: {} },
    ]),
    edges: {
      references: [
        { id: id(101), source_id: id(1), target_id: id(2) },
        { id: id(102), source_id: id(1), target_id: id(3) },
        { id: id(103), source_id: id(2), target_id: id(3) },
      ],
    },
    ...(options.replay ? { replay: options.replay } : {}),
    ...(options.partial
      ? { pageSize: 1, drop: (offset: number) => offset > 0 }
      : {}),
  });
  const hydrated = await harness.device.hydrate(
    options.slice ?? ["system.view", "core.note"],
    options.tier ?? "all",
    { edgeTypes: options.whole ?? [] },
  );
  if (options.partial) expect(hydrated.ok).toBe(false);
  else value(hydrated);
  return harness.device;
}

async function listed(page: string[] = []): Promise<string[]> {
  const answer = value(
    await harness!.device.attempt(["items", "list", "--view", VIEW, ...page]),
  ) as { completeness: string; items: Item[] };
  expect(answer.completeness).toBe("complete");
  return answer.items.map((item) => item.id);
}

async function groups(zone?: string): Promise<Group[]> {
  const answer = value(
    await harness!.device.attempt([
      "views",
      "groups",
      VIEW,
      ...(zone ? ["--time-zone", zone] : []),
    ]),
  ) as { completeness: string; groups: Group[] };
  expect(answer.completeness).toBe("complete");
  return answer.groups;
}

it("reads the saved views and their settings offline", async () => {
  const settings = { sort: [{ by: "title", direction: "asc" }] };
  const device = await copy([{ item: { id: id(1) } }], settings);
  const requests = harness!.server.requests.length;
  const views = value(await device.attempt(["views", "list"])) as {
    views: Array<{ id: string }>;
  };
  expect(views.views.map((view) => view.id)).toEqual([VIEW]);
  expect(value(await device.attempt(["views", "get", VIEW]))).toMatchObject({
    id: VIEW,
    state: "active",
    settings: { title: "Offline view", ...settings },
  });
  expect(await listed()).toEqual([id(1)]);
  expect(harness!.server.requests).toHaveLength(requests);
});

it.each(["asc", "desc"])(
  "orders mixed property scalars and missing values %s with ascending ID ties",
  async (direction) => {
    const values = [
      10,
      "2",
      null,
      false,
      0,
      true,
      1,
      "",
      {},
      [],
      undefined,
      -2,
      "é",
    ];
    await copy(
      values.map((probe, index) => ({
        item: {
          id: id(index + 1),
          properties: probe === undefined ? {} : { probe },
        },
      })),
      { sort: [{ by: "properties.probe", direction }] },
    );
    const ordered =
      direction === "asc"
        ? [12, 4, 5, 6, 7, 1, 8, 2, 13]
        : [13, 2, 8, 1, 6, 7, 4, 5, 12];
    const expected = [...ordered, 3, 9, 10, 11].map(id);
    expect(await listed()).toEqual(expected);
    const paged: string[] = [];
    for (let offset = 0; offset < values.length; offset += 3)
      paged.push(
        ...(await listed(["--limit", "3", "--offset", String(offset)])),
      );
    expect(paged).toEqual(expected);
  },
);

it("orders several keys in their declared order and accepts a field no item has", async () => {
  const items = [
    { item: { id: id(1), properties: { team: "b", rank: 1 } } },
    { item: { id: id(2), properties: { team: "a", rank: 1 } } },
    { item: { id: id(3), properties: { team: "a", rank: 2 } } },
    { item: { id: id(4), properties: { team: "a" } } },
  ];
  await copy(items, {
    sort: [
      { by: "properties.team", direction: "asc" },
      { by: "properties.rank", direction: "desc" },
    ],
  });
  expect(await listed()).toEqual([3, 2, 4, 1].map(id));
  await copy(items, {
    sort: [{ by: "properties.absent", direction: "desc" }],
  });
  expect(await listed()).toEqual([1, 2, 3, 4].map(id));
});

it.each([
  "created_at",
  "updated_at",
  "occurred_at",
  "title",
  "type",
  "state",
  "tier",
  "tags",
])("sorts the own field %s", async (by) => {
  const times = [
    "2026-01-03T00:00:00Z",
    "2026-01-01T00:00:00Z",
    "2026-01-02T00:00:00Z",
  ];
  await copy(
    [1, 2, 3].map((n, index) => ({
      item: {
        id: id(n),
        type: by === "type" && n === 1 ? "core.task" : "core.note",
        created_at: times[index],
        updated_at: times[index],
        occurred_at: times[index],
        properties: { title: ["c", "a", "b"][index] },
        state: n === 1 ? "archived" : "active",
        tier: n === 1 ? "library" : "feed",
      },
      tags: [["c"], ["a"], ["b"]][index],
    })),
    { sort: [{ by, direction: "asc" }] },
    by === "type"
      ? {
          query: { types: ["core.note", "core.task"] },
          slice: ["system.view", "core.note", "core.task"],
        }
      : {},
  );
  expect(await listed()).toEqual([2, 3, 1].map(id));
});

it("counts scalar and missing groups", async () => {
  await copy(
    [
      { item: { id: id(1), properties: { status: "open" } } },
      { item: { id: id(2), properties: { status: "open" } } },
      { item: { id: id(3), properties: { status: "open" } } },
      { item: { id: id(4), properties: { status: "closed" } } },
      { item: { id: id(5), properties: { status: null } } },
      { item: { id: id(6), properties: {} } },
    ],
    { group: { by: "properties.status", order: ["open"] } },
  );
  expect(await groups()).toEqual([
    { key: "open", count: 3 },
    { key: "closed", count: 1 },
    { key: null, count: 2 },
  ]);
});

it("counts an item in each tag group and honors ordered and hidden groups", async () => {
  const items = [
    { item: { id: id(1) }, tags: ["a", "b"] },
    { item: { id: id(2) }, tags: ["b"] },
    { item: { id: id(3) }, tags: [] },
  ];
  await copy(items, { group: { by: "tags", order: ["b"] } });
  expect(await groups()).toEqual([
    { key: "b", count: 2 },
    { key: "a", count: 1 },
    { key: null, count: 1 },
  ]);
  await copy(items, { group: { by: "tags", hidden: ["a", null] } });
  expect(await groups()).toEqual([{ key: "b", count: 2 }]);
  expect(await listed()).toHaveLength(3);
});

it.each(["edge", "backref"])(
  "groups by each %s other end only with the edge type held whole",
  async (end) => {
    const device = await copy(
      [1, 2, 3].map((n) => ({ item: { id: id(n) } })),
      { group: { by: `${end}[references]` } },
      { whole: ["references"] },
    );
    expect(await groups()).toEqual(
      end === "edge"
        ? [
            { key: id(2), count: 1 },
            { key: id(3), count: 2 },
            { key: null, count: 1 },
          ]
        : [
            { key: id(1), count: 2 },
            { key: id(2), count: 1 },
            { key: null, count: 1 },
          ],
    );
    value(await device.hydrate(["system.view", "core.note"], "all"));
    const refused = await device.attempt(["views", "groups", VIEW]);
    expect(refused.ok).toBe(false);
    if (!refused.ok)
      expect(refused.refusal.raw).toMatch(
        /references.*whole|whole.*references/,
      );
  },
);

it.each([
  ["day", ["2026-03-28", "2026-03-29", "2026-03-30", "2027-01-01"]],
  ["week", ["2026-03-23", "2026-03-30", "2026-12-28"]],
  ["month", ["2026-03-01", "2027-01-01"]],
  ["year", ["2026-01-01", "2027-01-01"]],
] as const)(
  "buckets %s by local calendar dates across a DST change",
  async (bucket, keys) => {
    await copy(
      [
        "2026-03-28T23:30:00Z",
        "2026-03-29T00:30:00Z",
        "2026-03-29T23:30:00Z",
        "2026-12-31T23:30:00Z",
      ].map((when, index) => ({
        item: { id: id(index + 1), properties: { when } },
      })),
      { group: { by: "properties.when", bucket } },
    );
    // Paris advances from UTC+1 to UTC+2 during March 29.
    const result = await groups("Europe/Paris");
    const expected =
      bucket === "day" ? ["2026-03-29", "2026-03-30", "2027-01-01"] : keys;
    expect(result.map((group) => group.key)).toEqual(expected);
    expect(result.map((group) => group.count)).toEqual(
      bucket === "day" || bucket === "week" ? [2, 1, 1] : [3, 1],
    );
    expect(result.reduce((count, group) => count + group.count, 0)).toBe(4);
    expect((await groups("UTC")).map((group) => group.key)).not.toEqual(
      expected,
    );
  },
);

it("keeps missing and invalid dates in the missing bucket", async () => {
  await copy(
    [
      { item: { id: id(1), properties: { when: "2026-10-25T01:30:00Z" } } },
      { item: { id: id(2), properties: { when: "not a date" } } },
      { item: { id: id(3), properties: {} } },
    ],
    { group: { by: "properties.when", bucket: "day" } },
  );
  expect(await groups("Europe/Paris")).toEqual([
    { key: "2026-10-25", count: 1 },
    { key: null, count: 2 },
  ]);
});

it("uses the device time zone when a caller names none", async () => {
  await copy(
    [{ item: { id: id(1), properties: { when: "2026-03-29T23:30:00Z" } } }],
    { group: { by: "properties.when", bucket: "day" } },
  );
  const previous = process.env.TZ;
  try {
    process.env.TZ = "Europe/Paris";
    expect(await groups()).toEqual([{ key: "2026-03-30", count: 1 }]);
    process.env.TZ = "UTC";
    expect(await groups()).toEqual([{ key: "2026-03-29", count: 1 }]);
  } finally {
    if (previous === undefined) delete process.env.TZ;
    else process.env.TZ = previous;
  }
});

it("pages a large copy by its sort and counts the whole matching set", async () => {
  const size = 4097;
  await copy(
    Array.from({ length: size }, (_, index) => ({
      item: {
        id: id(index + 1),
        properties: { rank: size - index },
      },
    })),
    {
      sort: [{ by: "properties.rank", direction: "asc" }],
      group: { by: "properties.absent" },
    },
  );
  expect(await listed(["--limit", "3"])).toEqual(
    [size, size - 1, size - 2].map(id),
  );
  expect(await groups()).toEqual([{ key: null, count: size }]);
});

const unanswerableCases = [
  [{ types: ["core.note", "core.task"] }, "core.task"],
  [{ tier: "all" }, "tier"],
  [{ beneath: id(1) }, "parent-of"],
  [{ filter: "backref[parent-of] exists" }, "backref"],
] as const;
it.each(unanswerableCases)(
  "refuses an unanswerable view with the reason (%j)",
  async (query, reason) => {
    const device = await copy(
      [{ item: { id: id(1) } }],
      {},
      {
        query: { tier: "library", ...query },
        tier: "library",
      },
    );
    expect(value(await device.list())).toHaveLength(2);
    for (const args of [
      ["items", "list", "--view", VIEW],
      ["search", "body", "--view", VIEW],
      ["views", "groups", VIEW],
    ]) {
      const refused = await device.attempt(args);
      expect(refused.ok, JSON.stringify(refused)).toBe(false);
      if (!refused.ok) expect(refused.refusal.raw).toContain(reason);
    }
  },
);

/** A whole copy whose cursor then ages out, so it answers but is stale. */
async function agedOut() {
  let aged = false;
  const device = await copy(
    [1, 2].map((n) => ({ item: { id: id(n) } })),
    {},
    {
      replay: (cursor) =>
        aged
          ? {
              kind: "sse",
              frames: [
                connected,
                copyStreamCursor("900"),
                catchupTooOld("500", cursor),
              ],
            }
          : copyReplay(cursor, []),
    },
  );
  // The witness: it answers whole before the cursor ages out.
  expect((await listed()).sort()).toEqual([id(1), id(2)]);
  aged = true;
  expect((await device.catchUp()).ok).toBe(false);
  return device;
}

const READS: Array<[string, string[]]> = [
  ["items", ["items", "list", "--view", VIEW]],
  ["groups", ["views", "groups", VIEW]],
];

it.each(READS)(
  "refuses a partially hydrated view's %s with hydration_incomplete instead of reporting partial totals",
  async (_name, command) => {
    const device = await copy(
      [1, 2].map((n) => ({ item: { id: id(n) } })),
      {},
      { partial: true },
    );
    const partial = value(await device.listAnswer());
    expect(partial.completeness).toBe("partial");
    const answer = await device.attempt(command);
    expect(answer.ok).toBe(false);
    if (!answer.ok) expect(answer.refusal.code).toBe("hydration_incomplete");
  },
);

it.each(READS)(
  "refuses a stale copy's view %s with hydration_incomplete while the copy itself still answers",
  async (_name, command) => {
    const device = await agedOut();
    const answer = await device.listAnswer();
    expect(answer.ok && answer.value.completeness).toBe("stale");
    const refused = await device.attempt(command);
    expect(refused.ok, JSON.stringify(refused)).toBe(false);
    if (!refused.ok) expect(refused.refusal.code).toBe("hydration_incomplete");
  },
);

it("accepts --view and refuses the removed --folder option", async () => {
  await copy([{ item: { id: id(1) } }], {});
  expect(await listed()).toEqual([id(1)]);
  expect(
    value(await harness!.device.attempt(["search", "body", "--view", VIEW])),
  ).toMatchObject({ hits: [{ item: { id: id(1) } }] });
  for (const command of [
    ["items", "list"],
    ["search", "body"],
  ]) {
    const refused = spawnSync(
      requireBinary(),
      ["device", ...command, "--folder", VIEW],
      { encoding: "utf8" },
    );
    expect(refused.status).not.toBe(0);
    expect(refused.stderr).toContain("unexpected argument '--folder'");
  }
});

it("lists the items holding an edge to one item and those of one source", async () => {
  const items = [1, 2, 3].map((n) => ({
    item: { id: id(n), source: n === 3 ? "other" : "inkwell" },
  }));
  await copy(
    items,
    { sort: [{ by: "created_at", direction: "asc" }] },
    {
      query: { filter: `edge[references] eq "${id(3)}"` },
      whole: ["references"],
    },
  );
  expect(await listed()).toEqual([1, 2].map(id));
  await copy(items, {}, { query: { filter: 'source eq "inkwell"' } });
  expect((await listed()).sort()).toEqual([1, 2].map(id));
  await copy(items, {}, { query: { filter: 'source eq "other"' } });
  expect(await listed()).toEqual([id(3)]);
});

it("answers a backref condition where the copy holds the edge type whole and refuses it where it does not", async () => {
  const items = [1, 2, 3].map((n) => ({ item: { id: id(n) } }));
  const whole = { whole: ["references"] };
  await copy(
    items,
    {},
    { query: { filter: "backref[references] exists" }, ...whole },
  );
  expect((await listed()).sort()).toEqual([2, 3].map(id));
  await copy(
    items,
    {},
    { query: { filter: "backref[references] not_exists" }, ...whole },
  );
  expect(await listed()).toEqual([id(1)]);
  const device = await copy(
    items,
    {},
    { query: { filter: "backref[references] exists" } },
  );
  const refused = await device.attempt(["items", "list", "--view", VIEW]);
  expect(refused.ok).toBe(false);
  if (!refused.ok)
    expect(refused.refusal.raw).toMatch(/references.*whole|whole.*references/);
});

it("reads a view's sort and ignores layouts stored with it", async () => {
  await copy(
    ["c", "a", "b"].map((title, index) => ({
      item: { id: id(index + 1), properties: { title } },
    })),
    {
      sort: [{ by: "title", direction: "asc" }],
      layouts: [
        {
          id: "main",
          kind: "list",
          sort: [{ by: "title", direction: "desc" }],
          group: { by: "title" },
        },
      ],
    },
  );
  expect(await listed()).toEqual([2, 3, 1].map(id));
  expect(await groups()).toEqual([{ key: null, count: 3 }]);
});
