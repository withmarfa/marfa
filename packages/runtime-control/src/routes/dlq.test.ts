/**
 * DLQ route tests (T-084).
 *
 * Stubs `globalThis.fetch` to mock both:
 *   - The Myme server `/system/connections/:id/dlq-context` lookup
 *     (auth gate forwarding).
 *   - Cloudflare's HTTP-pull endpoints (list queues, pull, ack).
 *
 * Producer bindings are injected on the env as plain objects with a
 * `send(body, opts)` method that records calls or throws.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { buildApp } from "../app.js";
import type { ControlPlaneEnv } from "../env.js";
import { _resetQueueIdCacheForTests } from "../cf-queues-pull.js";

interface ResponseShape {
  error?: string;
  messages?: { cf_message_id: string }[];
  replayed?: string[];
  skipped?: { cf_message_id: string; reason: string }[];
}

async function readJson(res: Response): Promise<ResponseShape> {
  return res.json<ResponseShape>();
}

interface ProducerCall {
  body: unknown;
  opts?: { contentType?: "json" | "text" };
}

function mockProducer(opts: { failsToSend?: boolean } = {}): {
  send: (
    body: unknown,
    sopts?: { contentType?: "json" | "text" },
  ) => Promise<void>;
  calls: ProducerCall[];
} {
  const calls: ProducerCall[] = [];
  return {
    calls,
    send(body, sopts) {
      if (opts.failsToSend) {
        return Promise.reject(new Error("producer send failed"));
      }
      calls.push({ body, opts: sopts });
      return Promise.resolve();
    },
  };
}

interface CfQueueMessage {
  id: string;
  lease_id: string;
  body: string;
  timestamp_ms: number;
  attempts: number;
  metadata?: Record<string, unknown>;
}

interface FetchHarnessOpts {
  /** Set to a non-200 status to simulate a denied dlq-context call. */
  dlqContextStatus?: number;
  dlqContextErrorMessage?: string;
  dlqContext?: {
    connection_id: string;
    kind: string;
    state: string;
    integration_name: string | null;
    tenant_id: string | null;
  };
  /** Returned by `GET /accounts/:id/queues`. Maps queue_name → queue_id. */
  queues?: { queue_id: string; queue_name: string }[];
  /** Per-queue-id messages returned by `POST /messages/pull`. */
  pullByQueueId?: Record<string, CfQueueMessage[]>;
  /** Lease ids that fail when acked (simulates ack_failed). */
  ackFailLeaseIds?: Set<string>;
  /** Captures every ack call observed. */
  ackCalls?: { queueId: string; leaseIds: string[] }[];
}

function buildFetchHarness(opts: FetchHarnessOpts): typeof fetch {
  const ackCalls = opts.ackCalls ?? [];
  return ((input: RequestInfo | URL, init?: RequestInit) => {
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.toString()
          : input.url;
    // ---- Myme server: dlq-context ---------------------------------
    if (url.includes("/system/connections/") && url.endsWith("/dlq-context")) {
      const status = opts.dlqContextStatus ?? 200;
      if (status !== 200) {
        return Promise.resolve(
          new Response(
            JSON.stringify({
              error: {
                code: "forbidden",
                message: opts.dlqContextErrorMessage ?? "denied",
              },
            }),
            { status, headers: { "content-type": "application/json" } },
          ),
        );
      }
      const ctx = opts.dlqContext ?? {
        connection_id: "conn_x",
        kind: "integration",
        state: "active",
        integration_name: "mymehq.rss-watcher",
        tenant_id: null,
      };
      return Promise.resolve(
        new Response(JSON.stringify(ctx), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      );
    }
    // ---- Cloudflare API: list queues ------------------------------
    if (
      url.includes("api.cloudflare.com") &&
      url.includes("/queues") &&
      !url.includes("/messages/")
    ) {
      return Promise.resolve(
        new Response(
          JSON.stringify({
            success: true,
            errors: [],
            result: opts.queues ?? [],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      );
    }
    // ---- Cloudflare API: pull -------------------------------------
    const pullMatch = /\/queues\/([^/]+)\/messages\/pull$/.exec(url);
    if (pullMatch) {
      const queueId = pullMatch[1]!;
      const messages = opts.pullByQueueId?.[queueId] ?? [];
      return Promise.resolve(
        new Response(
          JSON.stringify({
            success: true,
            errors: [],
            result: { message_backlog_count: messages.length, messages },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      );
    }
    // ---- Cloudflare API: ack --------------------------------------
    const ackMatch = /\/queues\/([^/]+)\/messages\/ack$/.exec(url);
    if (ackMatch) {
      const queueId = ackMatch[1]!;
      const rawBody = typeof init?.body === "string" ? init.body : "{}";
      const reqBody = JSON.parse(rawBody) as {
        acks?: { lease_id: string }[];
      };
      const leaseIds = (reqBody.acks ?? []).map((a) => a.lease_id);
      ackCalls.push({ queueId, leaseIds });
      const failing = opts.ackFailLeaseIds;
      if (failing && leaseIds.some((l) => failing.has(l))) {
        return Promise.resolve(
          new Response(
            JSON.stringify({
              success: false,
              errors: [{ code: 1, message: "ack rejected" }],
              result: null,
            }),
            { status: 400, headers: { "content-type": "application/json" } },
          ),
        );
      }
      return Promise.resolve(
        new Response(
          JSON.stringify({
            success: true,
            errors: [],
            result: { ackCount: leaseIds.length, retryCount: 0, warnings: {} },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      );
    }
    return Promise.resolve(
      new Response(JSON.stringify({ error: "unmocked" }), {
        status: 500,
        headers: { "content-type": "application/json" },
      }),
    );
  }) as unknown as typeof fetch;
}

function mkMessage(
  id: string,
  leaseId: string,
  body: unknown,
  opts: { attempts?: number; timestampMs?: number } = {},
): CfQueueMessage {
  return {
    id,
    lease_id: leaseId,
    body: JSON.stringify(body),
    timestamp_ms: opts.timestampMs ?? Date.now(),
    attempts: opts.attempts ?? 1,
    metadata: { "CF-Content-Type": "json" },
  };
}

describe("POST /dlq/peek", () => {
  const originalFetch = globalThis.fetch;
  beforeEach(() => {
    _resetQueueIdCacheForTests();
  });
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("rejects unauthenticated callers", async () => {
    globalThis.fetch = buildFetchHarness({});
    const env: ControlPlaneEnv = {
      MYME_API_URL: "https://server.invalid",
      CLOUDFLARE_QUEUES_API_TOKEN: "tok",
      CLOUDFLARE_ACCOUNT_ID: "acc",
      ENVIRONMENT: "dev",
    };
    const res = await buildApp().request(
      "/dlq/peek",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ connection_id: "conn_x" }),
      },
      env,
    );
    expect(res.status).toBe(401);
  });

  it("forwards the operator bearer to dlq-context and surfaces 403 verbatim", async () => {
    globalThis.fetch = buildFetchHarness({
      dlqContextStatus: 403,
      dlqContextErrorMessage: "platform required",
    });
    const env: ControlPlaneEnv = {
      MYME_API_URL: "https://server.invalid",
      CLOUDFLARE_QUEUES_API_TOKEN: "tok",
      CLOUDFLARE_ACCOUNT_ID: "acc",
      ENVIRONMENT: "dev",
    };
    const res = await buildApp().request(
      "/dlq/peek",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: "Bearer op_key",
        },
        body: JSON.stringify({ connection_id: "conn_x" }),
      },
      env,
    );
    expect(res.status).toBe(403);
    const body = await readJson(res);
    expect(body.error).toBe("forbidden");
  });

  it("filters pulled messages to those matching connection_id and surfaces cf_message_id", async () => {
    const env: ControlPlaneEnv = {
      MYME_API_URL: "https://server.invalid",
      CLOUDFLARE_QUEUES_API_TOKEN: "tok",
      CLOUDFLARE_ACCOUNT_ID: "acc",
      ENVIRONMENT: "dev",
    };
    globalThis.fetch = buildFetchHarness({
      queues: [
        { queue_id: "qid-wh", queue_name: "myme-webhook-receipt-dev-dlq" },
        { queue_id: "qid-sp", queue_name: "myme-scheduled-poll-dev-dlq" },
        { queue_id: "qid-rr", queue_name: "myme-reactive-run-dev-dlq" },
      ],
      pullByQueueId: {
        "qid-wh": [
          mkMessage("mid-1", "lease-1", { connection_id: "conn_x", n: 1 }),
          mkMessage("mid-2", "lease-2", {
            connection_id: "conn_other",
            n: 2,
          }),
        ],
        "qid-sp": [
          mkMessage("mid-3", "lease-3", { connection_id: "conn_x", n: 3 }),
        ],
        "qid-rr": [],
      },
    });
    const res = await buildApp().request(
      "/dlq/peek",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: "Bearer op_key",
        },
        body: JSON.stringify({ connection_id: "conn_x" }),
      },
      env,
    );
    expect(res.status).toBe(200);
    const body = await readJson(res);
    const ids = (body.messages ?? []).map((m) => m.cf_message_id).sort();
    expect(ids).toEqual(["mid-1", "mid-3"]);
  });

  it("respects --since by dropping older messages and --limit by truncating", async () => {
    const env: ControlPlaneEnv = {
      MYME_API_URL: "https://server.invalid",
      CLOUDFLARE_QUEUES_API_TOKEN: "tok",
      CLOUDFLARE_ACCOUNT_ID: "acc",
      ENVIRONMENT: "dev",
    };
    const oldTs = Date.parse("2026-01-01T00:00:00Z");
    const newTs = Date.parse("2026-05-08T00:00:00Z");
    globalThis.fetch = buildFetchHarness({
      queues: [
        { queue_id: "qid-wh", queue_name: "myme-webhook-receipt-dev-dlq" },
      ],
      pullByQueueId: {
        "qid-wh": [
          mkMessage(
            "old",
            "lease-old",
            { connection_id: "conn_x" },
            { timestampMs: oldTs },
          ),
          mkMessage(
            "new1",
            "lease-new1",
            { connection_id: "conn_x" },
            { timestampMs: newTs },
          ),
          mkMessage(
            "new2",
            "lease-new2",
            { connection_id: "conn_x" },
            { timestampMs: newTs + 1 },
          ),
        ],
      },
    });
    const res = await buildApp().request(
      "/dlq/peek",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: "Bearer op_key",
        },
        body: JSON.stringify({
          connection_id: "conn_x",
          since: "2026-05-01T00:00:00Z",
          limit: 1,
        }),
      },
      env,
    );
    expect(res.status).toBe(200);
    const body = await readJson(res);
    const messages = body.messages ?? [];
    expect(messages).toHaveLength(1);
    expect(["new1", "new2"]).toContain(messages[0]?.cf_message_id);
  });

  it("returns 503 when CLOUDFLARE_QUEUES_API_TOKEN is unset", async () => {
    globalThis.fetch = buildFetchHarness({});
    const env: ControlPlaneEnv = {
      MYME_API_URL: "https://server.invalid",
      // CLOUDFLARE_QUEUES_API_TOKEN intentionally omitted
      CLOUDFLARE_ACCOUNT_ID: "acc",
      ENVIRONMENT: "dev",
    };
    const res = await buildApp().request(
      "/dlq/peek",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: "Bearer op_key",
        },
        body: JSON.stringify({ connection_id: "conn_x" }),
      },
      env,
    );
    expect(res.status).toBe(503);
    const body = await readJson(res);
    expect(body.error).toBe("cf_queues_not_configured");
  });
});

describe("POST /dlq/replay", () => {
  const originalFetch = globalThis.fetch;
  beforeEach(() => {
    _resetQueueIdCacheForTests();
  });
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("re-enqueues to the matching main producer and acks each replayed message", async () => {
    const ackCalls: { queueId: string; leaseIds: string[] }[] = [];
    const webhookProducer = mockProducer();
    const env: ControlPlaneEnv = {
      MYME_API_URL: "https://server.invalid",
      CLOUDFLARE_QUEUES_API_TOKEN: "tok",
      CLOUDFLARE_ACCOUNT_ID: "acc",
      ENVIRONMENT: "dev",
      WEBHOOK_RECEIPT_QUEUE: webhookProducer,
    };
    globalThis.fetch = buildFetchHarness({
      ackCalls,
      queues: [
        { queue_id: "qid-wh", queue_name: "myme-webhook-receipt-dev-dlq" },
      ],
      pullByQueueId: {
        "qid-wh": [
          mkMessage("mid-1", "lease-1", { connection_id: "conn_x", n: 1 }),
        ],
      },
    });
    const res = await buildApp().request(
      "/dlq/replay",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: "Bearer op_key",
        },
        body: JSON.stringify({ connection_id: "conn_x" }),
      },
      env,
    );
    expect(res.status).toBe(200);
    const body = await readJson(res);
    expect(body.replayed).toEqual(["mid-1"]);
    expect(body.skipped).toEqual([]);
    expect(webhookProducer.calls).toHaveLength(1);
    expect(webhookProducer.calls[0]?.body).toEqual({
      connection_id: "conn_x",
      n: 1,
    });
    expect(ackCalls).toHaveLength(1);
    expect(ackCalls[0]).toEqual({
      queueId: "qid-wh",
      leaseIds: ["lease-1"],
    });
  });

  it("narrows by message_ids and reports unknown ids as not_found", async () => {
    const env: ControlPlaneEnv = {
      MYME_API_URL: "https://server.invalid",
      CLOUDFLARE_QUEUES_API_TOKEN: "tok",
      CLOUDFLARE_ACCOUNT_ID: "acc",
      ENVIRONMENT: "dev",
      WEBHOOK_RECEIPT_QUEUE: mockProducer(),
    };
    globalThis.fetch = buildFetchHarness({
      queues: [
        { queue_id: "qid-wh", queue_name: "myme-webhook-receipt-dev-dlq" },
      ],
      pullByQueueId: {
        "qid-wh": [
          mkMessage("mid-1", "lease-1", { connection_id: "conn_x" }),
          mkMessage("mid-2", "lease-2", { connection_id: "conn_x" }),
        ],
      },
    });
    const res = await buildApp().request(
      "/dlq/replay",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: "Bearer op_key",
        },
        body: JSON.stringify({
          connection_id: "conn_x",
          message_ids: ["mid-1", "mid-bogus"],
        }),
      },
      env,
    );
    expect(res.status).toBe(200);
    const body = await readJson(res);
    expect(body.replayed).toEqual(["mid-1"]);
    expect(body.skipped).toEqual([
      { cf_message_id: "mid-bogus", reason: "not_found" },
    ]);
  });

  it("reports send_failed without acking when the producer binding throws", async () => {
    const ackCalls: { queueId: string; leaseIds: string[] }[] = [];
    const env: ControlPlaneEnv = {
      MYME_API_URL: "https://server.invalid",
      CLOUDFLARE_QUEUES_API_TOKEN: "tok",
      CLOUDFLARE_ACCOUNT_ID: "acc",
      ENVIRONMENT: "dev",
      WEBHOOK_RECEIPT_QUEUE: mockProducer({ failsToSend: true }),
    };
    globalThis.fetch = buildFetchHarness({
      ackCalls,
      queues: [
        { queue_id: "qid-wh", queue_name: "myme-webhook-receipt-dev-dlq" },
      ],
      pullByQueueId: {
        "qid-wh": [mkMessage("mid-1", "lease-1", { connection_id: "conn_x" })],
      },
    });
    const res = await buildApp().request(
      "/dlq/replay",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: "Bearer op_key",
        },
        body: JSON.stringify({ connection_id: "conn_x" }),
      },
      env,
    );
    expect(res.status).toBe(200);
    const body = await readJson(res);
    expect(body.replayed).toEqual([]);
    expect(body.skipped).toEqual([
      { cf_message_id: "mid-1", reason: "send_failed" },
    ]);
    expect(ackCalls).toEqual([]); // never acked when send fails
  });

  it("reports ack_failed when send succeeds but ack throws (message duplicated)", async () => {
    const env: ControlPlaneEnv = {
      MYME_API_URL: "https://server.invalid",
      CLOUDFLARE_QUEUES_API_TOKEN: "tok",
      CLOUDFLARE_ACCOUNT_ID: "acc",
      ENVIRONMENT: "dev",
      WEBHOOK_RECEIPT_QUEUE: mockProducer(),
    };
    globalThis.fetch = buildFetchHarness({
      ackFailLeaseIds: new Set(["lease-1"]),
      queues: [
        { queue_id: "qid-wh", queue_name: "myme-webhook-receipt-dev-dlq" },
      ],
      pullByQueueId: {
        "qid-wh": [mkMessage("mid-1", "lease-1", { connection_id: "conn_x" })],
      },
    });
    const res = await buildApp().request(
      "/dlq/replay",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: "Bearer op_key",
        },
        body: JSON.stringify({ connection_id: "conn_x" }),
      },
      env,
    );
    expect(res.status).toBe(200);
    const body = await readJson(res);
    expect(body.replayed).toEqual([]);
    expect(body.skipped).toEqual([
      { cf_message_id: "mid-1", reason: "ack_failed" },
    ]);
  });

  it("rejects missing connection_id with 400", async () => {
    globalThis.fetch = buildFetchHarness({});
    const env: ControlPlaneEnv = {
      MYME_API_URL: "https://server.invalid",
      CLOUDFLARE_QUEUES_API_TOKEN: "tok",
      CLOUDFLARE_ACCOUNT_ID: "acc",
      ENVIRONMENT: "dev",
    };
    const res = await buildApp().request(
      "/dlq/replay",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: "Bearer op_key",
        },
        body: JSON.stringify({}),
      },
      env,
    );
    expect(res.status).toBe(400);
  });

  it("forwards the dlq-context auth gate (401)", async () => {
    globalThis.fetch = buildFetchHarness({
      dlqContextStatus: 401,
    });
    const env: ControlPlaneEnv = {
      MYME_API_URL: "https://server.invalid",
      CLOUDFLARE_QUEUES_API_TOKEN: "tok",
      CLOUDFLARE_ACCOUNT_ID: "acc",
      ENVIRONMENT: "dev",
    };
    const res = await buildApp().request(
      "/dlq/replay",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: "Bearer op_key",
        },
        body: JSON.stringify({ connection_id: "conn_x" }),
      },
      env,
    );
    expect(res.status).toBe(401);
  });

  // Vitest unused-import guard
  void vi;
});
