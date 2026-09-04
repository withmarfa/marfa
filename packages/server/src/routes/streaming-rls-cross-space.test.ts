/**
 * Cross-space isolation regression for streaming routes
 * (`/events` SSE + `/export` NDJSON + `/export?format=archive`).
 *
 * The transaction-based RLS middleware exempts streaming routes by URL
 * prefix because a long-lived transaction would pin a pool connection.
 * Session-level role + space_id on a dedicated pool connection closes
 * that gap (see `storage/pg/streaming-rls.ts`). This test verifies
 * that the isolation holds: a space A credential cannot read space B
 * items through any streaming surface, even with broad `type_permissions`
 * that pass the application-layer filter.
 *
 * Postgres-only — RLS is a PG feature. SQLite skips via the `isPg`
 * guard but exercises the same routes in the in-tree test suite elsewhere.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  createTestContext,
  readSse,
  request,
  settle,
  TEST_API_KEY_SALT,
  type TestContext,
} from "../test-utils.js";
import { hashApiKey } from "../middleware/auth.js";
import { initEventLog } from "../pubsub.js";

const dialect = process.env.DB_DIALECT ?? "sqlite";
const isPg = dialect === "pg";

async function mintSpaceKey(
  ctx: TestContext,
  spaceId: string,
  label: string,
): Promise<string> {
  const suffix = Math.random().toString(36).slice(2, 14);
  const raw = `marfa_k1_t146_${suffix}`;
  await ctx.storage.keys.create(
    {
      label,
      source: `${label}-${suffix}`,
      // space_admin: bypasses type-permission checks, so any leak
      // observed would be a DB-layer leak (the application-layer
      // filter is genuinely bypassed for this credential — exactly
      // what RLS is supposed to fence against).
      role: "space_admin",
      default_tier: "library",
      type_permissions: { "*": "write" },
    },
    hashApiKey(raw, TEST_API_KEY_SALT),
    spaceId,
  );
  return raw;
}

describe.skipIf(!isPg)("streaming RLS cross-space regression (PG only)", () => {
  let ctx: TestContext;
  const spaceA = `t146-a-${Math.random().toString(36).slice(2, 10)}`;
  const spaceB = `t146-b-${Math.random().toString(36).slice(2, 10)}`;
  let keyA: string;
  let keyB: string;
  let itemAId: string;
  let itemBId: string;
  // Cursor captured BEFORE the test items are created — used by the
  // SSE replay test below so we don't trip the catchup_too_old gate.
  let cursorBeforeItems: bigint;

  beforeAll(async () => {
    // rlsEnforce: true is the default, but pass explicitly here so
    // the test is self-documenting.
    ctx = await createTestContext({ rlsEnforce: true });
    initEventLog(ctx.storage.eventLog);

    keyA = await mintSpaceKey(ctx, spaceA, "t146-a");
    keyB = await mintSpaceKey(ctx, spaceB, "t146-b");

    // Warmup events: post a throwaway item per space so each space
    // has at least one event_log row BEFORE the real test items.
    // Capture the high-water mark and use it as the SSE replay cursor
    // to sidestep the `catchup_too_old` gate while still exercising
    // the replay path.
    await request(ctx.app, "POST", "/items", {
      key: keyA,
      body: { type: "core.note", properties: { body: "warmup A" } },
    });
    await request(ctx.app, "POST", "/items", {
      key: keyB,
      body: { type: "core.note", properties: { body: "warmup B" } },
    });
    const preItemEvents = await ctx.storage.eventLog.getAfter(0n, 10_000);
    cursorBeforeItems = preItemEvents.reduce(
      (acc, e) => (e.id > acc ? e.id : acc),
      0n,
    );

    // Create the real test items via the POST /items path so the
    // create event flows through `publish(...)` and lands in
    // `event_log`. Direct `storage.items.create` would bypass the
    // publish hook.
    const createA = await request(ctx.app, "POST", "/items", {
      key: keyA,
      body: { type: "core.note", properties: { body: "space A secret" } },
    });
    expect(createA.status).toBe(201);
    const aBody = (await createA.json()) as { item: { id: string } };
    itemAId = aBody.item.id;

    const createB = await request(ctx.app, "POST", "/items", {
      key: keyB,
      body: { type: "core.note", properties: { body: "space B secret" } },
    });
    expect(createB.status).toBe(201);
    const bBody = (await createB.json()) as { item: { id: string } };
    itemBId = bBody.item.id;
  });

  afterAll(async () => {
    await ctx.cleanup();
  });

  it("GET /export NDJSON: space A never sees space B items", async () => {
    const res = await request(ctx.app, "GET", "/export", { key: keyA });
    expect(res.status).toBe(200);
    const body = await res.text();
    // Parse line-by-line; space A's stream must contain itemA and
    // never itemB. This holds whether RLS catches the row or the
    // application layer catches it — but with `*: write` perms +
    // space_admin role, the application-layer filter only
    // narrows by space_id (which goes into the WHERE clause); if
    // the WHERE were dropped (regression), RLS is the second fence.
    const ids = body
      .trim()
      .split("\n")
      .filter((line) => line.length > 0)
      .map((line) => (JSON.parse(line) as { item: { id: string } }).item.id);
    expect(ids).toContain(itemAId);
    expect(ids).not.toContain(itemBId);
  });

  it("GET /export?format=archive: manifest excludes space B items", async () => {
    const res = await request(ctx.app, "GET", "/export?format=archive", {
      key: keyA,
    });
    expect(res.status).toBe(200);
    // Archive payload is gzipped tar; we only need to verify the
    // body bytes don't contain space B's item id. Decompressing
    // tar in-process for this assertion would couple the test to
    // tar layout — the substring check is sufficient and far less
    // brittle. (Item ids are 22-char base32 random; collision risk
    // against unrelated bytes is negligible.)
    const buf = Buffer.from(await res.arrayBuffer());
    const { gunzipSync } = await import("node:zlib");
    const unpacked = gunzipSync(buf).toString("utf8");
    expect(unpacked).toContain(itemAId);
    expect(unpacked).not.toContain(itemBId);
  });

  it("GET /events SSE: space A never receives space B events on replay", async () => {
    // Both items were created in `beforeAll` via POST /items, which
    // wrote an `item.created` row to event_log for each space.
    // Space A's SSE replay request walks event_log; an RLS bypass
    // would render space B's row visible.
    const res = await ctx.app.request("/events", {
      headers: {
        authorization: `Bearer ${keyA}`,
        // Cursor captured pre-creation so the replay returns both
        // space items (and only those events that landed after).
        "Last-Event-ID": String(cursorBeforeItems),
      },
    });
    expect(res.status).toBe(200);
    const { text } = await readSse(res, {
      until: (t) => t.includes(itemAId),
    });
    expect(text).toContain(itemAId);
    // The smoking gun: space B's item id must NEVER appear in
    // space A's SSE replay. The event_log row carries the payload
    // with the item id; an RLS bypass would render it visible to
    // space A's getAfter() call. RLS filters at the row level.
    expect(text).not.toContain(itemBId);
  });

  /**
   * The cursor `/events` announces on connect is read under RLS
   * enforcement, and nothing else covered it.
   *
   * That read is the one the route makes outside the replay reservation,
   * and it takes a different fence — `withRlsSpaceTransaction` on the app
   * pool rather than a reserved session. The branch is chosen by
   * `rlsEnforce`, which defaults to true in production and is falsy under
   * a bare `createTestContext()`, so every existing test of the
   * announcement exercised the other arm.
   *
   * **The failure that arm has is a plausible value rather than a
   * throw.** `event_log` carries an RLS policy the app role is held to,
   * so a read reaching it without `marfa.space_id` set is denied every
   * space-scoped row: `MAX(id)` answers NULL, the route reads NULL as an
   * empty log, and the stream announces `0`. Nothing fails. A client
   * adopts a cursor pointing at the start of the log and believes it.
   *
   * Three assertions rather than one, because the wrong answers sit on
   * different sides. `0` is the denied-rows shape. Space B's higher id is
   * the unscoped-read shape, which a space-scoped equality alone would
   * pass if the log happened to end on space A. And a cursor that never
   * moves would satisfy both of those while being useless, so the last
   * step writes again and watches it advance.
   */
  it("GET /events SSE: announces this space's head under RLS, not zero and not the other space's", async () => {
    /** The space's true head, walked from the rows the owner connection
     *  sees. Deliberately not `getMaxId`, which is what the route asks:
     *  an oracle that calls the method under test agrees with it however
     *  wrong both are. */
    const headOf = async (spaceId: string | null): Promise<bigint> => {
      const rows = await ctx.storage.eventLog.getAfter(0n, 10_000);
      return rows
        .filter((row) => spaceId === null || row.space_id === spaceId)
        .reduce((max, row) => (row.id > max ? row.id : max), 0n);
    };

    const announcedFor = async (key: string): Promise<string> => {
      const res = await ctx.app.request("/events", {
        headers: { authorization: `Bearer ${key}` },
      });
      expect(res.status).toBe(200);
      const { text } = await readSse(res, {
        until: (t) => t.includes("event: stream_cursor"),
      });
      const frame = text
        .split("\n\n")
        .find((f) => f.split("\n").includes("event: stream_cursor"));
      expect(
        frame,
        "the stream must announce a cursor on connect",
      ).toBeDefined();
      const line = (frame ?? "")
        .split("\n")
        .find((l) => l.startsWith("data: "));
      if (line === undefined) throw new Error("cursor frame carried no data");
      const { cursor } = JSON.parse(line.slice("data: ".length)) as {
        cursor: string;
      };
      // Let the departed subscriber's cleanup run before anything below
      // writes, so no later assertion depends on a stream that is going.
      await settle();
      return cursor;
    };

    // Space B writes last, so the log's global head belongs to B and a
    // read that forgot to scope by space would visibly overshoot.
    await request(ctx.app, "POST", "/items", {
      key: keyA,
      body: { type: "core.note", properties: { body: "cursor probe A" } },
    });
    const headA = await headOf(spaceA);
    await request(ctx.app, "POST", "/items", {
      key: keyB,
      body: { type: "core.note", properties: { body: "cursor probe B" } },
    });
    const globalHead = await headOf(null);
    expect(
      globalHead,
      "the premise: space B must be ahead, or the scoping assertion proves nothing",
    ).toBeGreaterThan(headA);

    const cursor = await announcedFor(keyA);
    expect(
      cursor,
      "a cursor of 0 is what a read denied every row announces, and it is not an empty log",
    ).not.toBe("0");
    expect(
      cursor,
      "the announcement must name this space's head under RLS enforcement",
    ).toBe(String(headA));
    expect(
      BigInt(cursor),
      "a space A connection must not be told where space B got to",
    ).toBeLessThan(globalHead);

    // And it tracks: a cursor pinned to one value would pass everything
    // above while telling a reconnecting client nothing true.
    await request(ctx.app, "POST", "/items", {
      key: keyA,
      body: { type: "core.note", properties: { body: "cursor probe A again" } },
    });
    const movedHeadA = await headOf(spaceA);
    expect(movedHeadA).toBeGreaterThan(headA);
    expect(
      await announcedFor(keyA),
      "a later connection must announce the head as it now stands",
    ).toBe(String(movedHeadA));
  });
});
