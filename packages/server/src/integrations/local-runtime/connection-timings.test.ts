/**
 * The timing fields `system.connection` declares are actually written.
 *
 * `last_sync_at`, `next_run_at` and `last_error_at` shipped with
 * descriptions and no writer, so every consumer rendered a placeholder for
 * a connection that was demonstrably syncing. These pin the three
 * properties that made the declaration honest: each stamp lands, a stamp
 * leaves the connection's other properties alone (they merge shallowly, so
 * a careless write would erase the rest), and a success clears the error
 * stamp the way the field's own description promises.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestContext } from "../../test-utils.js";
import type { TestContext } from "../../test-utils.js";
import {
  stampSyncSuccess,
  stampSyncFailure,
  stampNextRun,
} from "./connection-timings.js";

let ctx: TestContext;

beforeAll(async () => {
  ctx = await createTestContext();
});

afterAll(async () => {
  await ctx.cleanup();
});

async function makeConnection(): Promise<string> {
  const item = await ctx.storage.items.create(
    {
      type: "system.connection",
      properties: {
        kind: "integration",
        status: "active",
        runtime_status: "healthy",
        granted_at: new Date().toISOString(),
        integration_ref: "integration-fixture",
        configuration: { some: "value" },
      },
    },
    undefined,
  );
  return item.id;
}

async function props(id: string): Promise<Record<string, unknown>> {
  const item = await ctx.storage.items.get(id);
  if (!item) throw new Error("connection vanished");
  return item.properties;
}

describe("connection timing stamps", () => {
  it("records a successful run without disturbing the rest of the connection", async () => {
    const id = await makeConnection();
    const at = Date.UTC(2026, 7, 21, 12, 0, 0);

    await stampSyncSuccess(ctx.storage, id, undefined, at);

    const p = await props(id);
    expect(p.last_sync_at).toBe("2026-08-21T12:00:00.000Z");
    // Properties merge shallowly, so a stamp that sent the whole object
    // would silently drop everything it did not know about.
    expect(p.runtime_status).toBe("healthy");
    expect(p.integration_ref).toBe("integration-fixture");
    expect(p.configuration).toEqual({ some: "value" });
  });

  it("records a terminal failure", async () => {
    const id = await makeConnection();
    const at = Date.UTC(2026, 7, 21, 13, 30, 0);

    await stampSyncFailure(ctx.storage, id, undefined, at);

    expect((await props(id)).last_error_at).toBe("2026-08-21T13:30:00.000Z");
  });

  it("clears the error stamp on the next success", async () => {
    const id = await makeConnection();
    await stampSyncFailure(
      ctx.storage,
      id,
      undefined,
      Date.UTC(2026, 7, 21, 9),
    );
    expect((await props(id)).last_error_at).toBe("2026-08-21T09:00:00.000Z");

    await stampSyncSuccess(
      ctx.storage,
      id,
      undefined,
      Date.UTC(2026, 7, 21, 10),
    );

    const p = await props(id);
    expect(p.last_sync_at).toBe("2026-08-21T10:00:00.000Z");
    // The field's description says "cleared on next success". A shallow
    // merge treats a plain null as "leave unset", so this only holds
    // because the stamp asks for null_clears.
    expect(p.last_error_at ?? null).toBeNull();
  });

  it("records the next scheduled run", async () => {
    const id = await makeConnection();
    const at = Date.UTC(2026, 7, 21, 15, 0, 0);

    await stampNextRun(ctx.storage, id, undefined, at);

    expect((await props(id)).next_run_at).toBe("2026-08-21T15:00:00.000Z");
  });

  it("does not throw when the connection is gone", async () => {
    // Bookkeeping must never turn work that succeeded into a reported
    // failure, so a stamp against a connection uninstalled mid-dispatch
    // is swallowed rather than propagated.
    await expect(
      stampSyncSuccess(
        ctx.storage,
        "01a00000-0000-7000-8000-000000000000",
        undefined,
        Date.now(),
      ),
    ).resolves.toBeUndefined();
  });
});
