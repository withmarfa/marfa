import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { MarfaClient } from "../../client/api.js";
import type { TestContext } from "../../client/types.js";
import {
  cleanup,
  createTestContext,
  trackItem,
  trackView,
} from "../../utils/setup.js";

let client: MarfaClient;
let ctx: TestContext;
let stampType = "";
let labelType = "";
let word = "";
const named = new Map<string, string>();

const stamps: [string, string][] = [
  ["noon-utc", "2026-01-01T05:00:00Z"],
  ["offset", "2026-01-01T10:00:00+05:00"],
  ["millis", "2026-01-01T03:00:00.000Z"],
  ["minutes", "2026-01-01T04:00Z"],
  ["day", "2026-01-01"],
  ["fraction", "2026-01-01T00:00:00.5Z"],
  // Below a millisecond is not kept: this one is the same instant as `millis`
  // at 05:00, and the next rounds up to the following millisecond.
  ["fine", "2026-01-01T05:00:00.0004Z"],
  ["rounded", "2026-01-01T05:00:00.0006Z"],
  // Before the year 0000 in UTC, and after the year 9999.
  ["past", "0000-01-01T00:00:00+05:00"],
  ["last", "9999-12-31T23:59:59Z"],
  ["beyond", "9999-12-31T23:00:00-05:00"],
  ["furthest", "9999-12-31T23:59:59.999-23:59"],
];
const labels: [string, string][] = [
  ["text-instant", "2026-01-01T03:30:00Z"],
  ["text-word", "banana"],
];

beforeAll(async () => {
  ({ client, ctx } = await createTestContext(
    "compliance",
    "datetime-property-compare",
  ));
  word = `datetimecompare${ctx.runId}`;
  stampType = `user.stamp-${ctx.runId}`;
  labelType = `user.label-${ctx.runId}`;
  for (const [id, fields] of [
    [
      stampType,
      {
        when: { type: "datetime" },
        body: { type: "string", searchable: true },
      },
    ],
    [
      labelType,
      { when: { type: "string" }, body: { type: "string", searchable: true } },
    ],
  ] as const) {
    const registered = await client.registerType({ id, fields });
    expect(registered.status, JSON.stringify(registered.error)).toBe(201);
  }
  for (const [type, rows] of [
    [stampType, stamps],
    [labelType, labels],
  ] as const) {
    for (const [name, when] of rows) {
      const made = await client.createItem({
        type,
        source: ctx.source,
        properties: { when, body: word },
      });
      expect(made.ok, `${name}: ${JSON.stringify(made.error)}`).toBe(true);
      expect(made.data.item.properties.when).toBe(when);
      trackItem(ctx, made.data.item.id);
      named.set(name, made.data.item.id);
    }
  }
});

afterAll(async () => {
  await cleanup(ctx);
});

const id = (name: string): string => named.get(name) as string;
const tied = (...names: string[]): string[] => names.map(id).sort();

/** Every item by the instant its property names, equal instants by id. */
function order(direction: "asc" | "desc"): string[] {
  const middle = tied("noon-utc", "offset", "fine");
  const early = [
    "past",
    "day",
    "fraction",
    "millis",
    "text-instant",
    "minutes",
  ];
  const late = ["rounded", "last", "beyond", "furthest"];
  if (direction === "asc") {
    return [...early.map(id), ...middle, ...late.map(id), id("text-word")];
  }
  return [
    id("text-word"),
    ...late.map(id).reverse(),
    ...middle,
    ...early.map(id).reverse(),
  ];
}

/** The listing order restricted to `names`. */
function among(direction: "asc" | "desc", names: string[]): string[] {
  const wanted = new Set(tied(...names));
  return order(direction).filter((one) => wanted.has(one));
}

async function walk(
  direction: "asc" | "desc",
  limit: number,
): Promise<string[]> {
  const delivered: string[] = [];
  let cursor: string | undefined;
  do {
    const page = await client.listItems({
      source: ctx.source,
      sort: "properties.when",
      direction,
      limit,
      cursor,
    });
    expect(page.ok).toBe(true);
    delivered.push(...page.data.data.map((row) => row.id));
    cursor = page.data.next_cursor ?? undefined;
  } while (cursor);
  return delivered;
}

async function searched(
  direction: "asc" | "desc",
  limit: number,
  filter?: string,
): Promise<string[]> {
  const delivered: string[] = [];
  let cursor: string | undefined;
  do {
    const page = await client.search(word, {
      source: ctx.source,
      sort: "properties.when",
      direction,
      limit,
      cursor,
      filter,
    });
    expect(page.ok, JSON.stringify(page.error)).toBe(true);
    delivered.push(...page.data.data.map((hit) => hit.item.id));
    cursor = page.data.next_cursor ?? undefined;
  } while (cursor);
  return delivered;
}

async function viewed(
  direction: "asc" | "desc",
  limit: number,
  filter?: string,
): Promise<string[]> {
  const made = await client.createView({
    title: "By instant",
    query: {
      filter: `source eq "${ctx.source}"${filter ? ` AND ${filter}` : ""}`,
    },
    sort: [{ by: "properties.when", direction }],
  });
  expect(made.status, JSON.stringify(made.error)).toBe(201);
  trackView(ctx, made.data.item.id);
  const delivered: string[] = [];
  let cursor: string | undefined;
  do {
    const page = await client.listViewItems(made.data.item.id, {
      limit,
      cursor,
    });
    expect(page.ok, JSON.stringify(page.error)).toBe(true);
    delivered.push(...page.data.data.map((row) => row.id));
    cursor = page.data.next_cursor ?? undefined;
  } while (cursor);
  return delivered;
}

async function ids(type: string, filter: string): Promise<string[]> {
  const query = new URLSearchParams({
    limit: "100",
    type,
    filter: `source eq "${ctx.source}" AND ${filter}`,
  });
  const result = await client.rawRequest<{ data: { id: string }[] }>(
    `/items?${query.toString()}`,
  );
  expect(result.ok, JSON.stringify(result.error)).toBe(true);
  return result.data.data.map((row) => row.id).sort();
}

const stampNames = stamps.map(([name]) => name);

describe("a datetime property", () => {
  it("sorts by instant however its time is written, across a datetime and a text declaration", async () => {
    for (const limit of [2, 3, 100]) {
      expect(await walk("asc", limit), `asc ${limit}`).toEqual(order("asc"));
      expect(await walk("desc", limit), `desc ${limit}`).toEqual(order("desc"));
    }
  });

  it("keys an instant to the millisecond, so a smaller difference ties by id and the next millisecond follows", async () => {
    const up = await walk("asc", 100);
    const at = (name: string) => up.indexOf(id(name));
    const group = tied("noon-utc", "offset", "fine");
    expect(up.slice(at("minutes") + 1, at("minutes") + 4)).toEqual(group);
    expect(at("rounded")).toBe(at("minutes") + 4);
  });

  it("puts an instant before the year 0000 first and one after the year 9999 last, among the instants", async () => {
    const up = await walk("asc", 100);
    expect(up[0]).toBe(id("past"));
    const last = ["last", "beyond", "furthest"].map(id);
    expect(up.slice(-4)).toEqual([...last, id("text-word")]);
  });

  it("orders a search by instant, and pages through it with a cursor", async () => {
    for (const limit of [2, 3, 100]) {
      expect(await searched("asc", limit), `asc ${limit}`).toEqual(
        order("asc"),
      );
      expect(await searched("desc", limit), `desc ${limit}`).toEqual(
        order("desc"),
      );
    }
  });

  it("filters a search by instant and sorts what it keeps by instant", async () => {
    expect(
      await searched(
        "asc",
        2,
        'properties.when eq "2026-01-01T10:00:00+05:00"',
      ),
    ).toEqual(among("asc", ["noon-utc", "offset", "fine"]));
    expect(
      await searched("desc", 3, 'properties.when gt "2026-01-01T05:00:00Z"'),
    ).toEqual(among("desc", ["rounded", "last", "beyond", "furthest"]));
    expect(
      await searched("asc", 100, 'properties.when lt "2026-01-01T04:00:00Z"'),
    ).toEqual(
      among("asc", ["past", "day", "fraction", "millis", "text-instant"]),
    );
  });

  it("orders a view by instant, whole and filtered", async () => {
    for (const limit of [2, 100]) {
      expect(await viewed("asc", limit), `asc ${limit}`).toEqual(order("asc"));
      expect(await viewed("desc", limit), `desc ${limit}`).toEqual(
        order("desc"),
      );
    }
    expect(
      await viewed("asc", 2, 'properties.when gte "9999-12-31T23:59:59Z"'),
    ).toEqual(among("asc", ["last", "beyond", "furthest"]));
  });

  it("filters by instant, so one instant written two ways is equal and an earlier time is lower", async () => {
    const all = (...names: string[]) => tied(...names);
    const except = (...names: string[]) =>
      all(...stampNames.filter((name) => !names.includes(name)));
    expect(
      await ids(stampType, 'properties.when eq "2026-01-01T10:00:00+05:00"'),
    ).toEqual(all("noon-utc", "offset", "fine"));
    expect(
      await ids(stampType, 'properties.when eq "2026-01-01T05:00:00.000Z"'),
    ).toEqual(all("noon-utc", "offset", "fine"));
    expect(
      await ids(stampType, 'properties.when eq "2026-01-01T05:00:00.0004Z"'),
    ).toEqual(all("noon-utc", "offset", "fine"));
    expect(
      await ids(stampType, 'properties.when lt "2026-01-01T05:00:00Z"'),
    ).toEqual(all("past", "day", "fraction", "millis", "minutes"));
    expect(
      await ids(stampType, 'properties.when gt "2026-01-01T05:00:00Z"'),
    ).toEqual(all("rounded", "last", "beyond", "furthest"));
    expect(
      await ids(stampType, 'properties.when gte "2026-01-01T04:00:00Z"'),
    ).toEqual(except("past", "day", "fraction", "millis"));
    expect(
      await ids(stampType, 'properties.when neq "2026-01-01T05:00:00Z"'),
    ).toEqual(except("noon-utc", "offset", "fine"));
    expect(await ids(stampType, 'properties.when gt "2026-01-01"')).toEqual(
      except("past", "day"),
    );
    expect(
      await ids(labelType, 'properties.when lt "2026-01-01T05:00:00+00:00"'),
    ).toEqual(all("text-instant"));
  });

  it("filters an instant before the year 0000 below and one after the year 9999 above every other", async () => {
    const all = (...names: string[]) => tied(...names);
    expect(
      await ids(stampType, 'properties.when lt "0000-01-01T00:00:00Z"'),
    ).toEqual(all("past"));
    expect(
      await ids(stampType, 'properties.when gt "9999-12-31T23:59:59Z"'),
    ).toEqual(all("beyond", "furthest"));
    expect(
      await ids(stampType, 'properties.when gte "9999-12-31T23:59:59Z"'),
    ).toEqual(all("last", "beyond", "furthest"));
    expect(
      await ids(stampType, 'properties.when lt "9999-12-31T23:59:59Z"'),
    ).toEqual(
      all(
        ...stampNames.filter(
          (name) => !["last", "beyond", "furthest"].includes(name),
        ),
      ),
    );
  });
});
