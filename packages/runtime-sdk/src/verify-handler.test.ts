import { describe, it, expect, beforeEach } from "vitest";
import {
  registerItemEventHandler,
  registerWebhookHandler,
  _resetHandlers,
} from "./handlers.js";
import { verifyHandler } from "./verify-handler.js";
import type { ConsumerEnvironment } from "./queue-consumer.js";
import type { ItemEventMessage, WebhookMessage } from "./types.js";
import { createInMemoryStorage } from "./in-memory-storage.js";

function makeEnv(integrationName: string): ConsumerEnvironment {
  const stores = new Map<string, ReturnType<typeof createInMemoryStorage>>();
  return {
    apiUrl: "http://localhost:0",
    integrationName,
    echo: { echo_ttl_seconds: 60 },
    storageFor(connectionId) {
      let s = stores.get(connectionId);
      if (!s) {
        s = createInMemoryStorage();
        stores.set(connectionId, s);
      }
      return s;
    },
    mintCredential: (connectionId) =>
      Promise.resolve({
        api_key: "myme_k1_verify_test",
        connection_id: connectionId,
        expires_at: new Date(Date.now() + 60_000).toISOString(),
      }),
  };
}

const ITEM_EVENT_MSG: ItemEventMessage = {
  kind: "item-event",
  integration_name: "demo.verify",
  connection_id: "conn_verify",
  event_type: "item.updated",
  item_id: "item_1",
  cycle: { originating_connection_id: null, hop_count: 0 },
  payload: { item: { id: "item_1" }, metadata: null },
};

describe("verifyHandler", () => {
  beforeEach(() => {
    _resetHandlers();
  });

  it("rejects non-POST", async () => {
    const env = makeEnv("demo.verify");
    const res = await verifyHandler(
      env,
      new Request("https://x/verify", { method: "GET" }),
    );
    expect(res.status).toBe(405);
  });

  it("rejects invalid JSON", async () => {
    const env = makeEnv("demo.verify");
    const res = await verifyHandler(
      env,
      new Request("https://x/verify", { method: "POST", body: "not-json" }),
    );
    expect(res.status).toBe(400);
    const body = await res.json<{ error: string }>();
    expect(body.error).toBe("invalid_json");
  });

  it("rejects missing envelope", async () => {
    const env = makeEnv("demo.verify");
    const res = await verifyHandler(
      env,
      new Request("https://x/verify", {
        method: "POST",
        body: JSON.stringify({}),
      }),
    );
    expect(res.status).toBe(400);
    const body = await res.json<{ error: string }>();
    expect(body.error).toBe("missing_envelope");
  });

  it("rejects integration name mismatch (envelope filter)", async () => {
    const env = makeEnv("demo.verify");
    const res = await verifyHandler(
      env,
      new Request("https://x/verify", {
        method: "POST",
        body: JSON.stringify({
          envelope: { ...ITEM_EVENT_MSG, integration_name: "other.thing" },
        }),
      }),
    );
    expect(res.status).toBe(400);
    const body = await res.json<{ error: string; expected: string }>();
    expect(body.error).toBe("integration_mismatch");
    expect(body.expected).toBe("demo.verify");
  });

  it("dispatches an item-event envelope through the registered handler and returns the result", async () => {
    registerItemEventHandler(() => Promise.resolve({ ok: true }));
    const env = makeEnv("demo.verify");
    const res = await verifyHandler(
      env,
      new Request("https://x/verify", {
        method: "POST",
        body: JSON.stringify({ envelope: ITEM_EVENT_MSG }),
      }),
    );
    expect(res.status).toBe(200);
    const body = await res.json<{
      ok: boolean;
      handler_result: { ok: boolean };
      envelope_used: { item_id: string };
    }>();
    expect(body.ok).toBe(true);
    expect(body.handler_result).toEqual({ ok: true });
    expect(body.envelope_used.item_id).toBe("item_1");
  });

  it("surfaces a permanent failure result without throwing", async () => {
    registerItemEventHandler(() =>
      Promise.resolve({ ok: false, retry: false, reason: "boom" }),
    );
    const env = makeEnv("demo.verify");
    const res = await verifyHandler(
      env,
      new Request("https://x/verify", {
        method: "POST",
        body: JSON.stringify({ envelope: ITEM_EVENT_MSG }),
      }),
    );
    expect(res.status).toBe(200);
    const body = await res.json<{
      ok: boolean;
      handler_result: { ok: boolean; reason?: string };
    }>();
    expect(body.ok).toBe(false);
    expect(body.handler_result).toMatchObject({
      ok: false,
      retry: false,
      reason: "boom",
    });
  });

  it("captures handler throws as dispatch_threw without bubbling", async () => {
    registerItemEventHandler(() => {
      throw new Error("handler exploded");
    });
    const env = makeEnv("demo.verify");
    const res = await verifyHandler(
      env,
      new Request("https://x/verify", {
        method: "POST",
        body: JSON.stringify({ envelope: ITEM_EVENT_MSG }),
      }),
    );
    expect(res.status).toBe(200);
    const body = await res.json<{
      ok: boolean;
      handler_result:
        | { ok: true }
        | { ok: false; retry: boolean; reason: string };
    }>();
    expect(body.ok).toBe(false);
    if (!body.handler_result.ok) {
      expect(body.handler_result.reason).toContain("dispatch_threw");
      expect(body.handler_result.reason).toContain("handler exploded");
    } else {
      throw new Error("expected ok: false");
    }
  });

  it("dispatches a webhook envelope through the registered handler", async () => {
    registerWebhookHandler(() => Promise.resolve({ ok: true }));
    const env = makeEnv("demo.verify");
    const webhook: WebhookMessage = {
      kind: "webhook",
      integration_name: "demo.verify",
      connection_id: "conn_verify",
      delivery_id: "del_1",
      headers: { "content-type": "application/json" },
      body_base64: "",
      verified_at_ms: Date.now(),
    };
    const res = await verifyHandler(
      env,
      new Request("https://x/verify", {
        method: "POST",
        body: JSON.stringify({ envelope: webhook }),
      }),
    );
    expect(res.status).toBe(200);
    const body = await res.json<{ ok: boolean }>();
    expect(body.ok).toBe(true);
  });
});
