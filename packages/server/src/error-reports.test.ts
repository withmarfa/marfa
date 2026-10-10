/**
 * What an unhandled failed query puts on every sink that carries an error
 * report.
 *
 * A failed statement's message is its SQL plus the values it was bound to,
 * and for a write those values are the content written: an item's
 * properties, tags and hashes, or a delivery's headers, query and body. An
 * error report is read by whoever runs the log stack, the telemetry backend,
 * the error-tracking product and the alert channel, so each receives the
 * fixed database failure with its SQLite code, and nothing of the statement.
 *
 * Each case provokes one real failed write, then reads what every sink
 * received. A test that only asserts absence proves nothing if the thing could
 * never have been there, so each case first shows that the values ARE in the
 * error the storage layer throws, and asserts that every sink received the
 * report before asserting what it does not carry.
 */
import { EventEmitter } from "node:events";
import { inspect } from "node:util";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { createHash } from "node:crypto";
import { gunzipSync } from "node:zlib";
import { serve } from "@hono/node-server";
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
import { installUnhandledRejectionReporter } from "./process-faults.js";
import { itemWrites } from "./storage/item-writes.js";
import {
  createTestContext,
  mintWorkingKey,
  request,
  type TestContext,
} from "./test-utils.js";

/** What the fixture makes the driver say, which is why the statement failed. */
const REASON = "refused by the fixture";

const CANARY_PROPERTY = "canary-property-7c1e9a52";
const CANARY_TAG = "canary-tag-4d08b6f3";
const BLOB_BYTES = new TextEncoder().encode("canary-blob-bytes-91b5e07d");
const CANARY_HASH = createHash("sha256").update(BLOB_BYTES).digest("hex");
const CANARY_HEADER = "canary-header-5a2c81d4";
const CANARY_QUERY = "canary-query-0e6b37f9";
const CANARY_BODY = "canary-body-c94d1e26";

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
    `CREATE TRIGGER refuse_inserts BEFORE INSERT ON ${table} BEGIN SELECT RAISE(ABORT, '${REASON}'); END`,
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

/** Holds each of these sinks to the rule: it received the fixed report, and no value or statement is in it. */
function expectNoValue(
  sinks: Record<string, string>,
  values: readonly string[],
  code: string,
): void {
  for (const [name, text] of Object.entries(sinks)) {
    // The report arrived, and it still says a database operation failed and
    // which SQLite code it failed with.
    expect
      .soft(text, `${name} received the report`)
      .toContain("Database operation failed");
    expect.soft(text, `${name} gives the SQLite code`).toContain(code);
    expect
      .soft(text, `${name} carries the statement`)
      .not.toContain("Failed query");
    expect
      .soft(text, `${name} carries the driver's text`)
      .not.toContain(REASON);
    for (const value of values)
      expect.soft(text, `${name} carries ${value}`).not.toContain(value);
  }
}

/** Records what exception reporting is handed, then hands it on. */
function recordReportedExceptions(): unknown[] {
  const handed: unknown[] = [];
  const report = globalThis.__marfaReportException;
  globalThis.__marfaReportException = (error, properties) => {
    handed.push(error);
    report?.(error, properties);
  };
  return handed;
}

const bodiesAt = (
  collector: Awaited<ReturnType<typeof startCollector>>,
  predicate: (path: string) => boolean,
): string =>
  collector.received
    .filter((r) => predicate(r.path))
    .map((r) => r.text)
    .join("\n");

/** A fresh connector's receiving endpoint, as a sender would address it. */
async function inboundPath(ctx: TestContext): Promise<string> {
  const key = await mintWorkingKey(ctx);
  const connector = await request(ctx.app, "POST", "/connectors", {
    key,
    body: { name: "error reports" },
  });
  const { id } = (await connector.json()) as { id: string };
  const made = await request(ctx.app, "POST", `/connectors/${id}/endpoints`, {
    key,
    body: {},
  });
  return ((await made.json()) as { path: string }).path;
}

async function deliver(ctx: TestContext): Promise<Response> {
  const path = await inboundPath(ctx);
  return ctx.app.request(`${path}?q=${CANARY_QUERY}`, {
    method: "POST",
    headers: { "X-Fixture": CANARY_HEADER },
    body: CANARY_BODY,
  });
}

/** Every value the cases below write, which no sink may carry whichever statement failed. */
const ALL_CANARIES = [
  CANARY_PROPERTY,
  CANARY_TAG,
  CANARY_HASH,
  CANARY_HEADER,
  CANARY_QUERY,
  CANARY_BODY,
];

/**
 * One write that fails at a statement whose values are the thing written:
 * the table that statement inserts into, what the caller sends, and the
 * values of it that statement carries.
 */
const WRITES = [
  {
    name: "an item's properties",
    table: "items",
    canaries: [CANARY_PROPERTY],
    send: (ctx: TestContext) =>
      request(ctx.app, "POST", "/items", {
        key: ctx.workingKey,
        body: { type: "core.note", properties: { body: CANARY_PROPERTY } },
      }),
  },
  {
    name: "an item's tags",
    table: "metadata",
    canaries: [CANARY_TAG],
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
    canaries: [CANARY_HASH],
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
  {
    name: "an inbound delivery's headers and query",
    table: "inbound_deliveries",
    canaries: [CANARY_HEADER, CANARY_QUERY],
    send: deliver,
  },
  {
    name: "an inbound delivery's body",
    table: "inbound_delivery_bodies",
    canaries: [CANARY_BODY],
    send: deliver,
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
    // Each case's alert carries the same fixed text from the same door, which
    // the webhook's debounce would hold back, so each case gets its own.
    vi.resetModules();
    const { createErrorHandler } =
      await import("./middleware/error-handler.js");
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

  it("reaches no sink with the statement or the values it was bound to", async () => {
    await bootTelemetry(collector.url);
    const handed = recordReportedExceptions();

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

    // The witness: the error the handler was given does carry the values, in
    // its message and in its stack.
    expect(raised).toHaveLength(1);
    const error = raised[0] as Error;
    for (const canary of write.canaries) {
      expect(error.message).toContain(canary);
      expect(error.stack).toContain(canary);
    }
    expect((error.cause as Error).message).toContain(REASON);
    expect(handed).toHaveLength(1);

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
        "the error handed to exception reporting": inspect(handed, {
          depth: 10,
        }),
      },
      ALL_CANARIES,
      "SQLITE_CONSTRAINT",
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

  it("reaches no sink with the statement or the values it was bound to when it ends as an unhandled rejection", async () => {
    await bootTelemetry(collector.url);
    const handed = recordReportedExceptions();
    const proc = new EventEmitter();
    installUnhandledRejectionReporter((event, listener) => {
      proc.on(event, listener);
    });

    let rejection: unknown;
    try {
      await itemWrites(ctx.storage).create({
        writer: null,
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
        "the error handed to exception reporting": inspect(handed, {
          depth: 10,
        }),
      },
      ALL_CANARIES,
      "SQLITE_CONSTRAINT",
    );
  });
});

describe("a read that fails after the response has begun", () => {
  let ctx: TestContext;
  let collector: Awaited<ReturnType<typeof startCollector>>;
  let server: ReturnType<typeof serve>;
  let url: string;
  let stdout: string[];

  beforeAll(async () => {
    collector = await startCollector();
    ctx = await createTestContext();
    server = serve({ fetch: ctx.app.fetch, port: 0, hostname: "127.0.0.1" });
    await new Promise<void>((resolve) => server.once("listening", resolve));
    url = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => {
      server.close(() => {
        resolve();
      });
    });
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

  it("reaches no sink, the server's own error printing included, with the statement or the values it was bound to", async () => {
    for (let n = 0; n < 3; n++) {
      const created = await request(ctx.app, "POST", "/items", {
        key: ctx.workingKey,
        body: {
          type: "core.note",
          properties: { body: `exported ${String(n)}` },
        },
      });
      expect(created.status).toBe(201);
    }
    await bootTelemetry(collector.url);

    // The export reads each item's metadata as it streams. The second read
    // finds the table gone, which fails a real statement after the first
    // line has been sent and the response has begun.
    const storage = ctx.storage as unknown as {
      __sqliteRun: (sql: string, params: unknown[]) => Promise<unknown>;
    };
    const real = ctx.storage.metadata.get.bind(ctx.storage.metadata);
    let reads = 0;
    let raised: Error | undefined;
    vi.spyOn(ctx.storage.metadata, "get").mockImplementation(async (id) => {
      reads += 1;
      if (reads === 2) await storage.__sqliteRun("DROP TABLE metadata", []);
      try {
        return await real(id);
      } catch (error) {
        raised = error as Error;
        throw error;
      }
    });
    const printed: unknown[][] = [];
    const errors = vi
      .spyOn(console, "error")
      .mockImplementation((...args: unknown[]) => {
        printed.push(args);
      });
    const stderr: string[] = [];
    vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
      stderr.push(String(chunk));
      return true;
    });

    const response = await fetch(`${url}/export`, {
      headers: { Authorization: `Bearer ${ctx.workingKey}` },
    });
    await response.text().catch(() => undefined);
    await vi.waitFor(() => {
      expect(raised).toBeDefined();
    });
    await globalThis.__marfaOtelShutdown?.();

    // The witness: the failure carries the id the statement was bound to, in
    // its message, its stack and its own fields, which is what the server's
    // printing of an error shows.
    const failure = raised as Error & { params?: unknown };
    const bound = String((failure.params as unknown[])[0]);
    expect(failure.message).toContain(bound);
    expect(failure.stack).toContain(bound);
    expect(inspect(failure)).toContain(bound);
    expect((failure.cause as Error).message).toContain("no such table");
    // The server answered the failure itself, so the stream ended in error.
    expect(errors).toHaveBeenCalled();

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
      [bound],
      "SQLITE_ERROR",
    );
    // What the server's own logging printed, as it would print it.
    expect.soft(inspect(printed, { depth: 10 })).not.toContain(bound);
    expect.soft(stderr.join("")).not.toContain(bound);
  });
});
