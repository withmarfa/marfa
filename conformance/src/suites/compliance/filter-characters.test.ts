/**
 * A filter's length is counted in characters, so a character outside the basic
 * plane counts once. Each door that takes a filter is asked with one that has
 * 2,048 characters and more than 2,048 UTF-16 units, and with one more
 * character.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MarfaClient } from "../../client/api.js";
import type { TestContext } from "../../client/types.js";
import {
  cleanup,
  createTestContext,
  trackFolder,
  trackView,
} from "../../utils/setup.js";

let client: MarfaClient;
let ctx: TestContext;

beforeAll(async () => {
  ({ client, ctx } = await createTestContext("compliance", "filter-chars"));
});

afterAll(async () => {
  await cleanup(ctx);
});

const enc = encodeURIComponent;

/** A filter of exactly `length` characters that holds an emoji. */
const ofLength = (length: number): string => {
  const head = 'properties.body eq "😀';
  return `${head}${"x".repeat(length - [...head].length - 1)}"`;
};

describe("the length of a filter", () => {
  const doors = [
    {
      name: "GET /items",
      send: (filter: string) =>
        client.rawRequest(`/items?filter=${enc(filter)}`),
    },
    {
      name: "GET /items/stats",
      send: (filter: string) =>
        client.rawRequest(`/items/stats?filter=${enc(filter)}`),
    },
    {
      name: "GET /search",
      send: (filter: string) =>
        client.rawRequest(`/search?q=anything&filter=${enc(filter)}`),
    },
    {
      name: "POST /views",
      send: async (filter: string) => {
        const r = await client.createView({
          title: `characters ${ctx.runId}`,
          query: { filter },
        });
        if (r.ok) trackView(ctx, r.data.item.id);
        return r;
      },
    },
    {
      name: "POST /folders",
      send: async (filter: string) => {
        const r = await client.createFolder({
          title: `characters ${ctx.runId}`,
          query: { filter },
        });
        if (r.ok) trackFolder(ctx, r.data.item.id);
        return r;
      },
    },
  ];

  it("counts a character outside the basic plane once, at each door", async () => {
    // The witness: counted in UTF-16 units the first filter is over the limit.
    expect(ofLength(2048).length).toBe(2049);
    for (const door of doors) {
      const largest = await door.send(ofLength(2048));
      expect(largest.status, `${door.name}: 2,048`).toBeLessThan(300);
      const past = await door.send(ofLength(2049));
      expect(past.status, `${door.name}: 2,049`).toBe(400);
      expect(past.error?.error.code, door.name).toBe("validation_error");
    }
  });
});
