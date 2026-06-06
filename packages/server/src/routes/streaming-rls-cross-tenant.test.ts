/**
 * Cross-tenant isolation regression for streaming routes
 * (`/events` SSE + `/export` NDJSON + `/export?format=archive`).
 *
 * The transaction-based RLS middleware exempts streaming routes by URL
 * prefix because a long-lived transaction would pin a pool connection.
 * Session-level role + tenant_id on a dedicated pool connection closes
 * that gap (see `storage/pg/streaming-rls.ts`). This test verifies
 * that the isolation holds: a tenant A credential cannot read tenant B
 * items through any streaming surface, even with broad `type_permissions`
 * that pass the application-layer filter.
 *
 * Postgres-only — RLS is a PG feature. SQLite skips via the `isPg`
 * guard but exercises the same routes in the in-tree test suite elsewhere.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  createTestContext,
  request,
  TEST_API_KEY_SALT,
  type TestContext,
} from "../test-utils.js";
import { hashApiKey } from "../middleware/auth.js";
import { initEventLog } from "../pubsub.js";

const dialect = process.env.DB_DIALECT ?? "sqlite";
const isPg = dialect === "pg";

async function mintTenantKey(
  ctx: TestContext,
  tenantId: string,
  label: string,
): Promise<string> {
  const suffix = Math.random().toString(36).slice(2, 14);
  const raw = `marfa_k1_t146_${suffix}`;
  await ctx.storage.keys.create(
    {
      label,
      source: `${label}-${suffix}`,
      // tenant_admin: bypasses type-permission checks, so any leak
      // observed would be a DB-layer leak (the application-layer
      // filter is genuinely bypassed for this credential — exactly
      // what RLS is supposed to fence against).
      role: "tenant_admin",
      default_tier: "library",
      type_permissions: { "*": "write" },
    },
    hashApiKey(raw, TEST_API_KEY_SALT),
    tenantId,
  );
  return raw;
}

async function readSse(
  res: Response,
  timeoutMs = 750,
): Promise<{ text: string }> {
  expect(res.body).not.toBeNull();
  const reader = (res.body as ReadableStream<Uint8Array>).getReader();
  const decoder = new TextDecoder();
  let text = "";
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) break;
    const tick = new Promise<{ value?: Uint8Array; done: boolean }>(
      (resolve) => {
        const t = setTimeout(
          () => {
            resolve({ done: false });
          },
          Math.min(remaining, 50),
        );
        reader
          .read()
          .then((r) => {
            clearTimeout(t);
            resolve(r);
          })
          .catch(() => {
            resolve({ done: true });
          });
      },
    );
    const { value, done } = await tick;
    if (done) break;
    if (value) text += decoder.decode(value, { stream: true });
  }
  try {
    await reader.cancel();
  } catch {
    /* stream already closed */
  }
  return { text };
}

describe.skipIf(!isPg)(
  "streaming RLS cross-tenant regression (PG only)",
  () => {
    let ctx: TestContext;
    const tenantA = `t146-a-${Math.random().toString(36).slice(2, 10)}`;
    const tenantB = `t146-b-${Math.random().toString(36).slice(2, 10)}`;
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

      keyA = await mintTenantKey(ctx, tenantA, "t146-a");
      keyB = await mintTenantKey(ctx, tenantB, "t146-b");

      // Warmup events: post a throwaway item per tenant so each tenant
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
        body: { type: "core.note", properties: { body: "tenant A secret" } },
      });
      expect(createA.status).toBe(201);
      const aBody = (await createA.json()) as { item: { id: string } };
      itemAId = aBody.item.id;

      const createB = await request(ctx.app, "POST", "/items", {
        key: keyB,
        body: { type: "core.note", properties: { body: "tenant B secret" } },
      });
      expect(createB.status).toBe(201);
      const bBody = (await createB.json()) as { item: { id: string } };
      itemBId = bBody.item.id;
    });

    afterAll(async () => {
      await ctx.cleanup();
    });

    it("GET /export NDJSON: tenant A never sees tenant B items", async () => {
      const res = await request(ctx.app, "GET", "/export", { key: keyA });
      expect(res.status).toBe(200);
      const body = await res.text();
      // Parse line-by-line; tenant A's stream must contain itemA and
      // never itemB. This holds whether RLS catches the row or the
      // application layer catches it — but with `*: write` perms +
      // tenant_admin role, the application-layer filter only
      // narrows by tenant_id (which goes into the WHERE clause); if
      // the WHERE were dropped (regression), RLS is the second fence.
      const ids = body
        .trim()
        .split("\n")
        .filter((line) => line.length > 0)
        .map((line) => (JSON.parse(line) as { item: { id: string } }).item.id);
      expect(ids).toContain(itemAId);
      expect(ids).not.toContain(itemBId);
    });

    it("GET /export?format=archive: manifest excludes tenant B items", async () => {
      const res = await request(ctx.app, "GET", "/export?format=archive", {
        key: keyA,
      });
      expect(res.status).toBe(200);
      // Archive payload is gzipped tar; we only need to verify the
      // body bytes don't contain tenant B's item id. Decompressing
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

    it("GET /events SSE: tenant A never receives tenant B events on replay", async () => {
      // Both items were created in `beforeAll` via POST /items, which
      // wrote an `item.created` row to event_log for each tenant.
      // Tenant A's SSE replay request walks event_log; an RLS bypass
      // would render tenant B's row visible.
      const res = await ctx.app.request("/events", {
        headers: {
          authorization: `Bearer ${keyA}`,
          // Cursor captured pre-creation so the replay returns both
          // tenant items (and only those events that landed after).
          "Last-Event-ID": String(cursorBeforeItems),
        },
      });
      expect(res.status).toBe(200);
      const { text } = await readSse(res);
      expect(text).toContain(itemAId);
      // The smoking gun: tenant B's item id must NEVER appear in
      // tenant A's SSE replay. The event_log row carries the payload
      // with the item id; an RLS bypass would render it visible to
      // tenant A's getAfter() call. RLS filters at the row level.
      expect(text).not.toContain(itemBId);
    });
  },
);
