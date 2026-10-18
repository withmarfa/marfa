import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MarfaClient } from "../../client/api.js";
import type { TestContext } from "../../client/types.js";
import {
  cleanup,
  createTestContext,
  trackItem,
  trackKey,
} from "../../utils/setup.js";

/**
 * A `?` in a value is a character like any other, on every door that takes a
 * filter, a tag or a type. Two notes differ only where the `?` is, so a door
 * that read the `?` as anything but itself would answer the other note too,
 * or neither.
 */

let ctx: TestContext;
let client: MarfaClient;
let apiUrl: string;
let key: MarfaClient;
let word: string;
let marked: string;
let plain: string;

const enc = encodeURIComponent;

beforeAll(async () => {
  ({ ctx, client, apiUrl } = await createTestContext(
    "compliance",
    "question-mark-values",
  ));
  word = `qmark${ctx.runId.replace(/[^a-z0-9]/gi, "").toLowerCase()}`;
  const minted = await client.createKey({
    label: "question-mark-values",
    source: `${ctx.source}-reader`,
    type_permissions: { "*": "write" },
    edge_permissions: { "*": "write" },
  });
  expect(minted.status, JSON.stringify(minted.error)).toBe(201);
  trackKey(ctx, minted.data.id);
  key = new MarfaClient({ baseUrl: apiUrl, apiKey: minted.data.key });

  for (const [body, tag] of [
    [`${word} a?b say "what?"`, `${word}-why?`],
    [`${word} axb say "whatx"`, `${word}-whyx`],
  ] as const) {
    const created = await client.createItem({
      type: "core.note",
      properties: { body },
    });
    expect(created.status, JSON.stringify(created.error)).toBe(201);
    trackItem(ctx, created.data.item.id);
    const tagged = await client.addTags(created.data.item.id, [tag]);
    expect(tagged.status, JSON.stringify(tagged.error)).toBe(200);
    if (body.includes("a?b")) marked = created.data.item.id;
    else plain = created.data.item.id;
  }
});

afterAll(async () => {
  await cleanup(ctx);
});

/** Filters that select the marked note alone, with the plain one as witness. */
const filters = (): string[] => [
  `properties.body eq "${word} a?b say \\"what?\\""`,
  `properties.body contains "${word} a?b"`,
  `properties.body contains "${word} a?b say \\"what?"`,
  `properties.body starts_with "${word} a?"`,
  `tags contains "${word}-why?"`,
];

describe("a ? inside a value", () => {
  it("matches as itself in a filter on GET /items", async () => {
    // Witness: both notes are there to be found.
    const both = await key.rawRequest<{ data: { id: string }[] }>(
      `/items?filter=${enc(`properties.body starts_with "${word} a"`)}&limit=10`,
    );
    expect(both.status).toBe(200);
    expect(both.data.data.map((i) => i.id).sort()).toEqual(
      [marked, plain].sort(),
    );
    for (const filter of filters()) {
      const r = await key.rawRequest<{ data: { id: string }[] }>(
        `/items?filter=${enc(filter)}&limit=10`,
      );
      expect(r.status, filter).toBe(200);
      expect(
        r.data.data.map((i) => i.id),
        filter,
      ).toEqual([marked]);
    }
  });

  it("matches as itself in a tags parameter on GET /items", async () => {
    const r = await key.listItems({ tags: [`${word}-why?`], limit: 10 });
    expect(r.status).toBe(200);
    expect(r.data.data.map((i) => i.id)).toEqual([marked]);
  });

  it("matches as itself in a tags parameter on GET /items/stats, GET /search and POST /items/bulk-actions", async () => {
    const tag = `${word}-why?`;
    const stats = await key.rawRequest<Record<string, number>>(
      `/items/stats?tags=${enc(tag)}`,
    );
    expect(stats.status).toBe(200);
    expect(stats.data).toEqual({ active: 1 });
    const searched = await key.rawRequest<{ data: { item: { id: string } }[] }>(
      `/search?q=${word}&tags=${enc(tag)}&limit=10`,
    );
    expect(searched.status).toBe(200);
    expect(searched.data.data.map((hit) => hit.item.id)).toEqual([marked]);
    const bulk = await key.rawRequest<{ ids: string[] }>(
      "/items/bulk-actions",
      {
        method: "POST",
        body: {
          filter: { tags: [tag] },
          action: "update_tags",
          add: [`${word}-never`],
          dry_run: true,
        },
      },
    );
    expect(bulk.status).toBe(200);
    expect(bulk.data.ids).toEqual([marked]);
  });

  it("matches as itself in a filter on GET /items/stats", async () => {
    for (const filter of filters()) {
      const r = await key.rawRequest<Record<string, number>>(
        `/items/stats?filter=${enc(filter)}`,
      );
      expect(r.status, filter).toBe(200);
      expect(r.data, filter).toEqual({ active: 1 });
    }
  });

  it("matches as itself in a filter on GET /search", async () => {
    for (const filter of filters()) {
      const r = await key.search(word, { filter, limit: 10 });
      expect(r.status, filter).toBe(200);
      expect(
        r.data.data.map((hit) => hit.item.id),
        filter,
      ).toEqual([marked]);
    }
  });

  it("matches as itself in a filter on POST /items/bulk-actions", async () => {
    for (const filter of filters()) {
      const r = await key.rawRequest<{ matched: number; ids: string[] }>(
        "/items/bulk-actions",
        {
          method: "POST",
          body: {
            filter: { filter },
            action: "update_tags",
            add: [`${word}-never`],
            dry_run: true,
          },
        },
      );
      expect(r.status, filter).toBe(200);
      expect(r.data.ids, filter).toEqual([marked]);
    }
  });

  it("matches as itself in the anchor of an edge term, on every door that takes one", async () => {
    const edge = await key.createEdge({
      source_id: plain,
      target_id: marked,
      edge_type: "about",
    });
    expect(edge.status, JSON.stringify(edge.error)).toBe(201);
    const terms = [`backref[about] eq "${plain}"`, `backref[about] eq "?"`];
    const answers: string[][] = [];
    for (const filter of terms) {
      const listed = await key.rawRequest<{ data: { id: string }[] }>(
        `/items?filter=${enc(filter)}&limit=10`,
      );
      const searched = await key.search(word, { filter, limit: 10 });
      expect(listed.status, filter).toBe(200);
      expect(searched.status, filter).toBe(200);
      const fromList = listed.data.data.map((i) => i.id);
      expect(
        searched.data.data.map((hit) => hit.item.id),
        filter,
      ).toEqual(fromList);
      answers.push(fromList);
    }
    expect(answers).toEqual([[marked], []]);
    const shorthand = await key.rawRequest<{ data: { id: string }[] }>(
      `/items?${enc("backref[about]")}=${enc("?")}&limit=10`,
    );
    expect(shorthand.status).toBe(200);
    expect(shorthand.data.data).toEqual([]);
  });

  it("counts a tag holding a ? under its own name on GET /metadata/tags", async () => {
    const r = await key.listTags();
    expect(r.status).toBe(200);
    const mine = r.data.data.filter((t) => t.tag.startsWith(`${word}-`));
    expect(mine.sort((a, b) => a.tag.localeCompare(b.tag))).toEqual([
      { tag: `${word}-why?`, count: 1 },
      { tag: `${word}-whyx`, count: 1 },
    ]);
  });
});

describe("a ? inside a type", () => {
  it("is refused on every door that takes a type, naming it", async () => {
    const doors: [
      string,
      () => Promise<{ status: number; error?: unknown }>,
    ][] = [
      ["GET /items", () => key.rawRequest(`/items?type=${enc("core.note?")}`)],
      [
        "GET /items/stats",
        () => key.rawRequest(`/items/stats?type=${enc("core.note?")}`),
      ],
      [
        "GET /search",
        () => key.rawRequest(`/search?q=${word}&type=${enc("core.note?")}`),
      ],
      [
        "GET /export",
        () => key.rawRequest(`/export?type=${enc("core.note?")}`),
      ],
      [
        "GET /occurrences",
        () =>
          key.rawRequest(
            `/occurrences?from=2026-01-01T00:00:00Z&to=2026-02-01T00:00:00Z&type=${enc("core.event?")}`,
          ),
      ],
      [
        "POST /items/bulk-actions",
        () =>
          key.rawRequest("/items/bulk-actions", {
            method: "POST",
            body: {
              filter: { type: "core.note?" },
              action: "update_tags",
              add: [`${word}-never`],
              dry_run: true,
            },
          }),
      ],
    ];
    for (const [name, ask] of doors) {
      const r = (await ask()) as {
        status: number;
        error?: {
          error: { code: string; details?: { errors?: { path: string }[] } };
        };
      };
      expect(r.status, name).toBe(400);
      expect(r.error?.error.code, name).toBe("validation_error");
      expect(
        r.error?.error.details?.errors?.map((e) => e.path),
        name,
      ).toEqual([name === "POST /items/bulk-actions" ? "filter.type" : "type"]);
    }
  });
});
