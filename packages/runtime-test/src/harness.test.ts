import { describe, it, expect, beforeEach } from "vitest";
import {
  registerScheduleHandler,
  registerWebhookHandler,
  _resetHandlers,
} from "@mymehq/runtime-sdk";
import { createTestHarness } from "./harness.js";

describe("createTestHarness", () => {
  beforeEach(() => {
    _resetHandlers();
  });

  it("delivers a schedule message to the registered handler and returns ok=true", async () => {
    const harness = createTestHarness({ integrationName: "myme.test" });
    let captured: unknown = null;
    registerScheduleHandler((ctx, msg) => {
      captured = msg;
      void ctx;
      return Promise.resolve({ ok: true });
    });

    await harness.connection("conn_1").send({
      kind: "schedule",
      integration_name: "myme.test",
      connection_id: "conn_1",
      scheduled_for_ms: 1_700_000_000_000,
    });
    const outcome = await harness.consume();

    expect(outcome).toEqual({ acked: 1, retried: 0, failed: 0 });
    expect(captured).toMatchObject({ kind: "schedule" });
  });

  it("isolates per-connection storage", async () => {
    const harness = createTestHarness({ integrationName: "myme.test" });
    registerScheduleHandler(async (ctx) => {
      await ctx.cursor.write("main", { ran_for: ctx.connection_id });
      return { ok: true };
    });

    await harness.connection("conn_a").send({
      kind: "schedule",
      integration_name: "myme.test",
      connection_id: "conn_a",
      scheduled_for_ms: 1,
    });
    await harness.connection("conn_b").send({
      kind: "schedule",
      integration_name: "myme.test",
      connection_id: "conn_b",
      scheduled_for_ms: 2,
    });
    await harness.consume();

    const a = await harness.connection("conn_a").storage.get("cursor:main");
    const b = await harness.connection("conn_b").storage.get("cursor:main");
    expect(a).toEqual({ ran_for: "conn_a" });
    expect(b).toEqual({ ran_for: "conn_b" });
  });

  it("returns the partial outcome when a handler asks for retry", async () => {
    const harness = createTestHarness({ integrationName: "myme.test" });
    registerWebhookHandler(() =>
      Promise.resolve({ ok: false, retry: true, reason: "rate_limited" }),
    );

    await harness.connection("conn_1").send({
      kind: "webhook",
      integration_name: "myme.test",
      connection_id: "conn_1",
      delivery_id: "d_1",
      headers: {},
      body: new ArrayBuffer(0),
      verified_at_ms: 1,
    });
    const outcome = await harness.consume();
    expect(outcome.retried).toBe(1);
  });

  it("filters out messages addressed to a different integration", async () => {
    const harness = createTestHarness({ integrationName: "myme.test" });
    let calls = 0;
    registerScheduleHandler(() => {
      calls++;
      return Promise.resolve({ ok: true });
    });

    await harness.connection("conn_1").send({
      kind: "schedule",
      integration_name: "someone-else",
      connection_id: "conn_1",
      scheduled_for_ms: 1,
    });
    await harness.consume();
    expect(calls).toBe(0);
  });

  it("custom mintCredential is invoked for every message", async () => {
    let mintCalls = 0;
    const harness = createTestHarness({
      integrationName: "myme.test",
      mintCredential: (id) => {
        mintCalls++;
        return Promise.resolve({
          api_key: "myme_k1_test",
          expires_at: new Date(Date.now() + 60_000).toISOString(),
          connection_id: id,
        });
      },
    });
    registerScheduleHandler(() => Promise.resolve({ ok: true }));

    for (let i = 0; i < 3; i++) {
      await harness.connection(`conn_${String(i)}`).send({
        kind: "schedule",
        integration_name: "myme.test",
        connection_id: `conn_${String(i)}`,
        scheduled_for_ms: i,
      });
    }
    await harness.consume();
    expect(mintCalls).toBe(3);
  });
});
