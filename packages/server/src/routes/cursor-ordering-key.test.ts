/**
 * A pagination cursor names the listing and the ordering that issued it,
 * and one issued anywhere else is refused.
 *
 * The cursor is an encoded pair, the last row's sort value and its id.
 * Every ordering a listing offers compares either an ISO timestamp or a
 * JSON-extracted value, so a cursor replayed under a different ordering
 * decodes cleanly, compares successfully, and returns a page bounded by
 * the wrong thing. Nothing errors. The page is simply not the next page,
 * and rows are skipped or delivered twice with no signal. Two listings
 * paging by the same column are the same case with a different table.
 *
 * `decodeKeyedCursorNullable` is what refuses that. This file is its
 * test, at the route level.
 */
import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { createTestContext, request } from "../test-utils.js";
import type { TestContext } from "../test-utils.js";
import { HYDRATE_PER_TYPE_CAP } from "./_edges-hydrate.js";
import { AUDIT_CURSOR_KEY } from "../storage/interface.js";

let ctx: TestContext;

beforeAll(async () => {
  ctx = await createTestContext();
});

afterAll(async () => {
  await ctx.cleanup();
});

interface Page {
  data: {
    id: string;
    created_at: string;
    updated_at: string;
    occurred_at?: string | null;
  }[];
  cursor: string | null;
  has_more: boolean;
}

async function listItems(
  query: string,
): Promise<{ status: number; page?: Page; code?: string; message?: string }> {
  const res = await request(ctx.app, "GET", `/items?${query}`, {
    key: ctx.workingKey,
  });
  if (res.status !== 200) {
    const body = (await res.json()) as {
      error: { code: string; message: string };
    };
    return {
      status: res.status,
      code: body.error.code,
      message: body.error.message,
    };
  }
  return { status: 200, page: (await res.json()) as Page };
}

/** The first page's cursor under a query, with the witness that the same
 *  query continues on it: every refusal below sits beside this. */
async function firstCursor(query: string): Promise<string> {
  const { status, page } = await listItems(`${query}&limit=1`);
  expect(status).toBe(200);
  expect(page?.has_more).toBe(true);
  expect(page?.cursor).toBeTruthy();
  const next = await listItems(`${query}&limit=1&cursor=${page!.cursor!}`);
  expect(next.status).toBe(200);
  expect(next.page?.data).toHaveLength(1);
  expect(next.page?.data[0]?.id).not.toBe(page!.data[0]?.id);
  return page!.cursor!;
}

/** The refusal, asserted by shape rather than by status alone: a 400 that
 *  happened to come from somewhere else would otherwise read as a pass. */
function expectOrderingRefusal(result: {
  status: number;
  code?: string;
  message?: string;
}): void {
  expect(result.status).toBe(400);
  expect(result.code).toBe("validation_error");
  expect(result.message).toContain("different listing or ordering");
}

const bookIds: string[] = [];

beforeAll(async () => {
  for (const [i, pages] of [12, 34, 56, 78].entries()) {
    const res = await request(ctx.app, "POST", "/items", {
      key: ctx.workingKey,
      body: {
        type: "core.media.book",
        properties: {
          title: `Cursor ${String(i)}`,
          body: "",
          page_count: pages,
        },
      },
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { item: { id: string } };
    bookIds.push(body.item.id);
  }
});

const TYPE = "type=core.media.book";
const TYPE_PATH = `/items?${TYPE}`;

describe("GET /items — the cursor is bound to the ordering that issued it", () => {
  it("refuses a cursor from one system sort replayed under another", async () => {
    const cursor = await firstCursor(`${TYPE}&sort=updated_at`);
    // The premise case: both columns hold an ISO timestamp, so this
    // comparison succeeds against the wrong column when it is not refused.
    expectOrderingRefusal(
      await listItems(`${TYPE}&sort=occurred_at&cursor=${cursor}`),
    );
    expectOrderingRefusal(
      await listItems(`${TYPE}&sort=created_at&cursor=${cursor}`),
    );
  });

  it("refuses a cursor from a property sort replayed under a system sort", async () => {
    const cursor = await firstCursor(`${TYPE}&sort=properties.page_count`);
    expectOrderingRefusal(
      await listItems(`${TYPE}&sort=created_at&cursor=${cursor}`),
    );
    // And the other way: a key naming only the column would accept a
    // default cursor under the property ordering and bound a JSON value
    // against a timestamp.
    const fromDefault = await firstCursor(TYPE);
    expectOrderingRefusal(
      await listItems(
        `${TYPE}&sort=properties.page_count&cursor=${fromDefault}`,
      ),
    );
  });

  it("refuses a cursor from one property sort replayed under another", async () => {
    const cursor = await firstCursor(`${TYPE}&sort=properties.page_count`);
    expectOrderingRefusal(
      await listItems(`${TYPE}&sort=properties.title&cursor=${cursor}`),
    );
  });

  it("refuses a cursor replayed under the opposite direction", async () => {
    const cursor = await firstCursor(`${TYPE}&sort=created_at&direction=desc`);
    // Not a wrong column but a flipped comparison, which re-serves the rows
    // already delivered rather than skipping ahead. Just as silent.
    expectOrderingRefusal(
      await listItems(`${TYPE}&sort=created_at&direction=asc&cursor=${cursor}`),
    );
  });

  it("refuses a cursor from the catch-up ordering replayed on the default", async () => {
    const cursor = await firstCursor(
      `${TYPE}&updated_after=1970-01-01T00:00:00.000Z`,
    );
    expectOrderingRefusal(await listItems(`${TYPE}&cursor=${cursor}`));
  });

  it("honors a cursor whose ordering is spelled out rather than defaulted", async () => {
    // The reason the key is computed from the resolved ordering rather
    // than from the raw parameters: a client that omits `sort` on one page
    // and names the default on the next is asking for the same ordering
    // and must not be refused.
    const cursor = await firstCursor(TYPE);
    const { status, page } = await listItems(
      `${TYPE}&sort=created_at&direction=desc&cursor=${cursor}&limit=1`,
    );
    expect(status).toBe(200);
    expect(page?.data).toHaveLength(1);
    expect(page?.data[0]?.id).toBeDefined();
  });

  it("refuses a cursor carrying no ordering at all", async () => {
    // Nothing this server mints lacks the key, so a cursor without one
    // was not minted here and is not guessed at. The page's own cursor is
    // the witness that the same position is honored with its key.
    const { page } = await listItems(`${TYPE}&limit=1`);
    const last = page!.data[0]!;
    const honored = await listItems(`${TYPE}&cursor=${page!.cursor!}&limit=1`);
    expect(honored.status).toBe(200);
    expect(honored.page?.data).toHaveLength(1);
    expect(honored.page?.data[0]?.id).not.toBe(last.id);

    const unkeyed = Buffer.from(
      JSON.stringify({ v: last.created_at, id: last.id }),
    ).toString("base64url");
    expectOrderingRefusal(await listItems(`${TYPE}&cursor=${unkeyed}&limit=1`));
  });
});

/**
 * A key spelled another way is not a key: a column name with no direction
 * is refused like a mismatch, because a cursor carrying it was not minted
 * by this listing and nothing is guessed at. The cursors are built by hand
 * for that reason, each beside the cursor the listing minted for the same
 * position, which differs from it only in the key and is honored.
 */
describe("a cursor whose key is not one this listing mints", () => {
  function cursorTagged(sortValue: string, id: string, k: string): string {
    return Buffer.from(JSON.stringify({ v: sortValue, id, k })).toString(
      "base64url",
    );
  }

  async function honoredAt(query: string, cursor: string, lastId: string) {
    const honored = await listItems(`${query}&cursor=${cursor}&limit=1`);
    expect(honored.status).toBe(200);
    expect(honored.page?.data).toHaveLength(1);
    expect(honored.page?.data[0]?.id).not.toBe(lastId);
  }

  it("refuses a bare `created_at` on the default listing it names", async () => {
    const { page } = await listItems(`${TYPE}&limit=1`);
    const last = page!.data[0]!;
    await honoredAt(TYPE, page!.cursor!, last.id);
    expectOrderingRefusal(
      await listItems(
        `${TYPE}&cursor=${cursorTagged(last.created_at, last.id, "created_at")}&limit=1`,
      ),
    );
  });

  it("refuses a bare `updated_at` under the catch-up filter it names", async () => {
    const catchUp = `${TYPE}&updated_after=1970-01-01T00:00:00.000Z`;
    const { page } = await listItems(`${catchUp}&limit=1`);
    const last = page!.data[0]!;
    await honoredAt(catchUp, page!.cursor!, last.id);
    expectOrderingRefusal(
      await listItems(
        `${catchUp}&cursor=${cursorTagged(last.updated_at, last.id, "updated_at")}&limit=1`,
      ),
    );
  });

  it("refuses a bare `occurred_at` under the ordering it names", async () => {
    const byOccurrence = `${TYPE}&sort=occurred_at&direction=desc`;
    const { page } = await listItems(`${byOccurrence}&limit=1`);
    const last = page!.data[0]!;
    await honoredAt(byOccurrence, page!.cursor!, last.id);
    expectOrderingRefusal(
      await listItems(
        `${byOccurrence}&cursor=${cursorTagged(last.occurred_at ?? last.created_at, last.id, "occurred_at")}&limit=1`,
      ),
    );
  });
});

describe("GET /edges — the same rule on the sibling listing", () => {
  async function seedEdges(count: number): Promise<void> {
    for (let i = 0; i < count; i++) {
      const mk = async (): Promise<string> => {
        const res = await request(ctx.app, "POST", "/items", {
          key: ctx.workingKey,
          body: {
            type: "core.note",
            properties: { body: `edge-src-${String(i)}` },
          },
        });
        expect(res.status).toBe(201);
        return ((await res.json()) as { item: { id: string } }).item.id;
      };
      const source = await mk();
      const target = await mk();
      const res = await request(ctx.app, "POST", "/edges", {
        key: ctx.workingKey,
        body: {
          source_id: source,
          target_id: target,
          edge_type: "about",
        },
      });
      expect(res.status).toBe(201);
    }
  }

  async function listEdges(query: string): Promise<{
    status: number;
    cursor?: string | null;
    code?: string;
    message?: string;
  }> {
    const res = await request(ctx.app, "GET", `/edges?${query}`, {
      key: ctx.workingKey,
    });
    if (res.status !== 200) {
      const body = (await res.json()) as {
        error: { code: string; message: string };
      };
      return {
        status: res.status,
        code: body.error.code,
        message: body.error.message,
      };
    }
    const body = (await res.json()) as { cursor: string | null };
    return { status: 200, cursor: body.cursor };
  }

  it("refuses a cursor crossing between the default and the catch-up", async () => {
    await seedEdges(3);

    const fromDefault = await listEdges("limit=1");
    expect(fromDefault.status).toBe(200);
    expect(fromDefault.cursor).toBeTruthy();
    expectOrderingRefusal(
      await listEdges(
        `updated_after=1970-01-01T00:00:00.000Z&cursor=${fromDefault.cursor!}`,
      ),
    );

    const fromCatchUp = await listEdges(
      "updated_after=1970-01-01T00:00:00.000Z&limit=1",
    );
    expect(fromCatchUp.status).toBe(200);
    expect(fromCatchUp.cursor).toBeTruthy();
    expectOrderingRefusal(await listEdges(`cursor=${fromCatchUp.cursor!}`));
  });
});

/**
 * The listings with one ordering each page by the same column the item
 * listing defaults to, so the column alone would let a cursor cross
 * between them and compare perfectly well against the wrong table. The
 * key names the listing, and a cursor continues the page it came from
 * and nothing else.
 */
describe("a cursor continues the page it came from and nothing else", () => {
  interface Listed {
    status: number;
    ids?: string[];
    cursor?: string | null;
    code?: string;
    message?: string;
  }

  async function list(path: string): Promise<Listed> {
    const res = await request(ctx.app, "GET", path, { key: ctx.workingKey });
    if (res.status !== 200) {
      const body = (await res.json()) as {
        error: { code: string; message: string };
      };
      return {
        status: res.status,
        code: body.error.code,
        message: body.error.message,
      };
    }
    const body = (await res.json()) as {
      data: { id: string }[];
      cursor: string | null;
    };
    return {
      status: 200,
      ids: body.data.map((row) => row.id),
      cursor: body.cursor,
    };
  }

  /** The first page of one row and its cursor, with the witness that the
   *  cursor advances the listing that minted it. */
  async function firstPage(
    path: string,
  ): Promise<{ id: string; cursor: string }> {
    const joiner = path.includes("?") ? "&" : "?";
    const page = await list(`${path}${joiner}limit=1`);
    expect(page.status).toBe(200);
    expect(page.cursor).toBeTruthy();
    const id = page.ids![0]!;
    const next = await list(
      `${path}${joiner}limit=1&cursor=${encodeURIComponent(page.cursor!)}`,
    );
    expect(next.status).toBe(200);
    expect(next.ids).toHaveLength(1);
    expect(next.ids![0]).not.toBe(id);
    return { id, cursor: page.cursor! };
  }

  async function note(body: string): Promise<string> {
    const res = await request(ctx.app, "POST", "/items", {
      key: ctx.workingKey,
      body: { type: "core.note", properties: { body } },
    });
    expect(res.status).toBe(201);
    return ((await res.json()) as { item: { id: string } }).item.id;
  }

  async function link(source: string, target: string): Promise<string> {
    const res = await request(ctx.app, "POST", "/edges", {
      key: ctx.workingKey,
      body: { source_id: source, target_id: target, edge_type: "about" },
    });
    expect(res.status).toBe(201);
    return ((await res.json()) as { edge: { id: string } }).edge.id;
  }

  interface Block {
    edges: { id: string }[];
    has_more: boolean;
    next_cursor?: string;
  }

  it("reports a malformed cursor as malformed, not as another listing's", async () => {
    // The shape is checked before the key, so a cursor that is not one at
    // all is not told it came from elsewhere.
    const malformed = (payload: unknown) =>
      Buffer.from(JSON.stringify(payload)).toString("base64url");
    // On both decodes: the item listing's admits a null sort value and
    // the audit log's does not, and a cursor carrying no key or another
    // listing's is still told it is malformed first.
    for (const [path, cursor] of [
      [TYPE_PATH, malformed("just a string")],
      [TYPE_PATH, malformed({ v: 1, id: "x", k: "items:created_at:desc" })],
      [TYPE_PATH, malformed({ v: "1", k: "audit:created_at:desc" })],
      ["/audit?limit=1", malformed("just a string")],
      ["/audit?limit=1", malformed({ v: 1, id: "x", k: AUDIT_CURSOR_KEY })],
      // A null sort value is malformed on a listing whose column is NOT
      // NULL, whichever key it carries.
      ["/audit?limit=1", malformed({ v: null, id: "x", k: AUDIT_CURSOR_KEY })],
      ["/audit?limit=1", malformed({ v: null, id: "x" })],
    ] as const) {
      const joiner = path.includes("?") ? "&" : "?";
      const result = await list(`${path}${joiner}cursor=${cursor}`);
      expect(result.status).toBe(400);
      expect(result.code).toBe("validation_error");
      expect(result.message).toBe("Invalid pagination cursor");
    }
  });

  it("keeps the item listing and the edge listing apart", async () => {
    // Both default to `created_at` descending and both page under
    // `(updated_at, id)` ascending with `updated_after`, so without the
    // listing in the key each would honor the other's cursor.
    const items = await firstPage(TYPE_PATH);
    const edges = await firstPage("/edges");
    expectOrderingRefusal(
      await list(`/edges?cursor=${encodeURIComponent(items.cursor)}`),
    );
    expectOrderingRefusal(
      await list(`${TYPE_PATH}&cursor=${encodeURIComponent(edges.cursor)}`),
    );

    const since = "updated_after=1970-01-01T00:00:00.000Z";
    const itemsSince = await firstPage(`${TYPE_PATH}&${since}`);
    const edgesSince = await firstPage(`/edges?${since}`);
    expectOrderingRefusal(
      await list(
        `/edges?${since}&cursor=${encodeURIComponent(itemsSince.cursor)}`,
      ),
    );
    expectOrderingRefusal(
      await list(
        `${TYPE_PATH}&${since}&cursor=${encodeURIComponent(edgesSince.cursor)}`,
      ),
    );
  });

  it("continues a hydrated outbound block at the listing it names", async () => {
    // The mirror of the inbound case, from both places an item's edges
    // are hydrated: the single read and the listing. The block is cut at
    // the cap and no earlier, its cursor is the last visible edge's
    // position under the edges listing's own column, and it reaches
    // exactly the one edge the block cut.
    const hub = await note("hub-outbound");
    const edgeIds: string[] = [];
    for (let i = 0; i < HYDRATE_PER_TYPE_CAP; i++) {
      edgeIds.push(await link(hub, await note(`out-${String(i)}`)));
    }
    const read = async (): Promise<Block> => {
      const res = await request(ctx.app, "GET", `/items/${hub}`, {
        key: ctx.workingKey,
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        item: { edges: Record<string, Block> };
      };
      return body.item.edges.about!;
    };
    const exactly = await read();
    expect(exactly.edges).toHaveLength(HYDRATE_PER_TYPE_CAP);
    expect(exactly.has_more).toBe(false);
    expect(exactly.next_cursor).toBeUndefined();

    edgeIds.push(await link(hub, await note("out-last")));
    // The edge the block will cut at is the second oldest; a write moves
    // its `updated_at` past every `created_at`, so a cursor minted from
    // the wrong column would re-serve the whole block.
    const patched = await request(ctx.app, "PATCH", `/edges/${edgeIds[1]!}`, {
      key: ctx.workingKey,
      body: { properties: { touched: true }, version: 1 },
    });
    expect(patched.status).toBe(200);

    const over = await read();
    expect(over.edges).toHaveLength(HYDRATE_PER_TYPE_CAP);
    expect(over.has_more).toBe(true);
    expect(over.edges.at(-1)?.id).toBe(edgeIds[1]);
    const shown = new Set(over.edges.map((edge) => edge.id));
    const follow = async (cursor: string) => {
      const rest = await list(
        `/items/${hub}/edges?edge_type=about&cursor=${encodeURIComponent(cursor)}`,
      );
      expect(rest.status).toBe(200);
      expect(rest.ids).toEqual([edgeIds[0]]);
      expect(shown.has(rest.ids![0]!)).toBe(false);
      expectOrderingRefusal(
        await list(
          `/items/${hub}/backrefs?edge_type=about&cursor=${encodeURIComponent(cursor)}`,
        ),
      );
    };
    await follow(over.next_cursor!);

    // The listing hydrates the same block from one query for the page.
    const listed = await request(
      ctx.app,
      "GET",
      `/items?type=core.note&include=edges&limit=1&filter=${encodeURIComponent(`id eq "${hub}"`)}`,
      { key: ctx.workingKey },
    );
    expect(listed.status).toBe(200);
    const page = (await listed.json()) as {
      data: { id: string; edges: Record<string, Block> }[];
    };
    expect(page.data.map((row) => row.id)).toEqual([hub]);
    const fromListing = page.data[0]!.edges.about!;
    expect(fromListing.has_more).toBe(true);
    await follow(fromListing.next_cursor!);
  });

  it("refuses an item cursor on the audit log, whose column it names", async () => {
    const action = "test.cursor.listing";
    for (const resource of ["one", "two"]) {
      await ctx.storage.audit.logOrThrow({
        action,
        resource_type: "test",
        resource_id: resource,
      });
    }
    const audit = `/audit?action=${action}`;
    const own = await firstPage(audit);

    // The item listing's default pages by `created_at` descending, the
    // audit log's only ordering; its cursor compares cleanly against the
    // audit rows and, honored, answers a page of them older than an item.
    const items = await firstPage(TYPE_PATH);
    expectOrderingRefusal(
      await list(`${audit}&cursor=${encodeURIComponent(items.cursor)}`),
    );
    // And the other way, for the same reason.
    expectOrderingRefusal(
      await list(`${TYPE_PATH}&cursor=${encodeURIComponent(own.cursor)}`),
    );
  });

  it("keeps an item's outbound and inbound edges apart", async () => {
    const hub = await note("hub");
    for (const body of ["out-a", "out-b"]) await link(hub, await note(body));
    for (const body of ["in-a", "in-b"]) await link(await note(body), hub);

    const outbound = await firstPage(`/items/${hub}/edges`);
    const inbound = await firstPage(`/items/${hub}/backrefs`);
    expectOrderingRefusal(
      await list(
        `/items/${hub}/backrefs?cursor=${encodeURIComponent(outbound.cursor)}`,
      ),
    );
    expectOrderingRefusal(
      await list(
        `/items/${hub}/edges?cursor=${encodeURIComponent(inbound.cursor)}`,
      ),
    );

    // The whole-instance edge listing pages by the same column too.
    const every = await firstPage("/edges");
    expectOrderingRefusal(
      await list(
        `/items/${hub}/edges?cursor=${encodeURIComponent(every.cursor)}`,
      ),
    );
    expectOrderingRefusal(
      await list(`/edges?cursor=${encodeURIComponent(outbound.cursor)}`),
    );
  });

  it("continues a hydrated inbound block at the listing it names", async () => {
    // A block cut at the cap carries a cursor the item response minted on
    // the backrefs listing's behalf; it is read there like the listing's
    // own, and refused on the sibling listing like anyone else's.
    const hub = await note("hub-inbound");
    for (let i = 0; i <= HYDRATE_PER_TYPE_CAP; i++) {
      await link(await note(`in-${String(i)}`), hub);
    }
    const res = await request(
      ctx.app,
      "GET",
      `/items/${hub}?include=backrefs`,
      {
        key: ctx.workingKey,
      },
    );
    expect(res.status).toBe(200);
    const block = (
      (await res.json()) as {
        backrefs: Record<
          string,
          { edges: { id: string }[]; has_more: boolean; next_cursor?: string }
        >;
      }
    ).backrefs.about;
    expect(block?.has_more).toBe(true);
    expect(block?.edges).toHaveLength(HYDRATE_PER_TYPE_CAP);
    const cursor = encodeURIComponent(block!.next_cursor!);

    const rest = await list(
      `/items/${hub}/backrefs?edge_type=about&cursor=${cursor}`,
    );
    expect(rest.status).toBe(200);
    expect(rest.ids).toHaveLength(1);
    const shown = new Set(block!.edges.map((edge) => edge.id));
    expect(shown.has(rest.ids![0]!)).toBe(false);

    expectOrderingRefusal(
      await list(`/items/${hub}/edges?edge_type=about&cursor=${cursor}`),
    );
  });
});
