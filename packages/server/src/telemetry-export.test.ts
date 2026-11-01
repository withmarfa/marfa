/**
 * What one setting, the OTLP endpoint, turns on: a request's trace with spans
 * below the HTTP span for its storage access, and its log lines, all arriving
 * at the collector and all carrying the request id. With the setting absent,
 * no trace or log is exported and no telemetry SDK or exporter module is loaded.
 *
 * The first case runs the real server process under the preload, so the HTTP
 * span is the one `HttpInstrumentation` makes. The rest run in this process,
 * with a span of the test's own standing in for the HTTP span, to hold the
 * sampling rule at ratios the process case cannot set up.
 */
import { type ChildProcess, spawn } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { request as httpRequest } from "node:http";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { SpanKind, trace } from "@opentelemetry/api";
import { logs } from "@opentelemetry/api-logs";
import type { InStatement } from "@libsql/client";
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
import { TransactionFailure } from "./storage/sqlite/transaction-control.js";
import {
  startStubCollector,
  type ReceivedSpan,
  type StubCollector,
} from "./otel/stub-collector.js";
import { createTestContext, request, type TestContext } from "./test-utils.js";

const failure = vi.hoisted(() => ({ commit: false }));
vi.mock("@libsql/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@libsql/client")>();
  return {
    ...actual,
    createClient: (...args: Parameters<typeof actual.createClient>) => {
      const client = actual.createClient(...args);
      const execute = client.execute.bind(client);
      client.execute = async (
        statement: InStatement | string,
        ...rest: unknown[]
      ) => {
        const text = typeof statement === "string" ? statement : statement.sql;
        if (failure.commit && text === "COMMIT") {
          failure.commit = false;
          throw new Error("commit acknowledgment lost");
        }
        return execute(statement, ...(rest as []));
      };
      return client;
    },
  };
});

const SERVER_ROOT = fileURLToPath(new URL("..", import.meta.url));

// ---------------------------------------------------------------------------
// The server as a process
// ---------------------------------------------------------------------------

const dirs: string[] = [];
const servers: ChildProcess[] = [];

afterEach(() => {
  for (const server of servers.splice(0)) server.kill("SIGKILL");
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

async function freePort(): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const probe = createServer();
    probe.once("error", reject);
    probe.listen(0, () => {
      const address = probe.address();
      const port = typeof address === "object" && address ? address.port : 0;
      probe.close(() => {
        resolvePort(port);
      });
    });
  });
}

async function controlPost(
  socketPath: string,
  path: string,
  body: unknown,
): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const req = httpRequest(
      {
        socketPath,
        path,
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(payload),
        },
      },
      (res) => {
        let output = "";
        res.setEncoding("utf8");
        res.on("data", (part: string) => {
          output += part;
        });
        res.on("end", () => {
          try {
            expect(res.statusCode, output).toBe(201);
            resolve(JSON.parse(output) as Record<string, unknown>);
          } catch (error) {
            reject(error instanceof Error ? error : new Error(String(error)));
          }
        });
        res.on("error", reject);
      },
    );
    req.on("error", reject);
    req.end(payload);
  });
}

/** Starts the server under the telemetry preload, as the image does. */
async function bootServer(env: Record<string, string>): Promise<{
  url: string;
  socketPath: string;
  output: () => string;
  stop: () => Promise<void>;
}> {
  const dir = mkdtempSync(join(realpathSync("/tmp"), "marfa-telemetry-"));
  dirs.push(dir);
  const port = await freePort();
  const socketPath = join(dir, "control", "marfa.sock");
  const child = spawn(
    process.execPath,
    ["--import", "tsx", "--import", "./src/instrumentation.ts", "src/index.ts"],
    {
      cwd: SERVER_ROOT,
      env: {
        ...process.env,
        NODE_ENV: "test",
        PORT: String(port),
        SQLITE_PATH: join(dir, "marfa.db"),
        BLOB_PATH: join(dir, "blobs"),
        MARFA_CONTROL_SOCKET: socketPath,
        MARFA_CONTROL_ONLY: "false",
        MARFA_AUTH_BASE_URL: `http://127.0.0.1:${String(port)}`,
        MARFA_AUTH_SECRET: "test-secret-for-local-runs-0123456789abcdef",
        RATE_LIMIT_ENABLED: "false",
        MARFA_ENRICHMENT_ENABLED: "false",
        OTEL_SDK_DISABLED: "false",
        ...env,
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  servers.push(child);
  let output = "";
  child.stdout.setEncoding("utf8").on("data", (c: string) => (output += c));
  child.stderr.setEncoding("utf8").on("data", (c: string) => (output += c));
  const exited = new Promise<void>((resolve) => {
    child.once("close", () => {
      resolve();
    });
  });
  const url = `http://127.0.0.1:${String(port)}`;
  const deadline = Date.now() + 60_000;
  for (;;) {
    if (Date.now() > deadline) throw new Error(`no answer:\n${output}`);
    try {
      if ((await fetch(`${url}/health`)).ok) break;
    } catch {
      // Not listening yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return {
    url,
    socketPath,
    output: () => output,
    stop: async () => {
      child.kill("SIGTERM");
      await exited;
    },
  };
}

/** The spans from `span` down to the root, nearest first. */
function ancestry(span: ReceivedSpan, all: ReceivedSpan[]): ReceivedSpan[] {
  const chain: ReceivedSpan[] = [];
  let parent = all.find((s) => s.spanId === span.parentSpanId);
  while (parent && chain.length < 20) {
    chain.push(parent);
    const next: ReceivedSpan | undefined = all.find(
      (s) => s.spanId === parent?.parentSpanId,
    );
    parent = next;
  }
  return chain;
}

describe("the server process with the OTLP endpoint set", () => {
  it("exports a request's trace with storage spans below the HTTP span, and its log lines, all carrying the request id", async () => {
    const collector = await startStubCollector();
    try {
      const server = await bootServer({
        OTEL_EXPORTER_OTLP_ENDPOINT: collector.url,
        MARFA_OTEL_SAMPLE_RATIO: "1",
      });
      await controlPost(server.socketPath, "/_control/setup/claim", {
        email: "owner@example.com",
        password: "telemetry-test-password",
      });
      const minted = await controlPost(server.socketPath, "/keys", {
        label: "telemetry-reader",
        source: "telemetry-reader",
        type_permissions: { "*": "read" },
      });
      const requestId = "telemetry-e2e-request-1";
      const response = await fetch(`${server.url}/items?limit=1`, {
        headers: {
          Authorization: `Bearer ${String(minted.key)}`,
          "X-Request-ID": requestId,
        },
      });
      expect(response.status, server.output()).toBe(200);
      const instanceId = (
        (await (
          await fetch(`${server.url}/`, {
            headers: { Accept: "application/json" },
          })
        ).json()) as {
          instance_id: string;
        }
      ).instance_id;
      await server.stop();

      // The instance names itself on everything it sends, by the id its
      // root answers, so instances sharing a collector can be told apart.
      const named = `"service.instance.id","value":{"stringValue":"${instanceId}"}`;
      for (const suffix of ["/v1/traces", "/v1/logs"]) {
        const posts = collector.posts.filter((p) => p.path.endsWith(suffix));
        expect(posts.length, suffix).toBeGreaterThan(0);
        for (const post of posts) expect(post.text, suffix).toContain(named);
      }

      const spans = collector.spans();
      const http = spans.find(
        (span) => span.attributes["marfa.request_id"] === requestId,
      );
      expect(http, "the HTTP span carries the request id").toBeDefined();
      const storage = spans.filter(
        (span) => span.attributes["marfa.storage.store"] !== undefined,
      );
      const below = storage.filter((span) =>
        ancestry(span, spans).some((a) => a.spanId === http?.spanId),
      );
      expect(below.length, "storage spans below the HTTP span").toBeGreaterThan(
        0,
      );
      for (const span of below) expect(span.traceId).toBe(http?.traceId);

      const lines = collector
        .logRecords()
        .filter((record) => record.attributes.request_id === requestId);
      expect(lines.length, "a log line with the request id").toBeGreaterThan(0);
      for (const line of lines) expect(line.traceId).toBe(http?.traceId);
    } finally {
      await collector.close();
    }
  }, 120_000);
});

// ---------------------------------------------------------------------------
// Sampling, in this process
// ---------------------------------------------------------------------------

async function startTelemetry(
  collectorUrl: string,
  ratio: string,
): Promise<void> {
  vi.stubEnv("OTEL_SDK_DISABLED", "false");
  vi.stubEnv("OTEL_EXPORTER_OTLP_ENDPOINT", collectorUrl);
  vi.stubEnv("MARFA_OTEL_SAMPLE_RATIO", ratio);
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

describe("what is exported at each sample ratio", () => {
  let ctx: TestContext;
  let collector: StubCollector;

  beforeAll(async () => {
    ctx = await createTestContext();
  });

  afterAll(async () => {
    await ctx.cleanup();
  });

  beforeEach(async () => {
    collector = await startStubCollector();
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  });

  afterEach(async () => {
    await stopTelemetry();
    await collector.close();
  });

  /** One handled request under a span of the test's own, which is its trace. */
  async function inTrace(
    name: string,
    requestId: string,
    run: () => Promise<Response>,
  ): Promise<{ traceId: string; status: number }> {
    return trace
      .getTracer("telemetry-export-test")
      .startActiveSpan(name, { kind: SpanKind.SERVER }, async (span) => {
        span.setAttribute("marfa.request_id", requestId);
        const response = await run();
        span.end();
        return { traceId: span.spanContext().traceId, status: response.status };
      });
  }

  const listItems = (requestId: string) => () =>
    request(ctx.app, "GET", "/items?limit=1", {
      key: ctx.workingKey,
      headers: { "X-Request-ID": requestId },
    });

  it("exports a successful request's trace and its log lines at ratio 1", async () => {
    await startTelemetry(collector.url, "1");
    const { traceId, status } = await inTrace(
      "GET /items",
      "ratio-one-ok",
      listItems("ratio-one-ok"),
    );
    expect(status).toBe(200);
    await globalThis.__marfaOtelShutdown?.();

    const spans = collector.spans().filter((span) => span.traceId === traceId);
    expect(spans.some((span) => span.name === "GET /items")).toBe(true);
    expect(
      spans.some((span) => span.attributes["marfa.storage.store"] === "items"),
    ).toBe(true);
    const line = collector
      .logRecords()
      .find((record) => record.attributes.request_id === "ratio-one-ok");
    expect(line?.traceId).toBe(traceId);
  });

  it("drops a successful request's trace at ratio 0", async () => {
    await startTelemetry(collector.url, "0");
    const { traceId, status } = await inTrace(
      "GET /items",
      "ratio-zero-ok",
      listItems("ratio-zero-ok"),
    );
    expect(status).toBe(200);
    await globalThis.__marfaOtelShutdown?.();

    expect(collector.spans().filter((s) => s.traceId === traceId)).toEqual([]);
    // The log line is not sampled: it still arrives, so the empty trace
    // above is the ratio's doing and not a collector that heard nothing.
    expect(
      collector
        .logRecords()
        .some((record) => record.attributes.request_id === "ratio-zero-ok"),
    ).toBe(true);
  });

  it("exports nothing for a request whose route rolled a transaction back with its own signal, at ratio 0", async () => {
    await startTelemetry(collector.url, "0");
    class RolledBack extends Error {}
    const { traceId } = await inTrace(
      "POST /signal",
      "ratio-zero-rollback",
      async () => {
        await ctx.storage
          .runInTransaction(() => {
            throw new RolledBack("a signal the route chose");
          })
          .catch(() => undefined);
        return new Response(null, { status: 200 });
      },
    );
    await globalThis.__marfaOtelShutdown?.();
    expect(collector.spans().filter((s) => s.traceId === traceId)).toEqual([]);
  });

  it("exports the whole trace of a request whose transaction could not commit, though the route answered normally, at ratio 0", async () => {
    await startTelemetry(collector.url, "0");
    let thrown: unknown;
    const { traceId } = await inTrace(
      "POST /bulk",
      "ratio-zero-commit",
      async () => {
        await listItems("ratio-zero-commit")();
        failure.commit = true;
        // A bulk route answers a partial result for this failure.
        await ctx.storage
          .runInTransaction(async () => {
            await ctx.storage.settings.set("telemetry-commit", "value");
          })
          .catch((error: unknown) => {
            thrown = error;
          });
        return new Response(null, { status: 200 });
      },
    );
    expect(thrown).toBeInstanceOf(TransactionFailure);
    await globalThis.__marfaOtelShutdown?.();

    const spans = collector.spans().filter((s) => s.traceId === traceId);
    const transaction = spans.find(
      (s) => s.name === "storage.runInTransaction",
    );
    expect(transaction?.status?.code).toBe(2);
    expect(spans.some((s) => s.name === "POST /bulk")).toBe(true);
    expect(spans.some((s) => s.name === "settings.set")).toBe(true);
    expect(spans.some((s) => s.name.startsWith("items."))).toBe(true);
  });

  it("exports the whole trace of a request that failed, whatever the ratio", async () => {
    await startTelemetry(collector.url, "0");
    const { traceId, status } = await inTrace(
      "POST /items",
      "ratio-zero-failed",
      async () => {
        // A storage call that succeeds first: its span ends before the
        // failure is known, and must still be exported with the trace.
        await listItems("ratio-zero-failed")();
        await refuseInserts(ctx);
        try {
          return await request(ctx.app, "POST", "/items", {
            key: ctx.workingKey,
            headers: { "X-Request-ID": "ratio-zero-failed" },
            body: { type: "core.note", properties: { body: "plain" } },
          });
        } finally {
          await allowInserts(ctx);
        }
      },
    );
    expect(status).toBe(500);
    await globalThis.__marfaOtelShutdown?.();

    const spans = collector.spans().filter((span) => span.traceId === traceId);
    const root = spans.find((span) => span.name === "POST /items");
    expect(root, "the request's own span").toBeDefined();
    const succeeded = spans.filter(
      (span) =>
        span.attributes["marfa.storage.store"] !== undefined &&
        span.status?.code !== 2,
    );
    expect(
      succeeded.length,
      "a storage span that did not fail",
    ).toBeGreaterThan(0);
    const failed = spans.filter(
      (span) =>
        span.attributes["marfa.storage.store"] !== undefined &&
        span.status?.code === 2,
    );
    expect(failed.length, "the storage span that failed").toBeGreaterThan(0);
  });
});

async function refuseInserts(ctx: TestContext): Promise<void> {
  await (
    ctx.storage as unknown as {
      __sqliteRun: (sql: string, params: unknown[]) => Promise<unknown>;
    }
  ).__sqliteRun(
    "CREATE TRIGGER refuse_inserts BEFORE INSERT ON items BEGIN SELECT RAISE(ABORT, 'refused by the fixture'); END",
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

// ---------------------------------------------------------------------------
// Nothing loaded, nothing sent
// ---------------------------------------------------------------------------

/** The telemetry modules the preload imports when it exports. */
const TELEMETRY_MODULES = [
  "@opentelemetry/sdk-trace",
  "@opentelemetry/context-async-hooks",
  "@opentelemetry/core",
  "@opentelemetry/exporter-trace-otlp-http",
  "@opentelemetry/instrumentation",
  "@opentelemetry/instrumentation-http",
  "@opentelemetry/sdk-logs",
  "@opentelemetry/exporter-logs-otlp-http",
  "@opentelemetry/resources",
  "posthog-node",
] as const;

async function bootRecordingLoads(
  env: Record<string, string>,
): Promise<string[]> {
  const loaded: string[] = [];
  for (const name of TELEMETRY_MODULES) {
    vi.doMock(name, async (importOriginal) => {
      loaded.push(name);
      return importOriginal();
    });
  }
  for (const [name, value] of Object.entries({
    OTEL_EXPORTER_OTLP_ENDPOINT: "",
    OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: "",
    OTEL_EXPORTER_OTLP_LOGS_ENDPOINT: "",
    MARFA_POSTHOG_HOST: "",
    MARFA_POSTHOG_PROJECT_TOKEN: "",
    OTEL_SDK_DISABLED: "false",
    ...env,
  })) {
    vi.stubEnv(name, value);
  }
  vi.resetModules();
  await import("./instrumentation.js");
  // What a request does, so a module the storage layer pulls in lazily is
  // counted too.
  const { createTestContext: build } = await import("./test-utils.js");
  const context = await build();
  try {
    await request(context.app, "GET", "/items?limit=1", {
      key: context.workingKey,
    });
  } finally {
    await context.cleanup();
  }
  return loaded;
}

describe("the telemetry SDK is loaded only when the endpoint is set", () => {
  let collector: StubCollector;

  beforeEach(async () => {
    collector = await startStubCollector();
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  });

  afterEach(async () => {
    await stopTelemetry();
    for (const name of TELEMETRY_MODULES) vi.doUnmock(name);
    await collector.close();
  });

  it("loads every one of them when it is set, with the PostHog pair", async () => {
    const loaded = await bootRecordingLoads({
      OTEL_EXPORTER_OTLP_ENDPOINT: collector.url,
      MARFA_POSTHOG_HOST: collector.url,
      MARFA_POSTHOG_PROJECT_TOKEN: "phc_test_token",
    });
    // The witness for the case below: each module it asserts absent is
    // present here.
    expect(loaded.sort()).toEqual([...TELEMETRY_MODULES].sort());
  });

  it("loads none of them, and sends nothing, when it is absent", async () => {
    const loaded = await bootRecordingLoads({});
    expect(loaded).toEqual([]);
    expect(globalThis.__marfaOtelShutdown).toBeUndefined();
    expect(collector.posts).toHaveLength(0);
  });
});
