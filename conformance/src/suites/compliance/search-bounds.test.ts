import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MarfaClient } from "../../client/api.js";
import type { TestContext } from "../../client/types.js";
import { createNote } from "../../generators/items.js";
import {
  callTool,
  connectMcp,
  toolError,
  toolResult,
  type McpConnection,
} from "../../utils/mcp.js";
import { cleanup, createTestContext, trackItem } from "../../utils/setup.js";

let ctx: TestContext;
let client: MarfaClient;
let apiUrl: string;
let apiKey: string;
let mcp: McpConnection;
let word: string;
let stem: string;
let companion: string;

beforeAll(async () => {
  ({ ctx, client, apiUrl, apiKey } = await createTestContext(
    "compliance",
    "search-bounds",
  ));
  mcp = await connectMcp(apiUrl, apiKey);
  word = `bounded${ctx.runId.replace(/[^a-z0-9]/gi, "").toLowerCase()}`;
  const made = await client.createItem(
    createNote({
      source: ctx.source,
      properties: { title: word, body: `${word} second` },
      tags: ["kept"],
    }),
  );
  expect(made.status, JSON.stringify(made.error)).toBe(201);
  trackItem(ctx, made.data.item.id);
  const run = ctx.runId.replace(/[^a-z0-9]/gi, "").toLowerCase();
  stem = `prefixed${run}`;
  companion = `companion${run}`;
  const lengthy = await client.createItem(
    createNote({
      source: ctx.source,
      properties: { title: `${companion} ${stem}catalogue`, body: "second" },
    }),
  );
  expect(lengthy.status, JSON.stringify(lengthy.error)).toBe(201);
  trackItem(ctx, lengthy.data.item.id);
});

afterAll(async () => {
  await mcp.close();
  await cleanup(ctx);
});

const distinct = (count: number, lead = ""): string =>
  [lead, ...Array.from({ length: count }, (_, n) => `w${String(n)}`)]
    .filter(Boolean)
    .join(" ");

// As many repeats as 500 characters hold, more than the 16 distinct words allowed.
const repeats = (): string =>
  Array(Math.floor(500 / (word.length + 1)))
    .fill(word)
    .join(" ");

const tagList = (count: number): string =>
  Array.from({ length: count }, (_, n) => `bound-tag-${String(n)}`).join(",");

async function search(q: string, extra = "") {
  return client.rawRequest<{ data: unknown[] }>(
    `/search?q=${encodeURIComponent(q)}${extra}`,
  );
}

function expectRefused(
  answer: Awaited<ReturnType<typeof search>>,
  field: string,
  why: string,
): void {
  expect(answer.status, why).toBe(400);
  expect(answer.error?.error.code, why).toBe("validation_error");
  expect(answer.error?.error.details?.field, why).toBe(field);
}

describe("GET /search bounds", () => {
  it("takes a q of 500 characters and refuses one of 501, counting characters and not bytes", async () => {
    for (const unit of ["x", "\u{1F600}", "é"]) {
      const largest = await search(unit.repeat(500));
      expect(largest.status, `${unit} x 500`).toBe(200);
      expectRefused(await search(unit.repeat(501)), "q", `${unit} x 501`);
    }
    // Surrounding whitespace is not counted, and spaces inside count.
    expect((await search(` ${"x".repeat(500)} `)).status).toBe(200);
    expect((await search(`${"x".repeat(250)}${" ".repeat(250)}y`)).status).toBe(
      400,
    );
    // A quote left open is a word to match, inside the bound.
    expect((await search(`"${word}`)).status).toBe(200);
  });

  it("takes 16 distinct words and refuses 17", async () => {
    expect((await search(distinct(15, word))).status).toBe(200);
    expectRefused(await search(distinct(16, word)), "q", "17 words");
    expect(
      (await search(`${distinct(15, word)}${" ".repeat(60)}`)).status,
    ).toBe(200);
    // Inside quotes the query is one phrase, however many words it holds.
    expect((await search(`"${distinct(40)}"`)).status).toBe(200);
  });

  it("searches a repeated word once and does not count it again", async () => {
    const once = await search(word);
    expect(once.status).toBe(200);
    expect(once.data.data.length, "the witness: the word matches").toBe(1);
    const repeated = await search(`${word} ${word} ${word} ${distinct(14)}`);
    expect(repeated.status, JSON.stringify(repeated.error)).toBe(200);
    const alone = await search(`${word} ${word} ${word}`);
    expect(alone.status).toBe(200);
    expect(alone.data.data).toEqual(once.data.data);
    const many = await search(repeats());
    expect(many.status, "more repeats than the word bound").toBe(200);
    expect(many.data.data).toEqual(once.data.data);
  });

  it("matches a repeated last word as a prefix, as typing it once does", async () => {
    // Only a prefix reaches the item: no word of it is the stem whole.
    const prefix = `${stem}cat`;
    const once = await search(`${companion} ${prefix}`);
    expect(once.status).toBe(200);
    expect(once.data.data.length, "the witness: the prefix matches").toBe(1);
    for (const typed of [
      `${companion} ${prefix} ${prefix}`,
      `${companion} ${prefix} ${prefix} ${prefix}`,
      `${prefix} ${companion} ${prefix}`,
    ]) {
      const repeated = await search(typed);
      expect(repeated.status, typed).toBe(200);
      expect(repeated.data.data, typed).toEqual(once.data.data);
    }
  });
});

describe("a list of tags", () => {
  const doors = (tags: string): string[] => [
    `/items?tags=${encodeURIComponent(tags)}`,
    `/items/stats?tags=${encodeURIComponent(tags)}`,
    `/search?q=${word}&tags=${encodeURIComponent(tags)}`,
  ];

  const bulkAction = (tags: string[]) =>
    client.rawRequest<unknown>("/items/bulk-actions", {
      method: "POST",
      body: {
        action: "transition",
        state: "archived",
        dry_run: true,
        filter: { tags },
      },
    });

  it("takes 100 distinct tags and refuses 101, at each door that takes tags", async () => {
    for (const door of doors(tagList(100))) {
      const largest = await client.rawRequest<unknown>(door);
      expect(largest.status, door).toBe(200);
    }
    for (const door of doors(tagList(101))) {
      const refused = await client.rawRequest<unknown>(door);
      expect(refused.status, door).toBe(400);
      expect(refused.error?.error.code, door).toBe("validation_error");
      expect(refused.error?.error.details?.field, door).toBe("tags");
    }
    const within = await bulkAction(tagList(100).split(","));
    expect(within.status, JSON.stringify(within.error)).toBeLessThan(300);
    const over = await bulkAction(tagList(101).split(","));
    expect(over.status).toBe(400);
    expect(over.error?.error.code).toBe("validation_error");
    expect(over.error?.error.details?.field).toBe("filter.tags");
  });

  it("does not count blank entries or repeated tags", async () => {
    const padded = `${tagList(100)},,  ,bound-tag-0,bound-tag-1,`;
    for (const door of doors(padded)) {
      expect((await client.rawRequest<unknown>(door)).status, door).toBe(200);
    }
    const kept = await client.rawRequest<{ data: unknown[] }>(
      `/items?tags=kept,,%20,kept&source=${encodeURIComponent(ctx.source)}`,
    );
    expect(kept.status).toBe(200);
    expect(kept.data.data.length, "the witness: the tag matches").toBe(1);
  });

  it("takes a tag of 128 characters and refuses one of 129, at each door that takes tags", async () => {
    for (const unit of ["x", "\u{1F600}"]) {
      for (const door of doors(unit.repeat(128))) {
        expect((await client.rawRequest<unknown>(door)).status, door).toBe(200);
      }
      for (const door of doors(`kept,${unit.repeat(129)}`)) {
        const refused = await client.rawRequest<unknown>(door);
        expect(refused.status, door).toBe(400);
        expect(refused.error?.error.code, door).toBe("validation_error");
        expect(refused.error?.error.details?.field, door).toBe("tags");
      }
    }
    const over = await bulkAction(["x".repeat(129)]);
    expect(over.status).toBe(400);
    expect(over.error?.error.details?.field).toBe("filter.tags");
  });
});

describe("marfa_find bounds", () => {
  it("refuses a marfa_find query past the bound, and takes one at it", async () => {
    toolResult(await callTool(mcp, "marfa_find", { query: "x".repeat(500) }));
    toolResult(await callTool(mcp, "marfa_find", { query: distinct(16) }));
    for (const query of ["x".repeat(501), distinct(17)]) {
      const error = toolError(await callTool(mcp, "marfa_find", { query }));
      expect(error.code).toBe("validation_error");
    }
    toolResult(await callTool(mcp, "marfa_find", { query: repeats() }));
  });

  it("refuses marfa_find tags past the bound, and takes them at it", async () => {
    const tags = (count: number) => tagList(count).split(",");
    toolResult(await callTool(mcp, "marfa_find", { tags: tags(100) }));
    toolResult(await callTool(mcp, "marfa_find", { tags: ["x".repeat(128)] }));
    for (const over of [tags(101), ["x".repeat(129)]]) {
      const error = toolError(
        await callTool(mcp, "marfa_find", { tags: over }),
      );
      expect(error.code).toBe("validation_error");
    }
  });

  it("counts what marfa_find is given as the server does, after trimming and dropping repeats", async () => {
    const copies = Array(101).fill("kept");
    toolResult(await callTool(mcp, "marfa_find", { tags: copies }));
    toolResult(
      await callTool(mcp, "marfa_find", {
        tags: [...copies, ` ${"x".repeat(128)} `, " "],
      }),
    );
    toolResult(
      await callTool(mcp, "marfa_find", { query: ` ${"x".repeat(500)} ` }),
    );
    const prefix = `${stem}cat`;
    const found = toolResult(
      await callTool(mcp, "marfa_find", { query: `${prefix} ${prefix}` }),
    );
    expect(JSON.stringify(found), "a repeated last word is a prefix").toContain(
      stem,
    );
  });
});
