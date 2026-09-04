/**
 * An unrecognized query parameter or filter field is refused, not dropped.
 *
 * The validator strips keys it does not declare, so a caller who misspells
 * a filter got a 200 carrying everything the filter was meant to exclude.
 * Nothing in the response separated that from a filter that matched every
 * row, which is what makes it silent: a filter that does not exist and one
 * that matched everything are the same response.
 *
 * **Asserted by the rows the response carries, not only by its status.**
 * A status assertion alone would still pass if the refusal were later
 * softened into a warning on a 200 — and a 200 carrying the excluded rows
 * is exactly the defect. So every case here seeds rows outside the
 * intended filter and asserts they do not come back.
 */
import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { createTestContext, request } from "../test-utils.js";
import type { TestContext } from "../test-utils.js";

let ctx: TestContext;
/** Rows the filters below are meant to exclude. If a request comes back
 *  carrying one of these, the key it sent was dropped rather than refused. */
const excluded: string[] = [];
const FUTURE = "2099-01-01T00:00:00.000Z";

beforeAll(async () => {
  ctx = await createTestContext();
  for (let i = 0; i < 3; i++) {
    const res = await request(ctx.app, "POST", "/items", {
      key: ctx.adminKey,
      body: {
        type: "core.note",
        properties: { body: `unknown-key-probe-${String(i)}` },
      },
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { item: { id: string } };
    excluded.push(body.item.id);
  }
});

afterAll(async () => {
  await ctx.cleanup();
});

/**
 * The ids a GET carries. A refusal carries none, which is the point: this
 * returns the rows rather than the status so the assertion is about what
 * reached the caller.
 */
async function idsFrom(
  path: string,
): Promise<{ status: number; ids: string[] }> {
  const res = await request(ctx.app, "GET", path, { key: ctx.adminKey });
  if (res.status !== 200) return { status: res.status, ids: [] };
  const body = (await res.json()) as {
    data?: { id: string }[];
    results?: { item: { id: string } }[];
  };
  const ids = body.data
    ? body.data.map((r) => r.id)
    : (body.results ?? []).map((r) => r.item.id);
  return { status: res.status, ids };
}

describe("GET /items — an unknown parameter is refused", () => {
  it("narrows correctly when the parameter is spelled right", async () => {
    // The control. Without it a misspelled request returning nothing says
    // nothing about whether the refusal is doing the work.
    const ok = await idsFrom(`/items?limit=50&timestamp_after=${FUTURE}`);
    expect(ok.status).toBe(200);
    for (const id of excluded) expect(ok.ids).not.toContain(id);
  });

  it("does not answer a misspelled filter with the whole corpus", async () => {
    const misspelled = await idsFrom(
      `/items?limit=50&timestmap_after=${FUTURE}`,
    );
    // The load-bearing assertion: the rows the bound was meant to exclude
    // must not reach the caller. This is what a softening to a warning
    // would break, and a status check would not.
    for (const id of excluded) expect(misspelled.ids).not.toContain(id);
    expect(misspelled.status).toBe(400);
  });

  it("refuses a parameter that resembles nothing at all", async () => {
    const res = await idsFrom("/items?limit=50&zzz_nonsense=1");
    expect(res.ids).toEqual([]);
    expect(res.status).toBe(400);
  });

  it("names the rejected parameter and what the door accepts", async () => {
    const res = await request(ctx.app, "GET", "/items?zzz_nonsense=1", {
      key: ctx.adminKey,
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as {
      error: { code: string; message: string };
    };
    expect(body.error.code).toBe("validation_error");
    expect(body.error.message).toContain("zzz_nonsense");
    expect(body.error.message).toContain("timestamp_after");
  });

  it("still accepts the edge shorthand, whose keys no schema declares", async () => {
    // The regression the per-door design exists to prevent: `edge[<type>]`
    // carries the type inside the key, so a blanket refusal kills it.
    const res = await request(
      ctx.app,
      "GET",
      `/items?limit=5&${encodeURIComponent("edge[about]")}=someid`,
      { key: ctx.adminKey },
    );
    expect(res.status).toBe(200);
  });

  it("refuses an edge shorthand carrying no value", async () => {
    // The hole the allow-pattern opened. The pattern matches on the key
    // alone, so `edge[about]=` clears the unknown-parameter refusal — and
    // the clause builder then skips it for having an empty value, which
    // returns an unfiltered page at 200. That is the exact failure this
    // whole change exists to remove, reached through the exemption written
    // to keep the shorthand working.
    //
    // `updated_after` carries `.min(1)` for the same reason on the same
    // door: a filter parameter with nothing in it is a caller mistake, not
    // a request for everything.
    const empty = await idsFrom(
      `/items?limit=50&${encodeURIComponent("edge[about]")}=`,
    );
    for (const id of excluded) expect(empty.ids).not.toContain(id);
    expect(empty.status).toBe(400);

    const named = await request(
      ctx.app,
      "GET",
      `/items?limit=50&${encodeURIComponent("edge[about]")}=`,
      { key: ctx.adminKey },
    );
    const body = (await named.json()) as { error: { message: string } };
    expect(body.error.message).toContain("edge[about]");
  });

  it("refuses a backref shorthand carrying no value", async () => {
    const empty = await idsFrom(
      `/items?limit=50&${encodeURIComponent("backref[about]")}=`,
    );
    for (const id of excluded) expect(empty.ids).not.toContain(id);
    expect(empty.status).toBe(400);
  });

  it("ignores a parameter in the client's reserved namespace", async () => {
    // The escape hatch that pays for refusing: a cache-buster or an
    // analytics tag has a spelling that works and keeps working.
    const res = await idsFrom("/items?limit=50&_cache_bust=12345");
    expect(res.status).toBe(200);
    expect(res.ids.length).toBeGreaterThan(0);
  });
});

describe("GET /edges — the door the published rename points at", () => {
  it("refuses an unknown parameter", async () => {
    const res = await request(ctx.app, "GET", "/edges?limit=50&zzz=1", {
      key: ctx.adminKey,
    });
    expect(res.status).toBe(400);
  });

  it("refuses the two retired names it never carried", async () => {
    // This door never had `since` / `until`, so there was nothing to
    // refuse and no refusal was written — while the release notes describe
    // the rename as covering it. A client migrating as instructed sent one
    // here and got a silently unfiltered page at 200 with a good cursor.
    for (const [oldName, replacement] of [
      ["since", "timestamp_after"],
      ["until", "timestamp_before"],
    ] as const) {
      const res = await request(
        ctx.app,
        "GET",
        `/edges?limit=50&${oldName}=${FUTURE}`,
        { key: ctx.adminKey },
      );
      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: { message: string } };
      // The specific message, not the general one: a retired name has a
      // replacement to name and the caller needs it.
      expect(body.error.message).toContain(replacement);
    }
  });

  it("refuses `timestamp_after`, which this door does not implement", async () => {
    // The sharpest case in the report: the rename's documentation sends a
    // caller here with a parameter this listing has never had.
    const res = await request(
      ctx.app,
      "GET",
      `/edges?limit=50&timestamp_after=${FUTURE}`,
      { key: ctx.adminKey },
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { message: string } };
    expect(body.error.message).toContain("updated_after");
  });

  it("still accepts the parameters it does implement", async () => {
    const res = await request(
      ctx.app,
      "GET",
      `/edges?limit=50&updated_after=1970-01-01T00:00:00.000Z`,
      { key: ctx.adminKey },
    );
    expect(res.status).toBe(200);
  });
});

describe("the per-item edge listings — the sibling doors", () => {
  it("refuse an unknown parameter on both", async () => {
    const id = excluded[0]!;
    for (const path of [`/items/${id}/edges`, `/items/${id}/backrefs`]) {
      const bad = await request(ctx.app, "GET", `${path}?edge_typ=about`, {
        key: ctx.adminKey,
      });
      expect(bad.status).toBe(400);
      const good = await request(ctx.app, "GET", `${path}?edge_type=about`, {
        key: ctx.adminKey,
      });
      expect(good.status).toBe(200);
    }
  });
});

describe("GET /search and GET /export — the other filtered reads", () => {
  it("refuse an unknown parameter on search", async () => {
    const res = await idsFrom("/search?q=probe&zzz_nonsense=1");
    expect(res.ids).toEqual([]);
    expect(res.status).toBe(400);
  });

  it("refuse an unknown parameter on export", async () => {
    const res = await request(ctx.app, "GET", "/export?zzz_nonsense=1", {
      key: ctx.adminKey,
    });
    expect(res.status).toBe(400);
  });

  it("refuse an unknown parameter on the archive format too", async () => {
    const res = await request(
      ctx.app,
      "GET",
      "/export?format=archive&zzz_nonsense=1",
      { key: ctx.adminKey },
    );
    expect(res.status).toBe(400);
  });
});

describe("POST /items/bulk-actions — the door where a dropped key costs rows", () => {
  /** The match set a dry run reports. */
  async function matched(
    filter: Record<string, unknown>,
  ): Promise<{ status: number; ids: string[] }> {
    const res = await request(ctx.app, "POST", "/items/bulk-actions", {
      key: ctx.adminKey,
      body: {
        action: "update_tags",
        add: ["probe"],
        dry_run: true,
        filter,
      },
    });
    if (res.status !== 200) return { status: res.status, ids: [] };
    const body = (await res.json()) as { ids?: string[] };
    return { status: 200, ids: body.ids ?? [] };
  }

  it("matches nothing when the bound is spelled right", async () => {
    // The control, and the one that makes the next case conclusive: a
    // filter the door implements returns an empty match set for an
    // impossible bound.
    const ok = await matched({
      type: "core.note",
      timestamp_before: "1970-01-02T00:00:00.000Z",
    });
    expect(ok.status).toBe(200);
    expect(ok.ids).toEqual([]);
  });

  it("does not turn a misspelled bound into the whole space", async () => {
    const bad = await matched({
      type: "core.note",
      timestmap_before: "1970-01-02T00:00:00.000Z",
    });
    // The assertion that matters: none of the seeded rows are in the match
    // set. Dropped, this filter selects every item in the space and the
    // action applies to all of them without erroring.
    for (const id of excluded) expect(bad.ids).not.toContain(id);
    expect(bad.status).toBe(400);
  });

  it("names the rejected field", async () => {
    const res = await request(ctx.app, "POST", "/items/bulk-actions", {
      key: ctx.adminKey,
      body: {
        action: "update_tags",
        add: ["probe"],
        dry_run: true,
        filter: { nonsense_field: "x" },
      },
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { message: string } };
    expect(body.error.message).toContain("nonsense_field");
  });

  it("still refuses the retired names with their own message", async () => {
    const res = await request(ctx.app, "POST", "/items/bulk-actions", {
      key: ctx.adminKey,
      body: {
        action: "update_tags",
        add: ["probe"],
        dry_run: true,
        filter: { since: "1970-01-02T00:00:00.000Z" },
      },
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { message: string } };
    expect(body.error.message).toContain("timestamp_after");
  });
});
