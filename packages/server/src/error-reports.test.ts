/**
 * What an unhandled failed query puts on every sink that carries an error
 * report.
 *
 * A failed statement's message is its SQL plus the values it was bound to,
 * and for a write those values are the item: its properties, tags and hashes.
 * An error report is read by whoever runs the log stack, the telemetry
 * backend, the error-tracking product and the alert channel, so none of them
 * may carry the values. The statement itself, which says what failed, stays.
 *
 * Each case provokes one real failed write, then reads what every sink
 * received. A test that only asserts absence proves nothing if the thing could
 * never have been there, so each case first shows that the values ARE in the
 * error the storage layer throws, and asserts that every sink received the
 * report before asserting what it does not carry.
 */
import { EventEmitter } from "node:events";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { createHash } from "node:crypto";
import { gunzipSync } from "node:zlib";
import { trace } from "@opentelemetry/api";
import { logs } from "@opentelemetry/api-logs";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { createErrorHandler } from "./middleware/error-handler.js";
import { installUnhandledRejectionReporter } from "./process-faults.js";
import { itemWrites } from "./storage/item-writes.js";
import { createTestContext, request, type TestContext } from "./test-utils.js";

const CANARY_PROPERTY = "canary-property-7c1e9a52";
const CANARY_TAG = "canary-tag-4d08b6f3";
const BLOB_BYTES = new TextEncoder().encode("canary-blob-bytes-91b5e07d");
const CANARY_HASH = createHash("sha256").update(BLOB_BYTES).digest("hex");

interface Received {
  path: string;
  text: string;
}

/** Stands in for the OTLP backend, PostHog and the error webhook at once. */
async function startCollector(): Promise<{
  url: string;
  received: Received[];
  close: () => Promise<void>;
}> {
  const received: Received[] = [];
  const server: Server = createServer((req, res) => {
    void (async () => {
      const chunks: Buffer[] = [];
      for await (const chunk of req) {
        chunks.push(chunk as Buffer);
      }
      const raw = Buffer.concat(chunks);
      const text =
        req.headers["content-encoding"] === "gzip"
          ? gunzipSync(raw).toString("utf8")
          : raw.toString("utf8");
      received.push({ path: req.url ?? "", text });
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end("{}");
    })();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${String(port)}`,
    received,
    close: () =>
      new Promise((resolve) => {
        server.close(() => {
          resolve();
        });
      }),
  };
}

/** Makes every insert into a table fail, the way a full disk or a damaged page would. */
async function refuseInsertsInto(
  ctx: TestContext,
  table: string,
): Promise<void> {
  await (
    ctx.storage as unknown as {
      __sqliteRun: (sql: string, params: unknown[]) => Promise<unknown>;
    }
  ).__sqliteRun(
    `CREATE TRIGGER refuse_inserts BEFORE INSERT ON ${table} BEGIN SELECT RAISE(ABORT, 'refused by the fixture'); END`,
    [],
  );
}

async function allowInserts(ctx: TestContext): Promise<void> {
  await (
    ctx.storage as unknown as {
      __sqliteRun: (sql: string, params: unknown[]) => Promise<unknown>;
    }
  ).__sqliteRun("DROP TRIGGER refuse_inserts", []);
}

/** Turns telemetry on, pointed at the collector for traces, logs and exceptions. */
async function bootTelemetry(collectorUrl: string): Promise<void> {
  vi.stubEnv("MARFA_OTEL_ENABLED", "true");
  vi.stubEnv("OTEL_EXPORTER_OTLP_ENDPOINT", collectorUrl);
  vi.stubEnv("MARFA_OTEL_SAMPLE_RATIO", "1");
  vi.stubEnv("MARFA_POSTHOG_HOST", collectorUrl);
  vi.stubEnv("MARFA_POSTHOG_PROJECT_TOKEN", "phc_test_token");
  vi.stubEnv("MARFA_OTEL_ENVIRONMENT", "test-environment");
  vi.resetModules();
  await import("./instrumentation.js");
}

async function stopTelemetry(): Promise<void> {
  await globalThis.__marfaOtelShutdown?.();
  globalThis.__marfaOtelShutdown = undefined;
  globalThis.__marfaReportException = undefined;
  // The first provider registered wins, so the next case's would be ignored.
  trace.disable();
  logs.disable();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
}

/** Holds each of these sinks to the rule: it received the report, and the value is not in it. */
function expectNoValue(sinks: Record<string, string>, value: string): void {
  for (const [name, text] of Object.entries(sinks)) {
    // The report arrived, and it still names what failed.
    expect.soft(text, `${name} received the report`).toContain("Failed query");
    expect.soft(text, `${name} carries the value`).not.toContain(value);
  }
}

const bodiesAt = (
  collector: Awaited<ReturnType<typeof startCollector>>,
  predicate: (path: string) => boolean,
): string =>
  collector.received
    .filter((r) => predicate(r.path))
    .map((r) => r.text)
    .join("\n");

/**
 * One write that fails at a statement whose values are the thing written:
 * the table that statement inserts into, what the caller sends, and the
 * value of it that statement carries.
 */
const WRITES = [
  {
    name: "an item's properties",
    table: "items",
    canary: CANARY_PROPERTY,
    send: (ctx: TestContext) =>
      request(ctx.app, "POST", "/items", {
        key: ctx.workingKey,
        body: { type: "core.note", properties: { body: CANARY_PROPERTY } },
      }),
  },
  {
    name: "an item's tags",
    table: "metadata",
    canary: CANARY_TAG,
    send: (ctx: TestContext) =>
      request(ctx.app, "POST", "/items", {
        key: ctx.workingKey,
        body: {
          type: "core.note",
          properties: { body: "plain" },
          tags: [CANARY_TAG],
        },
      }),
  },
  {
    name: "a blob's hash",
    table: "blobs",
    canary: CANARY_HASH,
    send: (ctx: TestContext) =>
      ctx.app.request("/blobs", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${ctx.workingKey}`,
          "Content-Type": "application/octet-stream",
        },
        body: BLOB_BYTES,
      }),
  },
] as const;

describe.each(WRITES)("an unhandled failed write of $name", (write) => {
  let ctx: TestContext;
  let collector: Awaited<ReturnType<typeof startCollector>>;
  let stdout: string[];
  let raised: unknown[];

  beforeAll(async () => {
    collector = await startCollector();
    ctx = await createTestContext();
    await refuseInsertsInto(ctx, write.table);
    const handler = createErrorHandler({
      errorWebhookUrl: `${collector.url}/hook`,
    });
    ctx.app.onError((err, c) => {
      raised.push(err);
      return handler(err, c);
    });
  });

  afterAll(async () => {
    await allowInserts(ctx);
    await ctx.cleanup();
    await collector.close();
  });

  beforeEach(() => {
    raised = [];
    collector.received.length = 0;
    stdout = [];
    vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
      stdout.push(String(chunk));
      return true;
    });
  });

  afterEach(stopTelemetry);

  it("reaches no sink with the values the failed statement was bound to", async () => {
    await bootTelemetry(collector.url);

    // A server span is the active one while a real request is handled, and
    // the handler records the error on it.
    let status = 0;
    await trace
      .getTracer("error-reports-test")
      .startActiveSpan("request", async (span) => {
        status = (await write.send(ctx)).status;
        span.end();
      });
    expect(status).toBe(500);

    // The witness: the error the handler was given does carry the value, in
    // its message and in its stack.
    expect(raised).toHaveLength(1);
    const error = raised[0] as Error;
    expect(error.message).toContain(write.canary);
    expect(error.stack).toContain(write.canary);

    await globalThis.__marfaOtelShutdown?.();
    // The webhook is fire-and-forget; give its request time to land.
    await vi.waitFor(() => {
      expect(collector.received.some((r) => r.path === "/hook")).toBe(true);
    });

    expectNoValue(
      {
        "the log line on stdout": stdout.join(""),
        "the exported log record": bodiesAt(collector, (p) =>
          p.endsWith("/v1/logs"),
        ),
        "the exported span and its exception event": bodiesAt(collector, (p) =>
          p.endsWith("/v1/traces"),
        ),
        "the exception sent to error tracking": bodiesAt(collector, (p) =>
          p.startsWith("/batch"),
        ),
        "the error webhook": bodiesAt(collector, (p) => p === "/hook"),
      },
      write.canary,
    );
  });
});

describe("a failed write no request is waiting on", () => {
  let ctx: TestContext;
  let collector: Awaited<ReturnType<typeof startCollector>>;
  let stdout: string[];

  beforeAll(async () => {
    collector = await startCollector();
    ctx = await createTestContext();
    await refuseInsertsInto(ctx, "items");
  });

  afterAll(async () => {
    await allowInserts(ctx);
    await ctx.cleanup();
    await collector.close();
  });

  beforeEach(() => {
    collector.received.length = 0;
    stdout = [];
    vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
      stdout.push(String(chunk));
      return true;
    });
  });

  afterEach(stopTelemetry);

  it("reaches no sink with the values the failed statement was bound to when it ends as an unhandled rejection", async () => {
    await bootTelemetry(collector.url);
    const proc = new EventEmitter();
    installUnhandledRejectionReporter((event, listener) => {
      proc.on(event, listener);
    });

    let rejection: unknown;
    try {
      await itemWrites(ctx.storage).create({
        type: "core.note",
        tier: "library",
        state: "active",
        properties: { body: CANARY_PROPERTY },
        source: "test/error-reports",
      });
    } catch (error) {
      rejection = error;
    }
    // The witness: the rejection carries the value.
    expect((rejection as Error).message).toContain(CANARY_PROPERTY);

    proc.emit("unhandledRejection", rejection, Promise.resolve());
    await globalThis.__marfaOtelShutdown?.();

    expectNoValue(
      {
        "the log line on stdout": stdout.join(""),
        "the exported log record": bodiesAt(collector, (p) =>
          p.endsWith("/v1/logs"),
        ),
        "the exception sent to error tracking": bodiesAt(collector, (p) =>
          p.startsWith("/batch"),
        ),
      },
      CANARY_PROPERTY,
    );
  });
});
