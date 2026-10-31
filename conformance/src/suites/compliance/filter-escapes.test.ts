import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MarfaClient } from "../../client/api.js";
import type { TestContext } from "../../client/types.js";
import { cleanup, createTestContext, trackItem } from "../../utils/setup.js";

let client: MarfaClient;
let ctx: TestContext;
const subtitles = {
  endsInBackslash: "C:\\",
  twoBackslashes: "a\\\\b",
  oneBackslash: "a\\b",
  backslashQuote: 'a\\"b',
  quote: 'say "hi"',
} as const;
const held: Record<string, string> = {};

beforeAll(async () => {
  ({ client, ctx } = await createTestContext("compliance", "filter-escapes"));
  for (const [label, subtitle] of Object.entries(subtitles)) {
    const made = await client.createItem({
      type: "core.note",
      source: ctx.source,
      properties: { body: ctx.runId, subtitle },
    });
    expect(made.ok, JSON.stringify(made.error)).toBe(true);
    trackItem(ctx, made.data.item.id);
    held[label] = made.data.item.id;
  }
});
afterAll(async () => {
  await cleanup(ctx);
});

async function listed(value: string): Promise<string[]> {
  const filter = `source eq "${ctx.source}" AND properties.subtitle eq "${value}"`;
  const result = await client.listItems({ filter, limit: 100 });
  expect(result.ok, `${filter}: ${JSON.stringify(result.error)}`).toBe(true);
  return result.data.data.map((item) => item.id);
}

describe("a quoted value in a filter", () => {
  it("reads an escaped quote and an escaped backslash as one character of the value", async () => {
    expect(await listed("C:\\\\")).toEqual([held.endsInBackslash]);
    expect(await listed("a\\\\\\\\b")).toEqual([held.twoBackslashes]);
    expect(await listed("a\\\\b")).toEqual([held.oneBackslash]);
    expect(await listed('a\\\\\\"b')).toEqual([held.backslashQuote]);
    expect(await listed('say \\"hi\\"')).toEqual([held.quote]);
  });

  it("reads any other backslash as itself", async () => {
    expect(await listed("a\\b")).toEqual([held.oneBackslash]);
  });
});
