import { describe, it, expect, beforeEach } from "vitest";
import {
  registerScheduleHandler,
  registerWebhookHandler,
  _resetHandlers,
} from "@withmarfa/runtime-sdk";
import { createTestHarness } from "./harness.js";

describe("createTestHarness", () => {
  beforeEach(() => {
    _resetHandlers();
  });

  it("delivers a schedule message to the registered handler and returns ok=true", async () => {
    const harness = createTestHarness({ integrationName: "marfa.test" });
    let captured: unknown = null;
    registerScheduleHandler((ctx, msg) => {
      captured = msg;
      void ctx;
      return Promise.resolve({ ok: true, done: true });
    });

    await harness.connection("conn_1").send({
      kind: "schedule",
      integration_name: "marfa.test",
      connection_id: "conn_1",
      scheduled_for_ms: 1_700_000_000_000,
    });
    const outcome = await harness.consume();

    expect(outcome).toEqual({ acked: 1, retried: 0, failed: 0 });
    expect(captured).toMatchObject({ kind: "schedule" });
  });

  it("isolates per-connection storage", async () => {
    const harness = createTestHarness({ integrationName: "marfa.test" });
    registerScheduleHandler(async (ctx) => {
      await ctx.cursor.write("main", { ran_for: ctx.connection_id });
      return { ok: true, done: true };
    });

    await harness.connection("conn_a").send({
      kind: "schedule",
      integration_name: "marfa.test",
      connection_id: "conn_a",
      scheduled_for_ms: 1,
    });
    await harness.connection("conn_b").send({
      kind: "schedule",
      integration_name: "marfa.test",
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
    const harness = createTestHarness({ integrationName: "marfa.test" });
    registerWebhookHandler(() =>
      Promise.resolve({ ok: false, retry: true, reason: "rate_limited" }),
    );

    await harness.connection("conn_1").send({
      kind: "webhook",
      integration_name: "marfa.test",
      connection_id: "conn_1",
      delivery_id: "d_1",
      headers: {},
      body_base64: "",
      verified_at_ms: 1,
    });
    const outcome = await harness.consume();
    expect(outcome.retried).toBe(1);
  });

  it("filters out messages addressed to a different integration", async () => {
    const harness = createTestHarness({ integrationName: "marfa.test" });
    let calls = 0;
    registerScheduleHandler(() => {
      calls++;
      return Promise.resolve({ ok: true, done: true });
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
      integrationName: "marfa.test",
      mintCredential: (id) => {
        mintCalls++;
        return Promise.resolve({
          api_key: "marfa_k1_test",
          expires_at: new Date(Date.now() + 60_000).toISOString(),
          connection_id: id,
        });
      },
    });
    registerScheduleHandler(() => Promise.resolve({ ok: true, done: true }));

    for (let i = 0; i < 3; i++) {
      await harness.connection(`conn_${String(i)}`).send({
        kind: "schedule",
        integration_name: "marfa.test",
        connection_id: `conn_${String(i)}`,
        scheduled_for_ms: i,
      });
    }
    await harness.consume();
    expect(mintCalls).toBe(3);
  });

  it("decodes body_base64 → ArrayBuffer at the dispatcher seam", async () => {
    // Round-trip the wire format through the dispatcher: enqueue with
    // body_base64; the SDK should hand the handler an ArrayBuffer with
    // matching bytes.
    const harness = createTestHarness({ integrationName: "marfa.test" });
    const original = "hello, webhook world";
    const bytes = new TextEncoder().encode(original);
    let bodyBuffer: ArrayBuffer | undefined;
    registerWebhookHandler((_ctx, input) => {
      bodyBuffer = input.body;
      return Promise.resolve({ ok: true });
    });

    // btoa on the raw byte sequence (Latin1 view) — what the control
    // plane does when it serializes the body for the queue envelope.
    let bodyString = "";
    for (const b of bytes) bodyString += String.fromCharCode(b);
    const bodyBase64 = btoa(bodyString);

    await harness.connection("conn_decode").send({
      kind: "webhook",
      integration_name: "marfa.test",
      connection_id: "conn_decode",
      delivery_id: "d_decode",
      headers: { "content-type": "application/json" },
      body_base64: bodyBase64,
      verified_at_ms: Date.now(),
    });
    const outcome = await harness.consume();
    expect(outcome.acked).toBe(1);
    expect(bodyBuffer).toBeDefined();
    expect(new TextDecoder("utf-8").decode(bodyBuffer)).toBe(original);
  });
});
