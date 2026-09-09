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
      key: ctx.spaceKey,
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
  const res = await request(ctx.app, "GET", path, { key: ctx.spaceKey });
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
      key: ctx.spaceKey,
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
      { key: ctx.spaceKey },
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
      { key: ctx.spaceKey },
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
      key: ctx.spaceKey,
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
        { key: ctx.spaceKey },
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
      { key: ctx.spaceKey },
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
      { key: ctx.spaceKey },
    );
    expect(res.status).toBe(200);
  });
});

describe("the per-item edge listings — the sibling doors", () => {
  it("refuse an unknown parameter on both", async () => {
    const id = excluded[0]!;
    for (const path of [`/items/${id}/edges`, `/items/${id}/backrefs`]) {
      const bad = await request(ctx.app, "GET", `${path}?edge_typ=about`, {
        key: ctx.spaceKey,
      });
      expect(bad.status).toBe(400);
      const good = await request(ctx.app, "GET", `${path}?edge_type=about`, {
        key: ctx.spaceKey,
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
      key: ctx.spaceKey,
    });
    expect(res.status).toBe(400);
  });

  it("refuse an unknown parameter on the archive format too", async () => {
    const res = await request(
      ctx.app,
      "GET",
      "/export?format=archive&zzz_nonsense=1",
      { key: ctx.spaceKey },
    );
    expect(res.status).toBe(400);
  });
});

describe("the reserved `_` prefix, on every door that refuses", () => {
  // The module claims the hatch holds everywhere, and it was asserted on
  // one door. A claim tested in one place is a claim about that place.
  const id = (): string => excluded[0]!;

  it("is ignored on every refusing query door", async () => {
    const doors = (): string[] => [
      "/items?limit=5&_trace=1",
      "/edges?limit=5&_trace=1",
      `/items/${id()}/edges?_trace=1`,
      `/items/${id()}/backrefs?_trace=1`,
      "/search?q=probe&_trace=1",
      "/export?_trace=1",
      "/export?format=archive&_trace=1",
    ];
    for (const path of doors()) {
      const res = await request(ctx.app, "GET", path, { key: ctx.spaceKey });
      expect(res.status, `${path} refused a reserved-prefix parameter`).toBe(
        200,
      );
      // Drain the streamed doors so the response is not left open.
      await res.arrayBuffer();
    }
  });

  it("is ignored beside a parameter the door does implement", async () => {
    // The hatch and a real filter in one request, which is how a client
    // that appended a cache-buster actually sends it.
    const res = await request(
      ctx.app,
      "GET",
      `/items?limit=50&timestamp_after=${FUTURE}&_cache_bust=9`,
      { key: ctx.spaceKey },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { id: string }[] };
    // Still filtered: an ignored key must not widen the page.
    for (const seeded of excluded) {
      expect(body.data.map((r) => r.id)).not.toContain(seeded);
    }
  });

  it("does not rescue a misspelling that merely contains an underscore", async () => {
    // The hatch is a prefix, not a substring. A misspelled real parameter
    // never starts with `_`, which is what keeps the hatch from weakening
    // the catch it pays for.
    const res = await request(
      ctx.app,
      "GET",
      `/items?limit=50&timestamp_aftr=${FUTURE}`,
      { key: ctx.spaceKey },
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
      key: ctx.spaceKey,
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
      key: ctx.spaceKey,
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

  /** The raw door, so a body can carry a key the typed helper would not. */
  async function post(body: Record<string, unknown>): Promise<Response> {
    return request(ctx.app, "POST", "/items/bulk-actions", {
      key: ctx.spaceKey,
      body,
    });
  }

  it("does not run for real when `dry_run` is misspelled", async () => {
    // The more dangerous half, one level up from the filter. `dry_run` is
    // read as `body.dry_run ?? false`, so a misspelling is stripped by the
    // validator and the action executes against the match set for real —
    // answering 202 and queueing the write, which reads to the caller as
    // the dry run they asked for.
    const res = await post({
      action: "update_tags",
      add: ["probe"],
      dry_runn: true,
      filter: { type: "core.note" },
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { message: string } };
    expect(body.error.message).toContain("dry_runn");
  });

  it("does not drop the cap when `max_items` is misspelled", async () => {
    // The same failure with the guard rail instead of the rehearsal: a
    // stripped `max_items` restores the default cap, so a caller who asked
    // for a hundred rows gets whatever the door's own maximum is.
    const res = await post({
      action: "update_tags",
      add: ["probe"],
      dry_run: true,
      max_itmes: 1,
      filter: { type: "core.note" },
    });
    expect(res.status).toBe(400);
  });

  it("refuses an unknown key on an action that is not `purge`", async () => {
    // `confirm` is read explicitly, so `purge` already fails safe when it
    // is misspelled. Every other action reads its own fields the same way
    // `dry_run` is read, and none of them had a guard.
    for (const body of [
      { action: "transition", state: "archived", stat: "trashed" },
      { action: "update_tier", tier: "feed", teir: "library" },
      {
        action: "update_timestamp",
        timestamp: "2020-01-01T00:00:00.000Z",
        tz: 1,
      },
      { action: "update_properties", patch: { a: 1 }, pathc: { b: 2 } },
      { action: "update_tags", add: ["probe"], adds: ["nope"] },
    ]) {
      const res = await post({ dry_run: true, ...body });
      expect(res.status, `${body.action} accepted an unknown body key`).toBe(
        400,
      );
    }
  });

  it("refuses a field belonging to a different action", async () => {
    // `state` is the transition's own parameter and means nothing to a
    // retag. Silently stripped, it reads as a caller who believes they
    // asked for two things and got one.
    const res = await post({
      action: "update_tags",
      add: ["probe"],
      dry_run: true,
      state: "trashed",
    });
    expect(res.status).toBe(400);
  });

  it("ignores a body key in the client's reserved namespace", async () => {
    // The same escape hatch the query doors give, on the door that takes
    // its request in a body: a correlation id or a client tag has a
    // spelling that works and keeps working.
    const res = await post({
      action: "update_tags",
      add: ["probe"],
      dry_run: true,
      _client_trace: "abc123",
      filter: { type: "core.note", _origin: "probe" },
    });
    expect(res.status).toBe(200);
  });

  it("still accepts every field it declares", async () => {
    // The control. A refusal that also refused the real fields would pass
    // every case above and break the door.
    const res = await post({
      action: "update_tags",
      add: ["probe"],
      remove: ["other"],
      dry_run: true,
      max_items: 5,
      enable_fanout: false,
      filter: {
        type: "core.note",
        timestamp_before: "1970-01-02T00:00:00.000Z",
      },
    });
    expect(res.status).toBe(200);
  });

  it("still refuses the retired names with their own message", async () => {
    const res = await request(ctx.app, "POST", "/items/bulk-actions", {
      key: ctx.spaceKey,
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
