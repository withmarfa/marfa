import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { MarfaClient } from "../../client/api.js";
import type { TestContext } from "../../client/types.js";
import { cleanup, createTestContext, trackItem } from "../../utils/setup.js";

let client: MarfaClient;
let ctx: TestContext;
let stampType = "";
let labelType = "";
const named = new Map<string, string>();

const stamps: [string, string][] = [
  ["noon-utc", "2026-01-01T05:00:00Z"],
  ["offset", "2026-01-01T10:00:00+05:00"],
  ["millis", "2026-01-01T03:00:00.000Z"],
  ["minutes", "2026-01-01T04:00Z"],
  ["day", "2026-01-01"],
  ["fraction", "2026-01-01T00:00:00.5Z"],
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
  stampType = `user.stamp-${ctx.runId}`;
  labelType = `user.label-${ctx.runId}`;
  for (const [id, fields] of [
    [stampType, { when: { type: "datetime" } }],
    [labelType, { when: { type: "string" } }],
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
        properties: { when },
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

describe("a datetime property", () => {
  it("sorts by instant however its time is written, across a datetime and a text declaration", async () => {
    const order = (direction: "asc" | "desc") => {
      const instants = [
        id("day"),
        id("fraction"),
        id("millis"),
        id("text-instant"),
        id("minutes"),
        ...tied("noon-utc", "offset"),
      ];
      const ascending = [...instants, id("text-word")];
      return direction === "asc"
        ? ascending
        : [id("text-word"), ...instants.slice().reverse()];
    };
    for (const limit of [2, 3, 100]) {
      const up = await walk("asc", limit);
      expect(up, `asc ${limit}`).toEqual(order("asc"));
      const down = await walk("desc", limit);
      expect(down.slice(0, 1), `desc ${limit}`).toEqual([id("text-word")]);
      expect(down.slice(1, 3).sort(), `desc ties ${limit}`).toEqual(
        tied("noon-utc", "offset"),
      );
      expect(down.slice(3), `desc rest ${limit}`).toEqual(
        order("desc").slice(3),
      );
    }
  });

  it("filters by instant, so one instant written two ways is equal and an earlier time is lower", async () => {
    const all = (...names: string[]) => tied(...names);
    for (const type of [stampType]) {
      expect(
        await ids(type, 'properties.when eq "2026-01-01T10:00:00+05:00"'),
      ).toEqual(all("noon-utc", "offset"));
      expect(
        await ids(type, 'properties.when eq "2026-01-01T05:00:00.000Z"'),
      ).toEqual(all("noon-utc", "offset"));
      expect(
        await ids(type, 'properties.when lt "2026-01-01T05:00:00Z"'),
      ).toEqual(all("day", "fraction", "millis", "minutes"));
      expect(
        await ids(type, 'properties.when gte "2026-01-01T04:00:00Z"'),
      ).toEqual(all("minutes", "noon-utc", "offset"));
      expect(
        await ids(type, 'properties.when neq "2026-01-01T05:00:00Z"'),
      ).toEqual(all("day", "fraction", "millis", "minutes"));
      expect(await ids(type, 'properties.when gt "2026-01-01"')).toEqual(
        all("fraction", "millis", "minutes", "noon-utc", "offset"),
      );
    }
    expect(
      await ids(labelType, 'properties.when lt "2026-01-01T05:00:00+00:00"'),
    ).toEqual(all("text-instant"));
  });
});
