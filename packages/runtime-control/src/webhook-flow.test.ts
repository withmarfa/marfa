/**
 * End-to-end test of the webhook receive → verify → enqueue flow with
 * mocked Cloudflare bindings + a stubbed Myme server fetch.
 */
import { describe, it, expect } from "vitest";
import { buildApp } from "./app.js";
import type { ControlPlaneEnv } from "./env.js";

const SECRET = "test-secret";
const SUBSCRIPTION = {
  id: "wh_1",
  connection_id: "conn_x",
  secret: SECRET,
  verification_method: "hmac-sha256" as const,
  integration_name: "mymehq.test-webhook",
  events: ["push"],
  disabled: false,
};

interface QueueCall {
  body: unknown;
  contentType?: string;
}

function mockQueue(): {
  send: (b: unknown, opts?: { contentType?: string }) => Promise<void>;
  calls: QueueCall[];
} {
  const calls: QueueCall[] = [];
  return {
    calls,
    send(body, opts) {
      calls.push({ body, contentType: opts?.contentType });
      return Promise.resolve();
    },
  };
}

function mockKv(): {
  get: (key: string) => Promise<string | null>;
  put: (
    key: string,
    value: string,
    opts?: { expirationTtl?: number },
  ) => Promise<void>;
  store: Map<string, string>;
} {
  const store = new Map<string, string>();
  return {
    store,
    get(key) {
      return Promise.resolve(store.get(key) ?? null);
    },
    put(key, value) {
      store.set(key, value);
      return Promise.resolve();
    },
  };
}

function mockMymeFetch(
  options: {
    subscriptions?: (typeof SUBSCRIPTION)[];
    fail?: boolean;
  } = {},
): typeof fetch {
  return ((input: RequestInfo | URL) => {
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.toString()
          : input.url;
    if (url.includes("/system/inbound-webhook-subscriptions/")) {
      if (options.fail) {
        return Promise.resolve(new Response("nope", { status: 502 }));
      }
      const subs = options.subscriptions ?? [SUBSCRIPTION];
      return Promise.resolve(
        new Response(JSON.stringify({ subscriptions: subs }), { status: 200 }),
      );
    }
    return Promise.resolve(new Response("not found", { status: 404 }));
  }) as typeof fetch;
}

async function sign(body: ArrayBuffer, secret: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, body);
  let hex = "";
  const bytes = new Uint8Array(sig);
  for (const byte of bytes) {
    hex += byte.toString(16).padStart(2, "0");
  }
  return hex;
}

describe("webhook receive flow", () => {
  it("verifies, enqueues, and 202s on a valid HMAC delivery", async () => {
    const queue = mockQueue();
    const kv = mockKv();
    const originalFetch = globalThis.fetch;
    globalThis.fetch = mockMymeFetch();
    try {
      const env: ControlPlaneEnv = {
        MYME_API_URL: "http://localhost:0",
        MYME_RUNTIME_BROKER_KEY: "myme_k1_broker",
        WEBHOOK_RECEIPT_QUEUE: queue,
        IDEMPOTENCY_KV: kv as unknown as KVNamespace,
      };
      const bodyBytes = new TextEncoder().encode('{"event":"push"}');
      const bodyBuffer = bodyBytes.buffer.slice(
        bodyBytes.byteOffset,
        bodyBytes.byteOffset + bodyBytes.byteLength,
      );
      const sig = await sign(bodyBuffer, SECRET);
      const app = buildApp();
      const res = await app.request(
        "/webhooks/inbound/conn_x",
        {
          method: "POST",
          body: bodyBytes,
          headers: {
            "x-myme-signature": `sha256=${sig}`,
            "x-myme-delivery-id": "d_42",
          },
        },
        env,
      );
      expect(res.status).toBe(202);
      expect(queue.calls).toHaveLength(1);
      const enqueued = queue.calls[0]!.body as Record<string, unknown>;
      expect(enqueued.kind).toBe("webhook");
      expect(enqueued.connection_id).toBe("conn_x");
      expect(enqueued.delivery_id).toBe("d_42");
      expect(enqueued.webhook_id).toBe("wh_1");
      // T-009: integration_name stamped from the subscription's
      // projected manifest name, not hardcoded to "".
      expect(enqueued.integration_name).toBe("mymehq.test-webhook");
      // Wire format: body_base64, decoded by the SDK at the seam.
      expect(typeof enqueued.body_base64).toBe("string");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("returns 401 when signature does not match", async () => {
    const queue = mockQueue();
    const originalFetch = globalThis.fetch;
    globalThis.fetch = mockMymeFetch();
    try {
      const env: ControlPlaneEnv = {
        MYME_API_URL: "http://localhost:0",
        MYME_RUNTIME_BROKER_KEY: "myme_k1_broker",
        WEBHOOK_RECEIPT_QUEUE: queue,
      };
      const app = buildApp();
      const res = await app.request(
        "/webhooks/inbound/conn_x",
        {
          method: "POST",
          body: '{"event":"push"}',
          headers: {
            "x-myme-signature": "sha256=deadbeef",
          },
        },
        env,
      );
      expect(res.status).toBe(401);
      expect(queue.calls).toHaveLength(0);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("returns 404 when no subscriptions exist for the connection", async () => {
    const queue = mockQueue();
    const originalFetch = globalThis.fetch;
    globalThis.fetch = mockMymeFetch({ subscriptions: [] });
    try {
      const env: ControlPlaneEnv = {
        MYME_API_URL: "http://localhost:0",
        MYME_RUNTIME_BROKER_KEY: "myme_k1_broker",
        WEBHOOK_RECEIPT_QUEUE: queue,
      };
      const app = buildApp();
      const res = await app.request(
        "/webhooks/inbound/conn_unknown",
        {
          method: "POST",
          body: "{}",
          headers: { "x-myme-signature": "sha256=x" },
        },
        env,
      );
      expect(res.status).toBe(404);
      expect(queue.calls).toHaveLength(0);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("returns 502 when the lookup fails", async () => {
    const queue = mockQueue();
    const originalFetch = globalThis.fetch;
    globalThis.fetch = mockMymeFetch({ fail: true });
    try {
      const env: ControlPlaneEnv = {
        MYME_API_URL: "http://localhost:0",
        MYME_RUNTIME_BROKER_KEY: "myme_k1_broker",
        WEBHOOK_RECEIPT_QUEUE: queue,
      };
      const app = buildApp();
      const res = await app.request(
        "/webhooks/inbound/conn_x",
        {
          method: "POST",
          body: "{}",
          headers: { "x-myme-signature": "sha256=x" },
        },
        env,
      );
      expect(res.status).toBe(502);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("dedupes duplicate deliveries via the KV cache", async () => {
    const queue = mockQueue();
    const kv = mockKv();
    const originalFetch = globalThis.fetch;
    globalThis.fetch = mockMymeFetch();
    try {
      const env: ControlPlaneEnv = {
        MYME_API_URL: "http://localhost:0",
        MYME_RUNTIME_BROKER_KEY: "myme_k1_broker",
        WEBHOOK_RECEIPT_QUEUE: queue,
        IDEMPOTENCY_KV: kv as unknown as KVNamespace,
      };
      const bodyBytes = new TextEncoder().encode('{"event":"push"}');
      const bodyBuffer = bodyBytes.buffer.slice(
        bodyBytes.byteOffset,
        bodyBytes.byteOffset + bodyBytes.byteLength,
      );
      const sig = await sign(bodyBuffer, SECRET);
      const app = buildApp();
      const headers = {
        "x-myme-signature": `sha256=${sig}`,
        "x-myme-delivery-id": "d_dup",
      };
      const first = await app.request(
        "/webhooks/inbound/conn_x",
        { method: "POST", body: bodyBytes, headers },
        env,
      );
      expect(first.status).toBe(202);
      const second = await app.request(
        "/webhooks/inbound/conn_x",
        { method: "POST", body: bodyBytes, headers },
        env,
      );
      expect(second.status).toBe(200);
      const body: { duplicate?: boolean } = await second.json();
      expect(body.duplicate).toBe(true);
      expect(queue.calls).toHaveLength(1);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("verifies a valid GitHub HMAC delivery via the lifted dispatch table (T-009)", async () => {
    const queue = mockQueue();
    const kv = mockKv();
    const originalFetch = globalThis.fetch;
    globalThis.fetch = mockMymeFetch({
      subscriptions: [
        {
          ...SUBSCRIPTION,
          verification_method: "github" as unknown as "hmac-sha256",
        },
      ],
    });
    try {
      const env: ControlPlaneEnv = {
        MYME_API_URL: "http://localhost:0",
        MYME_RUNTIME_BROKER_KEY: "myme_k1_broker",
        WEBHOOK_RECEIPT_QUEUE: queue,
        IDEMPOTENCY_KV: kv as unknown as KVNamespace,
      };
      const bodyBytes = new TextEncoder().encode('{"action":"opened"}');
      const bodyBuffer = bodyBytes.buffer.slice(
        bodyBytes.byteOffset,
        bodyBytes.byteOffset + bodyBytes.byteLength,
      );
      const sig = await sign(bodyBuffer, SECRET);
      const app = buildApp();
      const res = await app.request(
        "/webhooks/inbound/conn_x",
        {
          method: "POST",
          body: bodyBytes,
          headers: {
            "x-hub-signature-256": `sha256=${sig}`,
            "x-github-delivery": "abc-123",
          },
        },
        env,
      );
      // Pre-T-009: this would 401 with "verification_method_not_implemented_in_layer_1:github".
      // Post-T-009: GitHub adapter is in the dispatch table; valid signature → 202.
      expect(res.status).toBe(202);
      expect(queue.calls).toHaveLength(1);
      const enqueued = queue.calls[0]!.body as Record<string, unknown>;
      expect(enqueued.delivery_id).toBe("abc-123");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  // T-247: per-integration webhook-receipt queue routing.

  it("routes to the per-integration producer when one is bound (T-247)", async () => {
    const shared = mockQueue();
    const inbox = mockQueue();
    const originalFetch = globalThis.fetch;
    globalThis.fetch = mockMymeFetch({
      subscriptions: [
        {
          ...SUBSCRIPTION,
          integration_name: "mymehq.inbox",
        },
      ],
    });
    try {
      const env: ControlPlaneEnv = {
        MYME_API_URL: "http://localhost:0",
        MYME_RUNTIME_BROKER_KEY: "myme_k1_broker",
        WEBHOOK_RECEIPT_QUEUE: shared,
        WEBHOOK_RECEIPT_QUEUE_MYMEHQ_INBOX: inbox,
      };
      const bodyBytes = new TextEncoder().encode('{"email":"x"}');
      const bodyBuffer = bodyBytes.buffer.slice(
        bodyBytes.byteOffset,
        bodyBytes.byteOffset + bodyBytes.byteLength,
      );
      const sig = await sign(bodyBuffer, SECRET);
      const app = buildApp();
      const res = await app.request(
        "/webhooks/inbound/conn_x",
        {
          method: "POST",
          body: bodyBytes,
          headers: {
            "x-myme-signature": `sha256=${sig}`,
            "x-myme-delivery-id": "msg_42",
          },
        },
        env,
      );
      expect(res.status).toBe(202);
      const body: { routed_via?: string } = await res.json();
      expect(body.routed_via).toBe("dedicated");
      // Dedicated producer was used, not the shared.
      expect(inbox.calls).toHaveLength(1);
      expect(shared.calls).toHaveLength(0);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("falls back to the shared queue when no dedicated binding exists (T-247)", async () => {
    const shared = mockQueue();
    const originalFetch = globalThis.fetch;
    globalThis.fetch = mockMymeFetch({
      subscriptions: [
        {
          ...SUBSCRIPTION,
          integration_name: "mymehq.github-webhooks",
        },
      ],
    });
    try {
      const env: ControlPlaneEnv = {
        MYME_API_URL: "http://localhost:0",
        MYME_RUNTIME_BROKER_KEY: "myme_k1_broker",
        WEBHOOK_RECEIPT_QUEUE: shared,
        // No WEBHOOK_RECEIPT_QUEUE_MYMEHQ_GITHUB_WEBHOOKS — fallback path.
      };
      const bodyBytes = new TextEncoder().encode('{"event":"push"}');
      const bodyBuffer = bodyBytes.buffer.slice(
        bodyBytes.byteOffset,
        bodyBytes.byteOffset + bodyBytes.byteLength,
      );
      const sig = await sign(bodyBuffer, SECRET);
      const app = buildApp();
      const res = await app.request(
        "/webhooks/inbound/conn_x",
        {
          method: "POST",
          body: bodyBytes,
          headers: {
            "x-myme-signature": `sha256=${sig}`,
            "x-myme-delivery-id": "gh_42",
          },
        },
        env,
      );
      expect(res.status).toBe(202);
      const body: { routed_via?: string } = await res.json();
      expect(body.routed_via).toBe("shared");
      expect(shared.calls).toHaveLength(1);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("returns 503 when neither the dedicated nor the shared binding is wired (T-247)", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = mockMymeFetch({
      subscriptions: [
        {
          ...SUBSCRIPTION,
          integration_name: "mymehq.inbox",
        },
      ],
    });
    try {
      const env: ControlPlaneEnv = {
        MYME_API_URL: "http://localhost:0",
        MYME_RUNTIME_BROKER_KEY: "myme_k1_broker",
        // No queue bindings at all.
      };
      const bodyBytes = new TextEncoder().encode('{"email":"x"}');
      const bodyBuffer = bodyBytes.buffer.slice(
        bodyBytes.byteOffset,
        bodyBytes.byteOffset + bodyBytes.byteLength,
      );
      const sig = await sign(bodyBuffer, SECRET);
      const app = buildApp();
      const res = await app.request(
        "/webhooks/inbound/conn_x",
        {
          method: "POST",
          body: bodyBytes,
          headers: { "x-myme-signature": `sha256=${sig}` },
        },
        env,
      );
      expect(res.status).toBe(503);
      const body: { error?: string } = await res.json();
      expect(body.error).toBe("queue_unbound");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("rejects subscriptions with no integration_name (unrouteable)", async () => {
    const queue = mockQueue();
    const originalFetch = globalThis.fetch;
    globalThis.fetch = mockMymeFetch({
      subscriptions: [
        {
          ...SUBSCRIPTION,
          integration_name: undefined as unknown as string,
        },
      ],
    });
    try {
      const env: ControlPlaneEnv = {
        MYME_API_URL: "http://localhost:0",
        MYME_RUNTIME_BROKER_KEY: "myme_k1_broker",
        WEBHOOK_RECEIPT_QUEUE: queue,
      };
      const bodyBytes = new TextEncoder().encode('{"event":"push"}');
      const bodyBuffer = bodyBytes.buffer.slice(
        bodyBytes.byteOffset,
        bodyBytes.byteOffset + bodyBytes.byteLength,
      );
      const sig = await sign(bodyBuffer, SECRET);
      const app = buildApp();
      const res = await app.request(
        "/webhooks/inbound/conn_x",
        {
          method: "POST",
          body: bodyBytes,
          headers: { "x-myme-signature": `sha256=${sig}` },
        },
        env,
      );
      expect(res.status).toBe(500);
      const body: { error?: string } = await res.json();
      expect(body.error).toBe("subscription_unrouteable");
      expect(queue.calls).toHaveLength(0);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
