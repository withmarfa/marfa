import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestContext } from "../../test-utils.js";
import type { TestContext } from "../../test-utils.js";
import {
  applyCursorDelta,
  checkAndRecordIdempotency,
  CONNECTION_RUNTIME_NAMESPACE,
  readConnectionRuntimeState,
  recordRuntimeError,
} from "./pg-cursor-store.js";

let ctx: TestContext;

beforeAll(async () => {
  ctx = await createTestContext();
});

afterAll(async () => {
  await ctx.cleanup();
});

async function createConnection(): Promise<string> {
  const item = await ctx.storage.items.create(
    {
      type: "system.connection",
      properties: {
        kind: "integration",
        status: "active",
        granted_at: new Date().toISOString(),
      },
    },
    undefined,
  );
  return item.id;
}

describe("local-runtime per-connection state (connection.runtime)", () => {
  it("reads empty state for a fresh connection (no extension row)", async () => {
    const connectionId = await createConnection();
    const state = await readConnectionRuntimeState(ctx.storage, connectionId);
    expect(state).toEqual({
      cursors: {},
      idempotency: {},
      recent_errors: [],
      next_run_at_ms: null,
    });
  });

  it("applyCursorDelta merges writes, preserves unrelated fields", async () => {
    const connectionId = await createConnection();
    await recordRuntimeError(ctx.storage, connectionId, {
      timestamp_ms: 1_700_000_000_000,
      reason: "boot probe",
    });
    await applyCursorDelta(
      ctx.storage,
      connectionId,
      { main: { last_at: "2026-05-01" } },
      [],
    );
    const state = await readConnectionRuntimeState(ctx.storage, connectionId);
    expect(state.cursors).toEqual({ main: { last_at: "2026-05-01" } });
    expect(state.recent_errors).toHaveLength(1);
    expect(state.recent_errors[0]?.reason).toBe("boot probe");

    await applyCursorDelta(ctx.storage, connectionId, { secondary: 42 }, [
      "main",
    ]);
    const final = await readConnectionRuntimeState(ctx.storage, connectionId);
    expect(final.cursors).toEqual({ secondary: 42 });
    expect(final.recent_errors).toHaveLength(1);
  });

  it("idempotency window flags duplicate deliveries", async () => {
    const connectionId = await createConnection();
    const ttl = 60_000;
    const first = await checkAndRecordIdempotency(
      ctx.storage,
      connectionId,
      "sub_a:delivery_1",
      ttl,
      1_700_000_000_000,
    );
    expect(first.isDuplicate).toBe(false);
    const second = await checkAndRecordIdempotency(
      ctx.storage,
      connectionId,
      "sub_a:delivery_1",
      ttl,
      1_700_000_000_001,
    );
    expect(second.isDuplicate).toBe(true);
    // A different delivery key is not a duplicate.
    const third = await checkAndRecordIdempotency(
      ctx.storage,
      connectionId,
      "sub_a:delivery_2",
      ttl,
      1_700_000_000_002,
    );
    expect(third.isDuplicate).toBe(false);
    // After the window elapses, the original key is evicted.
    const aged = await checkAndRecordIdempotency(
      ctx.storage,
      connectionId,
      "sub_a:delivery_1",
      ttl,
      1_700_000_000_000 + ttl + 1,
    );
    expect(aged.isDuplicate).toBe(false);
  });

  it("recordRuntimeError keeps the most recent 16 entries", async () => {
    const connectionId = await createConnection();
    for (let i = 0; i < 25; i++) {
      await recordRuntimeError(ctx.storage, connectionId, {
        timestamp_ms: 1_700_000_000_000 + i,
        reason: `err-${String(i)}`,
      });
    }
    const state = await readConnectionRuntimeState(ctx.storage, connectionId);
    expect(state.recent_errors).toHaveLength(16);
    expect(state.recent_errors[0]?.reason).toBe("err-9");
    expect(state.recent_errors.at(-1)?.reason).toBe("err-24");
  });

  it("writes back through the canonical extension namespace", async () => {
    const connectionId = await createConnection();
    await applyCursorDelta(ctx.storage, connectionId, { k: "v" }, []);
    const extensions = await ctx.storage.metadata.getExtensions(connectionId);
    expect(extensions[CONNECTION_RUNTIME_NAMESPACE]).toBeDefined();
    expect(extensions[CONNECTION_RUNTIME_NAMESPACE]?.cursors).toEqual({
      k: "v",
    });
  });
});
