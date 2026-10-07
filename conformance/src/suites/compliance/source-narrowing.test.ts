import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { MarfaClient } from "../../client/api.js";
import type { MarfaItem, TestContext } from "../../client/types.js";
import {
  cleanup,
  createSecondClient,
  createTestContext,
  trackItem,
} from "../../utils/setup.js";

/**
 * Two sources hold rows that share a tag and a word, so the only thing that
 * tells them apart is the source. A request that narrows by something else as
 * well would pass for the wrong reason, so each door is asked once with the
 * source and once without it.
 */
let client: MarfaClient;
let other: MarfaClient;
let ctx: TestContext;
let ours: string;
let theirs: string;
let otherSource: string;
let tag: string;
let word: string;

async function seed(as: MarfaClient, source: string): Promise<string> {
  const made = await as.createItem({
    type: "core.note",
    source,
    properties: { title: word, body: `${word} ${source}` },
    tags: [tag],
  });
  expect(made.status, JSON.stringify(made.error)).toBe(201);
  trackItem(ctx, made.data.item.id);
  return made.data.item.id;
}

beforeAll(async () => {
  ({ ctx, client } = await createTestContext("compliance", "source-narrowing"));
  other = await createSecondClient(ctx, "other");
  otherSource = `${ctx.source}-other`;
  tag = `source-narrowing-${ctx.runId}`;
  word = `sourcenarrowing${ctx.runId}`;
  ours = await seed(client, ctx.source);
  theirs = await seed(other, otherSource);
});

afterAll(async () => {
  await cleanup(ctx);
});

const enc = encodeURIComponent;

describe("source narrows the doors that declare it to the rows stamped with it", () => {
  it("GET /items answers only the rows stamped with the source named", async () => {
    const both = await client.listItems({ tags: [tag] });
    expect(both.status).toBe(200);
    expect(both.data.data.map((row: MarfaItem) => row.id).sort()).toEqual(
      [ours, theirs].sort(),
    );

    const mine = await client.listItems({ tags: [tag], source: ctx.source });
    expect(mine.status).toBe(200);
    expect(mine.data.data.map((row: MarfaItem) => row.id)).toEqual([ours]);
    const yours = await client.listItems({ tags: [tag], source: otherSource });
    expect(yours.data.data.map((row: MarfaItem) => row.id)).toEqual([theirs]);
  });

  it("GET /items/stats counts only the rows stamped with the source named", async () => {
    const stats = async (query: string) => {
      const res = await client.rawRequest<Record<string, number>>(
        `/items/stats?tags=${enc(tag)}${query}`,
      );
      expect(res.status, JSON.stringify(res.error)).toBe(200);
      return res.data;
    };
    expect(await stats("")).toEqual({ active: 2 });
    expect(await stats(`&source=${enc(ctx.source)}`)).toEqual({ active: 1 });
    expect(await stats(`&source=${enc(otherSource)}`)).toEqual({ active: 1 });
  });

  it("GET /export carries only the rows stamped with the source named", async () => {
    const lines = async (source: string): Promise<string[]> => {
      const res = await client.exportItems({ type: "core.note", source });
      expect(res.status, JSON.stringify(res.error)).toBe(200);
      return res.data
        .split("\n")
        .filter((line) => line.trim() !== "")
        .flatMap((line) => {
          const parsed = JSON.parse(line) as { item?: { id: string } };
          return parsed.item === undefined ? [] : [parsed.item.id];
        });
    };
    expect(await lines(ctx.source)).toEqual([ours]);
    expect(await lines(otherSource)).toEqual([theirs]);
  });

  it("POST /items/bulk-actions selects only the rows stamped with the source named", async () => {
    const selected = async (filter: Record<string, unknown>) => {
      const res = await client.rawRequest<{ ids: string[] }>(
        "/items/bulk-actions",
        {
          method: "POST",
          body: {
            action: "transition",
            state: "archived",
            dry_run: true,
            filter: { tags: [tag], ...filter },
          },
        },
      );
      expect(res.status, JSON.stringify(res.error)).toBe(200);
      return res.data.ids.sort();
    };
    expect(await selected({})).toEqual([ours, theirs].sort());
    expect(await selected({ source: ctx.source })).toEqual([ours]);
    expect(await selected({ source: otherSource })).toEqual([theirs]);
  });

  it("GET /search refuses a source, which it does not declare, rather than answering every source", async () => {
    // The witness: the same search without the key finds both rows.
    const both = await client.search(word);
    expect(both.status).toBe(200);
    expect(both.data.data.map((hit) => hit.item.id).sort()).toEqual(
      [ours, theirs].sort(),
    );

    const refused = await client.rawRequest<unknown>(
      `/search?q=${enc(word)}&source=${enc(ctx.source)}`,
    );
    expect(refused.status).toBe(400);
    expect(refused.error?.error.code).toBe("validation_error");
    expect(refused.error?.error.details?.unknown_parameters).toEqual([
      "source",
    ]);
  });
});
