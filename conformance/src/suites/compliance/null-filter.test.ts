import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MarfaClient } from "../../client/api.js";
import type { TestContext } from "../../client/types.js";
import { cleanup, createTestContext, trackItem } from "../../utils/setup.js";

let client: MarfaClient;
let ctx: TestContext;
const held: Record<"text" | "null" | "missing", string> = {
  text: "",
  null: "",
  missing: "",
};

beforeAll(async () => {
  ({ client, ctx } = await createTestContext("compliance", "null-filter"));
  for (const [label, note] of [
    ["text", "held"],
    ["null", null],
    ["missing", undefined],
  ] as const) {
    const made = await client.createItem({
      type: "core.note",
      source: ctx.source,
      properties: {
        body: ctx.runId,
        ...(note === undefined ? {} : { subtitle: note }),
      },
    });
    expect(made.ok, JSON.stringify(made.error)).toBe(true);
    trackItem(ctx, made.data.item.id);
    held[label] = made.data.item.id;
  }
});
afterAll(async () => {
  await cleanup(ctx);
});

function mine(filter: string): string {
  return `source eq "${ctx.source}" AND ${filter}`;
}

async function listed(filter: string): Promise<string[]> {
  const result = await client.listItems({ filter: mine(filter), limit: 100 });
  expect(result.ok, JSON.stringify(result.error)).toBe(true);
  return result.data.data.map((item) => item.id).sort();
}

describe("a null literal in a filter", () => {
  it("is not needed: not_exists asks for a property that is absent or null, and exists for one that has a value", async () => {
    // The witness for the refusals below: the question a caller means by
    // `eq null` has an answer, and it holds both kinds of row.
    expect(await listed("properties.subtitle not_exists")).toEqual(
      [held.null, held.missing].sort(),
    );
    expect(await listed("properties.subtitle exists")).toEqual([held.text]);
  });

  it("is refused 400 on every operator, naming not_exists where a property can be absent", async () => {
    for (const op of [
      "eq",
      "neq",
      "gt",
      "gte",
      "lt",
      "lte",
      "contains",
      "starts_with",
    ]) {
      const filter = mine(`properties.subtitle ${op} null`);
      for (const [door, refused] of [
        ["items", await client.listItems({ filter })],
        ["search", await client.search("note", { filter })],
      ] as const) {
        expect(refused.status, `${door}: ${op} null`).toBe(400);
        expect(refused.error?.error.code, `${door}: ${op} null`).toBe(
          "validation_error",
        );
        expect(refused.error?.error.message).toContain("not_exists");
      }
    }
  });

  it("is refused on a system field, an edge and tags, and still read as text when quoted", async () => {
    for (const filter of [
      "source_id eq null",
      "state neq null",
      "edge[about] eq null",
      "tags contains null",
    ]) {
      const refused = await client.listItems({ filter: mine(filter) });
      expect(refused.status, filter).toBe(400);
      expect(refused.error?.error.code, filter).toBe("validation_error");
    }
    expect(await listed('properties.subtitle eq "null"')).toEqual([]);
  });
});
