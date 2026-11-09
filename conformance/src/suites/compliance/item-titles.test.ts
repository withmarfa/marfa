/**
 * Conformance for POST /items/titles: the items titled by each of many names,
 * the fold a name and a title are compared by, what the answer leaves out,
 * and the caps.
 *
 * The fold cases are `fixtures/name-fold.json`, which the server and the
 * core are both held to.
 */

import { readFileSync } from "node:fs";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { v7 as uuidv7 } from "uuid";
import { MarfaClient } from "../../client/api.js";
import type { TestContext } from "../../client/types.js";
import {
  cleanup,
  createTestContext,
  getManagementClient,
  trackItem,
  trackKey,
} from "../../utils/setup.js";
import { createBookmark, createNote } from "../../generators/items.js";
import { expectMatchesSchema } from "../../utils/openapi.js";

interface FoldCase {
  about: string;
  name: string;
  folded: string;
}

const FOLDS = (
  JSON.parse(
    readFileSync(
      new URL("../../../fixtures/name-fold.json", import.meta.url),
      "utf8",
    ),
  ) as { cases: FoldCase[] }
).cases;

let client: MarfaClient;
let ctx: TestContext;
let apiUrl: string;

beforeAll(async () => {
  ({ ctx, client, apiUrl } = await createTestContext(
    "compliance",
    "item-titles",
  ));
});

afterAll(async () => {
  await cleanup(ctx);
});

/** A title no other test of this run uses. */
function unique(label: string): string {
  return `${label} ${uuidv7()}`;
}

async function note(title: string): Promise<string> {
  const made = await client.createItem(
    createNote({ source: ctx.source, properties: { title, body: "b" } }),
  );
  expect(made.status, JSON.stringify(made.error)).toBe(201);
  trackItem(ctx, made.data.item.id);
  return made.data.item.id;
}

async function idsFor(
  name: string,
  as: MarfaClient = client,
): Promise<string[]> {
  const res = await as.findItemsByTitle([name]);
  expect(res.status, JSON.stringify(res.error)).toBe(200);
  return (res.data.results[0]?.items ?? []).map((item) => item.id).sort();
}

describe("POST /items/titles", () => {
  it("answers each name in the order named with the items it titles", async () => {
    const one = unique("order-one");
    const two = unique("order-two");
    const idOne = await note(one);
    const idTwo = await note(two);
    const res = await client.findItemsByTitle([two, one, two, unique("none")]);
    expect(res.status).toBe(200);
    await expectMatchesSchema("POST", "/items/titles", 200, res.data);
    expect(res.data.results.map((result) => result.name)).toEqual([
      two,
      one,
      two,
      res.data.results[3]?.name,
    ]);
    expect(
      res.data.results.map((result) => result.items.map((item) => item.id)),
    ).toEqual([[idTwo], [idOne], [idTwo], []]);
    expect(res.data.results[0]?.items[0]).toEqual({
      id: idTwo,
      type: "core.note",
      title: two,
      has_blob: false,
    });
    expect(res.data.results.every((result) => result.more === false)).toBe(
      true,
    );
  });

  it("finds a title by its folded form and by the name as typed, for every case of the shared fold", async () => {
    for (const { about, name, folded } of FOLDS.filter(
      (fold) => fold.folded !== "",
    )) {
      const id = await note(name);
      expect(await idsFor(folded), about).toContain(id);
      expect(await idsFor(name), about).toContain(id);
    }
  });

  it("finds no title for a name that folds to nothing", async () => {
    await note(unique("nothing"));
    expect(await idsFor("")).toEqual([]);
    expect(await idsFor("  　 ")).toEqual([]);
  });

  it("matches a whole title, not a part of one", async () => {
    const stem = unique("whole");
    await note(`${stem} and more`);
    expect(await idsFor(stem)).toEqual([]);
  });

  it("finds an archived item, and leaves out an item in the bin", async () => {
    const stem = unique("states");
    const archived = await note(`${stem} archived`);
    const transitioned = await client.transitionItem(archived, "archived");
    expect(transitioned.ok, JSON.stringify(transitioned.error)).toBe(true);
    const binned = await note(`${stem} binned`);
    expect((await client.deleteItem(binned)).status).toBe(200);
    expect(await idsFor(`${stem} archived`)).toEqual([archived]);
    expect(await idsFor(`${stem} binned`)).toEqual([]);
  });

  it("reads a title from the property its type is titled by, inherited down the type's parents", async () => {
    const parent = `user.titles-${ctx.runId}`;
    const registered = await client.registerType({
      id: parent,
      fields: { heading: { type: "string" }, title: { type: "string" } },
      display_hints: { title_field: "heading" },
    });
    expect(registered.ok, JSON.stringify(registered.error)).toBe(true);
    const child = `${parent}.child`;
    const registeredChild = await client.registerType({
      id: child,
      parent,
      fields: {},
    });
    expect(registeredChild.ok, JSON.stringify(registeredChild.error)).toBe(
      true,
    );
    const heading = unique("heading");
    const other = unique("other");
    for (const type of [parent, child]) {
      const made = await client.createItem({
        type,
        source: ctx.source,
        properties: { heading, title: other },
      });
      expect(made.status, JSON.stringify(made.error)).toBe(201);
      trackItem(ctx, made.data.item.id);
    }
    const found = await client.findItemsByTitle([heading, other]);
    expect(found.status).toBe(200);
    expect(
      found.data.results[0]?.items.map((item) => item.type).sort(),
    ).toEqual([child, parent].sort());
    expect(found.data.results[1]?.items).toEqual([]);
  });

  it("lists at most 20 items for a name and says when there are more", async () => {
    const name = unique("many");
    const ids: string[] = [];
    for (let at = 0; at < 21; at += 1) ids.push(await note(name));
    const res = await client.findItemsByTitle([name]);
    expect(res.status).toBe(200);
    expect(res.data.results[0]?.items).toHaveLength(20);
    expect(res.data.results[0]?.more).toBe(true);
  });

  it("leaves out an item whose type the key may not read, and refuses a key that reads no type", async () => {
    const name = unique("scoped");
    const noteId = await note(name);
    const bookmark = await client.createItem(
      createBookmark({
        source: ctx.source,
        properties: { url: "https://example.com/scoped", title: name },
      }),
    );
    expect(bookmark.status, JSON.stringify(bookmark.error)).toBe(201);
    trackItem(ctx, bookmark.data.item.id);
    expect(await idsFor(name)).toEqual([noteId, bookmark.data.item.id].sort());

    const minted = await client.createKey({
      label: "note-reader",
      source: `${ctx.source}-note-reader`,
      type_permissions: { "core.note": "read" },
    });
    expect(minted.ok, JSON.stringify(minted.error)).toBe(true);
    trackKey(ctx, minted.data.id);
    const noteReader = new MarfaClient({
      baseUrl: apiUrl,
      apiKey: minted.data.key,
    });
    expect(await idsFor(name, noteReader)).toEqual([noteId]);

    const refused = await getManagementClient().findItemsByTitle([name]);
    expect(refused.status).toBe(403);
    expect((refused.error as { error?: { code?: string } }).error?.code).toBe(
      "type_not_permitted",
    );
  });

  it("takes at most 200 names of at most 1,000 characters", async () => {
    const most = await client.findItemsByTitle(
      Array.from({ length: 200 }, (_, at) => `absent ${String(at)}`),
    );
    expect(most.status, JSON.stringify(most.error)).toBe(200);
    expect(most.data.results).toHaveLength(200);

    const tooMany = await client.findItemsByTitle(
      Array.from({ length: 201 }, (_, at) => `absent ${String(at)}`),
    );
    expect(tooMany.status).toBe(400);
    expect((tooMany.error as { error?: { code?: string } }).error?.code).toBe(
      "validation_error",
    );

    const titled = "t".repeat(1000);
    const id = await note(titled);
    expect(await idsFor(titled)).toEqual([id]);
    const tooLong = await client.findItemsByTitle(["t".repeat(1001)]);
    expect(tooLong.status).toBe(400);
  });

  it("counts a name in characters, so 1,000 emoji are taken and 1,001 refused", async () => {
    const emoji = "\u{1F600}";
    const taken = await client.findItemsByTitle([emoji.repeat(1000)]);
    expect(taken.status, JSON.stringify(taken.error)).toBe(200);
    const refused = await client.findItemsByTitle([emoji.repeat(1001)]);
    expect(refused.status).toBe(400);
  });

  it("matches no name to a title longer than 1,000 characters after trimming", async () => {
    // A decomposed `é` is two characters and folds to the composed one, so a
    // name of fewer characters than the limit folds to a title past it.
    const stem = `${uuidv7()} `;
    const decomposed = (count: number) => `${stem}${"e\u0301".repeat(count)}`;
    const composed = (count: number) => `${stem}${"\u00e9".repeat(count)}`;
    const count = (1000 - stem.length) >> 1;

    const within = `${decomposed(count)}${"x".repeat(1000 - stem.length - 2 * count)}`;
    expect(within).toHaveLength(1000);
    const withinId = await note(`  ${within}  `);
    expect(
      await idsFor(
        `${composed(count)}${"x".repeat(1000 - stem.length - 2 * count)}`,
      ),
      "a title of 1,000 characters once trimmed was not found",
    ).toEqual([withinId]);

    const past = decomposed(count + 1);
    expect(past.length).toBeGreaterThan(1000);
    await note(past);
    expect(composed(count + 1).length).toBeLessThanOrEqual(1000);
    expect(await idsFor(composed(count + 1))).toEqual([]);
  });

  it("refuses a body that is not a list of names", async () => {
    for (const body of [
      {},
      { names: "a" },
      { names: [1] },
      { names: ["a"], x: 1 },
    ]) {
      const res = await client.rawRequest("/items/titles", {
        method: "POST",
        body,
      });
      expect(res.status, JSON.stringify(body)).toBe(400);
    }
  });
});
