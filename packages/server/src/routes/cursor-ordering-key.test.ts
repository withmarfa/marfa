/**
 * A pagination cursor names the ordering that issued it, and one issued
 * under a different ordering is refused.
 *
 * The cursor is an encoded pair — the last row's sort value and its id.
 * Every ordering these two listings offer compares either an ISO timestamp
 * or a JSON-extracted value, so a cursor replayed under a different
 * ordering decodes cleanly, compares successfully, and returns a page
 * bounded by the wrong thing. Nothing errors. The page is simply not the
 * next page, and rows are skipped or delivered twice with no signal.
 *
 * `assertCursorKey` is what refuses that, and it had no test anywhere on
 * either listing. This file is that test, at the route level.
 */
import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { createTestContext, request } from "../test-utils.js";
import type { TestContext } from "../test-utils.js";

let ctx: TestContext;

beforeAll(async () => {
  ctx = await createTestContext();
});

afterAll(async () => {
  await ctx.cleanup();
});

interface Page {
  data: { id: string; created_at: string; updated_at: string }[];
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

async function firstCursor(query: string): Promise<string> {
  const { status, page } = await listItems(`${query}&limit=1`);
  expect(status).toBe(200);
  expect(page?.has_more).toBe(true);
  expect(page?.cursor).toBeTruthy();
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
  expect(result.message).toContain("different ordering");
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
    // And the other way, which is the direction that used to pass: every
    // sort was tagged `created_at`, so a default cursor was accepted by
    // the property ordering and bounded a JSON value against a timestamp.
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
    // The compatibility case, and the reason the key is computed from the
    // resolved ordering rather than from the raw parameters: a client that
    // omits `sort` on one page and names the default on the next is asking
    // for the same ordering and must not be refused.
    const cursor = await firstCursor(TYPE);
    const { status, page } = await listItems(
      `${TYPE}&sort=created_at&direction=desc&cursor=${cursor}&limit=1`,
    );
    expect(status).toBe(200);
    expect(page?.data).toHaveLength(1);
    expect(page?.data[0]?.id).toBeDefined();
  });

  it("reads a cursor carrying no ordering at all as the default listing", async () => {
    // Cursors issued before the key existed carry only `v` and `id`. An
    // in-flight page across a deploy keeps working on the ordering that was
    // the only one there was, and is refused anywhere else.
    const { page } = await listItems(`${TYPE}&limit=1`);
    const last = page!.data[0]!;
    const unkeyed = Buffer.from(
      JSON.stringify({ v: last.created_at, id: last.id }),
    ).toString("base64url");

    const honored = await listItems(`${TYPE}&cursor=${unkeyed}&limit=1`);
    expect(honored.status).toBe(200);
    expect(honored.page?.data[0]?.id).not.toBe(last.id);

    expectOrderingRefusal(
      await listItems(`${TYPE}&sort=occurred_at&cursor=${unkeyed}`),
    );
  });
});

/**
 * The compatibility path, which only matters once — for the few minutes
 * after a deploy, while cursors minted by the previous build are still in
 * flight — and which nothing else in this file reaches.
 *
 * The build now running mints `k: "created_at:desc"`. The one being
 * replaced mints a bare `k: "created_at"`, and that spelling is not the
 * absent key the case above covers: an absent key is read as the default
 * ordering by `UNKEYED_CURSOR_ORDERING`, while a present-but-old one has
 * to be mapped by `LEGACY_CURSOR_KEYS` or it fails the equality check and
 * every page in flight breaks at the moment of deploy.
 *
 * So the cursors here are built by hand. There is no way to obtain one
 * from this server — the code that issued them is the code being replaced
 * — and a test that could only use what this build mints would leave the
 * mapping unexercised while reporting a full green.
 */
describe("a cursor minted before the key named the direction", () => {
  /** A cursor in the shape the previous build wrote: the sort value, the
   *  id, and a column name with no direction on it. */
  function legacyCursor(sortValue: string, id: string, k: string): string {
    return Buffer.from(JSON.stringify({ v: sortValue, id, k })).toString(
      "base64url",
    );
  }

  it("honors a bare `created_at` on the default listing", async () => {
    const { page } = await listItems(`${TYPE}&limit=1`);
    const last = page!.data[0]!;
    const legacy = legacyCursor(last.created_at, last.id, "created_at");

    const honored = await listItems(`${TYPE}&cursor=${legacy}&limit=1`);
    expect(honored.status).toBe(200);
    expect(honored.page?.data).toHaveLength(1);
    // Advanced rather than merely accepted: a cursor that was honored but
    // ignored would re-serve the row already delivered.
    expect(honored.page?.data[0]?.id).not.toBe(last.id);

    // And only there. `created_at` meant the default listing when it was
    // written, so mapping it must not widen into an ordering it never named.
    expectOrderingRefusal(
      await listItems(`${TYPE}&sort=created_at&direction=asc&cursor=${legacy}`),
    );
  });

  it("honors a bare `updated_at` under the catch-up filter", async () => {
    const catchUp = `${TYPE}&updated_after=1970-01-01T00:00:00.000Z`;
    const { page } = await listItems(`${catchUp}&limit=1`);
    const last = page!.data[0]!;
    // The catch-up walks `(updated_at, id)` ascending, so the sort value a
    // cursor carries there is the modification time.
    const legacy = legacyCursor(last.updated_at, last.id, "updated_at");

    const honored = await listItems(`${catchUp}&cursor=${legacy}&limit=1`);
    expect(honored.status).toBe(200);
    expect(honored.page?.data).toHaveLength(1);
    expect(honored.page?.data[0]?.id).not.toBe(last.id);

    // `updated_at` named the catch-up and nothing else. The same column
    // sorted the other way is a different ordering and is refused.
    expectOrderingRefusal(
      await listItems(
        `${TYPE}&sort=updated_at&direction=desc&cursor=${legacy}`,
      ),
    );
  });

  it("refuses a cursor tagged with a name off Object.prototype", async () => {
    // The legacy map is an object literal, so a lookup by `in` reaches
    // `toString` and answers with a function. Nothing is honored either
    // way — a function is not the string the comparison expects — but the
    // refusal has to come from the lookup rather than from the comparison
    // happening to disagree.
    const { page } = await listItems(`${TYPE}&limit=1`);
    const last = page!.data[0]!;
    expectOrderingRefusal(
      await listItems(
        `${TYPE}&cursor=${legacyCursor(last.created_at, last.id, "toString")}`,
      ),
    );
  });

  it("refuses a legacy spelling that named no ordering this server has", async () => {
    // The safe direction, and the reason the map is a map rather than a
    // "strip the direction and compare" rule: `occurred_at` was never a
    // legacy key, so a cursor carrying it is guessed at by nobody.
    const { page } = await listItems(`${TYPE}&limit=1`);
    const last = page!.data[0]!;
    expectOrderingRefusal(
      await listItems(
        `${TYPE}&sort=occurred_at&cursor=${legacyCursor(last.created_at, last.id, "occurred_at")}`,
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
