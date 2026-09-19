/**
 * What a door answers when the caller names no state.
 *
 * Three doors read the same items through the same filter, and the answer
 * to an omitted `state` is not the same on all three. A listing and a
 * search answer what the reader is working with, which is the active
 * state. An export answers a copy of the corpus, and the archive it writes
 * is what `POST /admin/restore-archive` reads back, so dropping the rows a
 * person deliberately archived would lose them on the round trip.
 *
 * The divergence is the point of this file. Each door is asserted on the
 * same three rows, so a change that made one of them follow another has to
 * come through here, and the export case cannot be read as an oversight.
 *
 * **Every case asserts on which ids come back, never on a count.** A door
 * that dropped its state predicate entirely and one that answered nothing
 * both produce a plausible-looking number, and the active row is what says
 * the query reached anything at all.
 */
import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { createTestContext, request } from "../test-utils.js";
import type { TestContext } from "../test-utils.js";

let ctx: TestContext;
let activeId = "";
let archivedId = "";
let trashedId = "";

/** The three rows this file seeded. Every helper narrows to these, because
 *  the database carries whatever ran before. */
const mine = new Set<string>();

/** Distinctive enough to search for, and unique per run so a shared
 *  database cannot answer with another file's rows. */
const MARKER = `statedefault${Math.random().toString(36).slice(2, 8)}`;

beforeAll(async () => {
  ctx = await createTestContext();

  const create = async (state: string): Promise<string> => {
    const res = await request(ctx.app, "POST", "/items", {
      key: ctx.workingKey,
      body: {
        type: "core.note",
        state,
        properties: { body: `${MARKER} ${state}` },
        tags: [MARKER],
        source_id: `${MARKER}-${state}`,
      },
    });
    expect(
      res.status,
      `the fixture cannot seed a row in ${state}, so every assertion below is about an empty set`,
    ).toBe(201);
    const body = (await res.json()) as { item: { id: string; state: string } };
    expect(
      body.item.state,
      `the seeded row did not land in ${state}, so the case below is not about the state it names`,
    ).toBe(state);
    return body.item.id;
  };

  activeId = await create("active");
  archivedId = await create("archived");
  trashedId = await create("trashed");
  for (const id of [activeId, archivedId, trashedId]) mine.add(id);
});

afterAll(async () => {
  await ctx.cleanup();
});

async function listedIds(query: string): Promise<string[]> {
  const res = await request(ctx.app, "GET", `/items?${query}`, {
    key: ctx.workingKey,
  });
  // A refused read answers no rows, and every `not.toContain` below would
  // then pass for the wrong reason, which is the failure this file's header
  // warns about.
  expect(
    res.status,
    `the listing door refused this read, so the case that called it is about a refusal rather than a selection: ${query}`,
  ).toBe(200);
  const body = (await res.json()) as { data: { id: string }[] };
  return body.data.map((item) => item.id).filter((id) => mine.has(id));
}

async function searchedIds(query: string): Promise<string[]> {
  const res = await request(ctx.app, "GET", `/search?${query}`, {
    key: ctx.workingKey,
  });
  expect(
    res.status,
    `the search door refused this read, so the case that called it is about a refusal rather than a selection: ${query}`,
  ).toBe(200);
  const body = (await res.json()) as { results: { item: { id: string } }[] };
  return body.results.map((hit) => hit.item.id).filter((id) => mine.has(id));
}

async function exportedIds(query: string): Promise<string[]> {
  const res = await request(ctx.app, "GET", `/export?${query}`, {
    key: ctx.workingKey,
  });
  expect(
    res.status,
    `the export door refused this read, so the case that called it is about a refusal rather than a selection: ${query}`,
  ).toBe(200);
  return (await res.text())
    .trim()
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as { item?: { id: string } })
    .flatMap((row) => (row.item && mine.has(row.item.id) ? [row.item.id] : []));
}

describe("GET /items with no state named", () => {
  it("answers the active state and nothing else", async () => {
    const ids = await listedIds(`tags=${MARKER}&limit=200`);
    expect(
      ids,
      "a listing naming no state stopped answering live rows, so the default hides the corpus",
    ).toContain(activeId);
    expect(
      ids,
      "a listing naming no state answers archived rows, so the default is the live states rather than the active one",
    ).not.toContain(archivedId);
    expect(
      ids,
      "a listing naming no state answers the bin, so a deleted row is still reported as present",
    ).not.toContain(trashedId);
  });

  it("still answers a state the caller names, and every state under the sentinel", async () => {
    expect(
      await listedIds(`tags=${MARKER}&state=archived&limit=200`),
      "naming a state no longer reaches it, so the rows the default hides are unreachable by any read",
    ).toEqual([archivedId]);
    expect(
      await listedIds(`tags=${MARKER}&state=trashed&limit=200`),
      "naming the bin no longer reaches it, so a deleted row cannot be found in order to be restored",
    ).toEqual([trashedId]);
    // By identity rather than by count: a sentinel read as a plain state
    // value would compare against the column, match nothing, and leave a
    // length assertion to fail for a reason nobody could see.
    expect(
      (await listedIds(`tags=${MARKER}&state=any&limit=200`)).sort(),
      "the sentinel stopped widening, so nothing can read across states in one pass",
    ).toEqual([activeId, archivedId, trashedId].sort());
  });
});

describe("GET /search with no state named", () => {
  it("answers the active state, as the listing does", async () => {
    const ids = await searchedIds(`q=${MARKER}&limit=100`);
    expect(
      ids,
      "a search naming no state stopped matching live rows, so the index answers nothing",
    ).toContain(activeId);
    expect(
      ids,
      "a search answers rows a listing hides, which is two answers to one question",
    ).not.toContain(archivedId);
    expect(
      ids,
      "a search answers the bin, so a deleted row is still findable and reads as present",
    ).not.toContain(trashedId);
  });

  it("still answers a state the caller names", async () => {
    expect(
      await searchedIds(`q=${MARKER}&state=archived&limit=100`),
      "naming a state no longer reaches it, so the rows a listing hides are unreachable by any read",
    ).toEqual([archivedId]);
  });
});

describe("GET /export with no state named", () => {
  it("carries archived rows, because an export is a copy rather than a listing", async () => {
    const ids = await exportedIds(`type=core.note`);
    expect(
      ids.sort(),
      "an export follows the listing default, so a backup and the restore that reads it lose every archived row",
    ).toEqual([activeId, archivedId].sort());
  });

  it("leaves the bin behind, which `state=any` takes", async () => {
    // By identity, as this file's header requires: a sentinel read as a
    // plain state value compares against the column, matches nothing, and
    // satisfies a length assertion for a reason nobody can see.
    expect(
      (await exportedIds(`type=core.note&state=any`)).sort(),
      "the sentinel stopped widening on the export door, so nothing copies the whole corpus in one pass",
    ).toEqual([activeId, archivedId, trashedId].sort());
    expect(
      await exportedIds(`type=core.note`),
      "an export carries the bin by default, so a restore resurrects deleted rows",
    ).not.toContain(trashedId);
  });
});
