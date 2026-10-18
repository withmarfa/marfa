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
 * How a type map is ranked, asked of the same rows at every door that reads
 * them: the listing, search, the tag counts and a read by id. A rule that held
 * on one door and not another would show a row in one answer and hide it in
 * the next, so each case asserts all four agree as well as what they answer.
 */

let ctx: TestContext;
let client: MarfaClient;
let apiUrl: string;
let word: string;

const TYPES = [
  "core.note",
  "core.bookmark",
  "core.media",
  "core.media.book",
  "core.media.film",
] as const;
type Type = (typeof TYPES)[number];
const ids = {} as Record<Type, string>;

const tagOf = (type: Type): string => `${word}-${type.replaceAll(".", "-")}`;

beforeAll(async () => {
  ({ ctx, client, apiUrl } = await createTestContext(
    "compliance",
    "type-map-ranking",
  ));
  word = `ranking${ctx.runId.replace(/[^a-z0-9]/gi, "").toLowerCase()}`;
  for (const type of TYPES) {
    const created = await client.createItem({
      type,
      properties:
        type === "core.note"
          ? { body: word }
          : type === "core.bookmark"
            ? { url: "https://example.com/ranking", title: word }
            : { title: word },
    });
    expect(created.status, JSON.stringify(created.error)).toBe(201);
    trackItem(ctx, created.data.item.id);
    ids[type] = created.data.item.id;
    const tagged = await client.addTags(created.data.item.id, [tagOf(type)]);
    expect(tagged.status, JSON.stringify(tagged.error)).toBe(200);
  }
});

afterAll(async () => {
  await cleanup(ctx);
});

async function keyWith(
  label: string,
  type_permissions: Record<string, string>,
): Promise<MarfaClient> {
  const minted = await client.createKey({
    label: `type-map-ranking-${label}`,
    source: `${ctx.source}-${label}`,
    type_permissions,
  });
  expect(minted.status, JSON.stringify(minted.error)).toBe(201);
  trackKey(ctx, minted.data.id);
  return new MarfaClient({ baseUrl: apiUrl, apiKey: minted.data.key });
}

/** The seeded types each door shows the key, one sorted list per door. */
async function seen(key: MarfaClient): Promise<Record<string, Type[]>> {
  const typeOf = (id: string): Type | undefined =>
    TYPES.find((type) => ids[type] === id);
  const known = (list: (Type | undefined)[]): Type[] =>
    list.filter((t): t is Type => t !== undefined).sort();

  const listed = await key.listItems({ source: ctx.source, limit: 100 });
  expect(listed.status, JSON.stringify(listed.error)).toBe(200);
  const searched = await key.search(word, { limit: 50 });
  expect(searched.status, JSON.stringify(searched.error)).toBe(200);
  const tags = await key.listTags();
  expect(tags.status, JSON.stringify(tags.error)).toBe(200);
  const byId: (Type | undefined)[] = [];
  for (const type of TYPES) {
    const read = await key.getItem(ids[type]);
    expect([200, 404], `GET /items/{id} of ${type}`).toContain(read.status);
    if (read.status === 200) byId.push(type);
  }
  const tagNames = new Set(tags.data.data.map((t) => t.tag));
  return {
    listing: known(listed.data.data.map((item) => typeOf(item.id))),
    search: known(searched.data.data.map((r) => typeOf(r.item.id))),
    tags: TYPES.filter((type) => tagNames.has(tagOf(type))).sort(),
    byId: known(byId),
  };
}

function everyDoor(types: Type[]): Record<string, Type[]> {
  const sorted = [...types].sort();
  return { listing: sorted, search: sorted, tags: sorted, byId: sorted };
}

describe("a type map is ranked by specificity at every door", () => {
  it("decides a type by its exact entry over any wildcard that also covers it", async () => {
    const key = await keyWith("exact-first", {
      "core.*": "none",
      "core.media.*": "none",
      "core.media.book": "read",
      "*": "read",
    });
    // Witness: the wildcards alone hide the whole namespace.
    const witness = await keyWith("exact-first-witness", {
      "core.*": "none",
      "core.media.*": "none",
      "*": "read",
    });
    expect(await seen(witness)).toEqual(everyDoor([]));
    expect(await seen(key)).toEqual(everyDoor(["core.media.book"]));
  });

  it("writes a type at the level of its exact entry over a wildcard", async () => {
    const key = await keyWith("exact-write", {
      "core.*": "read",
      "core.note": "write",
    });
    const note = await key.createItem({
      type: "core.note",
      properties: { body: word },
    });
    expect(note.status, JSON.stringify(note.error)).toBe(201);
    trackItem(ctx, note.data.item.id);
    const bookmark = await key.createItem({
      type: "core.bookmark",
      properties: { url: "https://example.com/ranking", title: word },
    });
    expect(bookmark.status).toBe(403);
    expect(bookmark.error?.error.code).toBe("type_not_permitted");
  });

  it("decides a type by the wildcard with the longer root when two cover it", async () => {
    const narrower = await keyWith("longest-narrow", {
      "core.*": "read",
      "core.media.*": "none",
    });
    expect(await seen(narrower)).toEqual(
      everyDoor(["core.bookmark", "core.note"]),
    );
    const wider = await keyWith("longest-wide", {
      "core.*": "none",
      "core.media.*": "read",
    });
    expect(await seen(wider)).toEqual(
      everyDoor(["core.media", "core.media.book", "core.media.film"]),
    );
  });

  it("applies the global wildcard only where no other entry covers a type", async () => {
    const key = await keyWith("global-last", {
      "*": "read",
      "core.note": "none",
      "core.media.*": "none",
    });
    expect(await seen(key)).toEqual(everyDoor(["core.bookmark"]));
  });
});

describe("an exclusion carves into a wider grant", () => {
  it("leaves out what a none entry under a granted wildcard covers, and keeps the rest", async () => {
    const key = await keyWith("carve", {
      "core.media.*": "read",
      "core.media.film": "none",
    });
    expect(await seen(key)).toEqual(
      everyDoor(["core.media", "core.media.book"]),
    );
  });
});

describe("a subtree wildcard covers its root", () => {
  it("applies core.media.* to core.media itself, and not to a type outside it", async () => {
    const key = await keyWith("root", { "core.media.*": "read" });
    expect(await seen(key)).toEqual(
      everyDoor(["core.media", "core.media.book", "core.media.film"]),
    );
  });
});

describe("a type map entry matches by exact characters", () => {
  it("covers no type with an entry in another case", async () => {
    const granted = await keyWith("case-grant", {
      "Core.Note": "read",
      "core.bookmark": "read",
    });
    expect(await seen(granted)).toEqual(everyDoor(["core.bookmark"]));
    const withheld = await keyWith("case-withhold", {
      "*": "read",
      "CORE.MEDIA.*": "none",
    });
    expect(await seen(withheld)).toEqual(everyDoor([...TYPES]));
  });

  it("covers no type with an entry holding a ?", async () => {
    const key = await keyWith("question-mark", {
      "core.note?": "read",
      "core.media.*?": "read",
      "core.bookmark": "read",
    });
    expect(await seen(key)).toEqual(everyDoor(["core.bookmark"]));
  });
});
