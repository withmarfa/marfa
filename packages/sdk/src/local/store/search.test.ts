/**
 * What a person typed, turned into an FTS5 query.
 *
 * Two halves, and both are needed. The string assertions say what the
 * translation is; the round trip through a real index says the result is
 * something FTS5 will actually accept, which is the failure mode here — a
 * malformed query is a runtime error from SQLite rather than a wrong
 * answer, so a translation nobody ran is a search that throws.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildFtsQuery } from "./search.js";
import { openLocalStore, type LocalStore } from "./index.js";
import { SINGLE_ACCOUNT, SINGLE_SPACE } from "../types.js";

describe("the FTS query builder", () => {
  it("quotes each token and makes the last one a prefix", () => {
    // The prefix is what makes a search feel live as somebody types, and
    // it belongs on the last token only: putting it on every token would
    // make "the reed" match "theatre reeds".
    expect(buildFtsQuery("reeds")).toBe('"reeds"*');
    expect(buildFtsQuery("the reeds")).toBe('"the" "reeds"*');
    // Runs of whitespace collapse rather than producing empty tokens,
    // which FTS5 would refuse.
    expect(buildFtsQuery("  the   reeds  ")).toBe('"the" "reeds"*');
  });

  it("keeps a quoted string as one phrase, with no prefix", () => {
    // A person who typed quotes asked for a phrase, so the wildcard would
    // be answering a different question than the one they asked.
    expect(buildFtsQuery('"reeds arrived"')).toBe('"reeds arrived"');
    // An inner quote is doubled, which is FTS5's own escape. Left alone it
    // would close the phrase early and leave a dangling token.
    expect(buildFtsQuery('"a "loud" reed"')).toBe('"a ""loud"" reed"');
  });

  it("answers an empty query with an empty phrase rather than nothing", () => {
    // The guard exists because an empty MATCH argument is a syntax error,
    // not an empty result: without it a cleared search box throws.
    expect(buildFtsQuery("")).toBe('""');
    expect(buildFtsQuery("   ")).toBe('""');
    // Two characters, so the phrase branch's length test does not claim it.
    expect(buildFtsQuery('""')).toBe('""""""*');
  });

  it("quotes a hyphen rather than letting FTS5 read it", () => {
    // Unquoted, a leading hyphen is a syntax error in FTS5 and an interior
    // one splits the term. Quoting makes it an ordinary character, which
    // is what a person typing a hyphenated word means by it.
    expect(buildFtsQuery("well-tempered")).toBe('"well-tempered"*');
    expect(buildFtsQuery("-reeds")).toBe('"-reeds"*');
  });
});

describe("the FTS query builder, against a real index", () => {
  let store: LocalStore;
  let dir: string;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "marfa-local-fts-"));
    store = await openLocalStore({
      path: join(dir, "store.db"),
      identity: {
        origin: "http://localhost",
        spaceId: SINGLE_SPACE,
        accountId: SINGLE_ACCOUNT,
      },
    });
    await store.mutations.createItem({
      type: "core.note",
      properties: {
        title: "The well-tempered reed",
        body: "the reeds arrived late",
      },
    });
  });

  afterEach(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const found = async (query: string): Promise<number> =>
    (await store.search.find(query)).length;

  it("runs every shape the builder produces without a syntax error", async () => {
    // Each of these reaches SQLite as a MATCH argument. A translation that
    // produced something FTS5 cannot parse fails here as a thrown error
    // rather than as a wrong count, which is why the empty and hyphenated
    // cases are run rather than only asserted on as strings.
    expect(await found("reeds")).toBe(1);
    expect(await found("")).toBe(0);
    expect(await found("   ")).toBe(0);
    expect(await found("well-tempered")).toBe(1);
    expect(await found("-reeds")).toBe(1);
    expect(await found('"reeds arrived"')).toBe(1);
  });

  it("means a phrase when a phrase was asked for", async () => {
    // The words are both present but not adjacent in this order, so a
    // phrase query must not match while the loose one does. Without this
    // the quoted branch could return the tokens joined by an implicit AND
    // and every other assertion would still read correctly.
    expect(await found('"reeds arrived"')).toBe(1);
    expect(await found('"arrived reeds"')).toBe(0);
    expect(await found("arrived reeds")).toBe(1);
  });
});
