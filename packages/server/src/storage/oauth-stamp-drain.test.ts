/**
 * The OAuth grant's `last_used_at` stamp is fire-and-forget from the
 * bearer middleware, so nothing awaits it — and a stamp still opening its
 * connection when `storage.close()` ends the pool used to surface as an
 * unhandled rejection (observed in CI with every test passing and the
 * run failing anyway).
 * The audit store gained a drain for exactly this class; these tests pin
 * the same guarantee for the stamp.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createTestContext, request } from "../test-utils.js";
import type { TestContext } from "../test-utils.js";

describe("oauth last-used stamp drains at close", () => {
  let ctx: TestContext;
  const unhandled: unknown[] = [];
  const onUnhandled = (reason: unknown) => {
    unhandled.push(reason);
  };

  beforeEach(async () => {
    unhandled.length = 0;
    process.on("unhandledRejection", onUnhandled);
    ctx = await createTestContext();
  });

  afterEach(() => {
    process.off("unhandledRejection", onUnhandled);
  });

  async function createItem(): Promise<string> {
    const res = await request(ctx.app, "POST", "/items", {
      key: ctx.spaceKey,
      body: {
        type: "core.note",
        properties: { title: "stamp target", body: "" },
      },
    });
    expect(res.status).toBe(201);
    const { item } = (await res.json()) as { item: { id: string } };
    return item.id;
  }

  it("drain() resolves only after an in-flight stamp has landed", async () => {
    const id = await createItem();

    // Fire-and-forget, exactly as the middleware does. The stamp is
    // space-scoped, so it takes the space the row was written into: a null
    // space matches only a row with no space and would stamp nothing.
    void ctx.storage.oauthProvider!.updateLastUsedAt(id, 30_000);
    await ctx.storage.oauthProvider!.drain();

    const item = await ctx.storage.items.get(id);
    expect(item?.properties.last_used_at).toEqual(expect.any(String));
    await ctx.cleanup();
  });

  it("a stamp racing close() neither rejects unhandled nor blocks teardown", async () => {
    const id = await createItem();

    // No await between the stamp and close — the exact window the bearer
    // middleware's post-response stamp hits when a context tears down.
    void ctx.storage.oauthProvider!.updateLastUsedAt(id, 30_000);
    await ctx.cleanup();

    // Absence has no condition to poll for: give a stray rejection two
    // macrotask turns to surface before asserting there was none.
    await new Promise((r) => setTimeout(r, 100));
    expect(unhandled).toEqual([]);
  });
});
