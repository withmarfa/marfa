import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { gunzipSync } from "node:zlib";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { trace } from "@opentelemetry/api";
import { logs } from "@opentelemetry/api-logs";
import { Hono } from "hono";
import { createErrorHandler } from "./middleware/error-handler.js";
import type { AppEnv } from "./middleware/auth.js";

interface CapturedEvent {
  event: string;
  properties: Record<string, unknown>;
}

interface ExceptionEntry {
  type?: string;
  value?: string;
  stacktrace?: { frames?: { function?: string; filename?: string }[] };
}

/** Stands in for PostHog's capture endpoint and keeps every event posted. */
async function startStubCollector(): Promise<{
  url: string;
  events: CapturedEvent[];
  requests: { path: string; text: string }[];
  close: () => Promise<void>;
}> {
  const events: CapturedEvent[] = [];
  const requests: { path: string; text: string }[] = [];
  const readBody = async (req: IncomingMessage): Promise<string> => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const raw = Buffer.concat(chunks);
    return req.headers["content-encoding"] === "gzip"
      ? gunzipSync(raw).toString("utf8")
      : raw.toString("utf8");
  };
  const server: Server = createServer((req, res) => {
    void readBody(req).then((text) => {
      requests.push({ path: req.url ?? "", text });
      const body = JSON.parse(text) as { batch?: CapturedEvent[] };
      events.push(...(body.batch ?? []));
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end("{}");
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${String(port)}`,
    events,
    requests,
    close: () =>
      new Promise((resolve) => {
        server.close(() => {
          resolve();
        });
      }),
  };
}

function appThatFails(): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  app.onError(createErrorHandler({ errorWebhookUrl: "" }));
  app.get("/explode", () => {
    throw new Error("deliberate failure for error tracking");
  });
  return app;
}

/**
 * Loads `instrumentation.ts` afresh under the given environment, recording
 * whether it reached for the PostHog client.
 */
async function bootInstrumentation(
  env: Record<string, string>,
  onPostHogConstruct?: () => void,
): Promise<{ loadedPostHog: () => boolean }> {
  const hermetic: Record<string, string> = {
    OTEL_EXPORTER_OTLP_ENDPOINT: "",
    OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: "",
    OTEL_EXPORTER_OTLP_LOGS_ENDPOINT: "",
    MARFA_POSTHOG_HOST: "",
    MARFA_POSTHOG_PROJECT_TOKEN: "",
    MARFA_TEST_HOOKS: "false",
  };
  for (const [name, value] of Object.entries({ ...hermetic, ...env })) {
    vi.stubEnv(name, value);
  }
  let loaded = false;
  vi.doMock("posthog-node", async (importOriginal) => {
    loaded = true;
    const original = await importOriginal<typeof import("posthog-node")>();
    return {
      ...original,
      PostHog: new Proxy(original.PostHog, {
        construct(target, args, newTarget) {
          onPostHogConstruct?.();
          return Reflect.construct(target, args, newTarget) as object;
        },
      }),
    };
  });
  vi.resetModules();
  await import("./instrumentation.js");
  return { loadedPostHog: () => loaded };
}

describe("unhandled errors reach PostHog's error tracking", () => {
  let collector: Awaited<ReturnType<typeof startStubCollector>>;

  beforeEach(async () => {
    collector = await startStubCollector();
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  });

  afterEach(async () => {
    await globalThis.__marfaOtelShutdown?.();
    const clock = await import("./clock.js");
    clock.resetClockForTests();
    globalThis.__marfaOtelShutdown = undefined;
    globalThis.__marfaReportException = undefined;
    // The first provider registered wins, so the next case's would be ignored.
    trace.disable();
    logs.disable();
    vi.doUnmock("posthog-node");
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    await collector.close();
  });

  it.each([false, true])(
    "isolates work scheduled by telemetry construction with test hooks: %s",
    async (testHooks) => {
      const systemDate = Date;
      let release!: () => void;
      const wait = new Promise<void>((resolve) => {
        release = resolve;
      });
      let external!: Promise<number>;
      await bootInstrumentation(
        {
          MARFA_TEST_HOOKS: String(testHooks),
          OTEL_EXPORTER_OTLP_ENDPOINT: collector.url,
          MARFA_POSTHOG_HOST: collector.url,
          MARFA_POSTHOG_PROJECT_TOKEN: "phc_test_token",
        },
        () => {
          external = wait.then(() => Date.now() - systemDate.now());
        },
      );
      const clock = await import("./clock.js");
      try {
        clock.advanceClock(86_400_000);
        expect(Date.now() - systemDate.now()).toBeGreaterThanOrEqual(
          testHooks ? 86_399_900 : -100,
        );
        if (!testHooks) expect(Date).toBe(systemDate);
      } finally {
        release();
      }
      expect(Math.abs(await external)).toBeLessThan(100);
    },
  );

  it("installs the test clock even when telemetry is disabled", async () => {
    const systemDate = Date;
    await bootInstrumentation({ MARFA_TEST_HOOKS: "true" });
    const clock = await import("./clock.js");
    clock.advanceClock(86_400_000);
    expect(Date.now() - systemDate.now()).toBeGreaterThan(86_399_900);
  });

  it("reports a thrown error as an exception with its stack and environment", async () => {
    const boot = await bootInstrumentation({
      OTEL_EXPORTER_OTLP_ENDPOINT: collector.url,
      MARFA_POSTHOG_HOST: collector.url,
      MARFA_POSTHOG_PROJECT_TOKEN: "phc_test_token",
    });

    const response = await appThatFails().request("/explode");
    expect(response.status).toBe(500);
    await globalThis.__marfaOtelShutdown?.();

    expect(boot.loadedPostHog()).toBe(true);
    const exceptions = collector.events.filter((e) => e.event === "$exception");
    expect(exceptions).toHaveLength(1);
    const [captured] = exceptions;
    expect(captured?.properties["deployment.environment"]).toBe("production");
    expect(captured?.properties.path).toBe("/explode");
    const list = captured?.properties.$exception_list as ExceptionEntry[];
    expect(list[0]?.type).toBe("Error");
    expect(list[0]?.value).toBe("deliberate failure for error tracking");
    const frames = list[0]?.stacktrace?.frames ?? [];
    expect(
      frames.some((frame) => frame.filename?.includes("instrumentation.test")),
    ).toBe(true);
  });

  it("starts with an exporting endpoint and no environment name, and every export says production", async () => {
    const exit = vi.spyOn(process, "exit").mockImplementation(() => {
      throw new Error("exited");
    });
    const written: string[] = [];
    vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
      written.push(String(chunk));
      return true;
    });
    // The endpoint, the PostHog pair and nothing that names an environment.
    await bootInstrumentation({
      OTEL_EXPORTER_OTLP_ENDPOINT: collector.url,
      MARFA_POSTHOG_HOST: collector.url,
      MARFA_POSTHOG_PROJECT_TOKEN: "phc_test_token",
    });

    expect(exit).not.toHaveBeenCalled();
    expect(written.join("")).toContain("OpenTelemetry initialized");
    expect(globalThis.__marfaOtelShutdown).toBeDefined();

    await trace.getTracer("test").startActiveSpan("request", async (span) => {
      await appThatFails().request("/explode");
      span.end();
    });
    logs.getLogger("test").emit({ body: "a line", attributes: {} });
    await globalThis.__marfaOtelShutdown?.();

    const named =
      /"deployment\.environment","value":\{"stringValue":"production"\}/;
    const sent = (suffix: string) =>
      collector.requests.filter((r) => r.path.endsWith(suffix));
    expect(sent("/v1/traces").length).toBeGreaterThan(0);
    expect(sent("/v1/logs").length).toBeGreaterThan(0);
    for (const request of [...sent("/v1/traces"), ...sent("/v1/logs")]) {
      expect(request.text).toMatch(named);
    }
    const [exception] = collector.events.filter(
      (e) => e.event === "$exception",
    );
    expect(exception?.properties["deployment.environment"]).toBe("production");
  });

  describe("OTEL_RESOURCE_ATTRIBUTES and OTEL_SERVICE_NAME", () => {
    const sent = (suffix: string) =>
      collector.requests.filter((r) => r.path.endsWith(suffix));
    const attribute = (key: string, value: string) =>
      `"${key}","value":{"stringValue":"${value}"}`;

    it("replace the environment and the service name the server states, on traces, logs and exceptions", async () => {
      await bootInstrumentation({
        OTEL_EXPORTER_OTLP_ENDPOINT: collector.url,
        MARFA_POSTHOG_HOST: collector.url,
        MARFA_POSTHOG_PROJECT_TOKEN: "phc_test_token",
        OTEL_SERVICE_NAME: "marfa-rehearsal",
        OTEL_RESOURCE_ATTRIBUTES:
          "deployment.environment=rehearsal,service.instance.id=rehearsal-1,team=a%20b",
      });
      globalThis.__marfaTelemetryInstanceId?.(
        "0198f3a2-7c1e-7b52-9d4a-3e5f6a7b8c9d",
      );
      await trace.getTracer("test").startActiveSpan("request", async (span) => {
        await appThatFails().request("/explode");
        span.end();
      });
      logs.getLogger("test").emit({ body: "a line", attributes: {} });
      await globalThis.__marfaOtelShutdown?.();

      expect(sent("/v1/traces").length).toBeGreaterThan(0);
      expect(sent("/v1/logs").length).toBeGreaterThan(0);
      for (const request of [...sent("/v1/traces"), ...sent("/v1/logs")]) {
        expect(request.text).toContain(
          attribute("deployment.environment", "rehearsal"),
        );
        expect(request.text).toContain(
          attribute("service.name", "marfa-rehearsal"),
        );
        expect(request.text).toContain(attribute("team", "a b"));
        // The operator's id stands, and the instance's own is not sent
        // beside it.
        expect(request.text).toContain(
          attribute("service.instance.id", "rehearsal-1"),
        );
        expect(request.text).not.toContain("0198f3a2");
        expect(request.text).not.toContain('"stringValue":"production"');
      }
      const [exception] = collector.events.filter(
        (e) => e.event === "$exception",
      );
      expect(exception?.properties["deployment.environment"]).toBe("rehearsal");
      expect(exception?.properties["service.name"]).toBe("marfa-rehearsal");
      expect(exception?.properties["service.instance.id"]).toBe("rehearsal-1");
    });

    it("send deployment.environment.name alone when that is the name the operator uses", async () => {
      await bootInstrumentation({
        OTEL_EXPORTER_OTLP_ENDPOINT: collector.url,
        OTEL_RESOURCE_ATTRIBUTES: "deployment.environment.name=rehearsal",
      });
      logs.getLogger("test").emit({ body: "a line", attributes: {} });
      await globalThis.__marfaOtelShutdown?.();

      expect(sent("/v1/logs").length).toBeGreaterThan(0);
      for (const request of sent("/v1/logs")) {
        expect(request.text).toContain(
          attribute("deployment.environment.name", "rehearsal"),
        );
        expect(request.text).not.toContain('"deployment.environment"');
      }
    });
  });

  describe("naming the instance", () => {
    const INSTANCE_ID = "0198f3a2-7c1e-7b52-9d4a-3e5f6a7b8c9d";
    const named = (id: string) =>
      new RegExp(
        `"service\\.instance\\.id","value":\\{"stringValue":"${id}"\\}`,
      );
    const sent = (suffix: string) =>
      collector.requests.filter((r) => r.path.endsWith(suffix));

    async function emitEverything(): Promise<void> {
      await trace.getTracer("test").startActiveSpan("request", async (span) => {
        await appThatFails().request("/explode");
        span.end();
      });
      logs.getLogger("test").emit({ body: "a line", attributes: {} });
    }

    it("puts the instance's id on every log record, span and exception once the server has read it", async () => {
      await bootInstrumentation({
        OTEL_EXPORTER_OTLP_ENDPOINT: collector.url,
        MARFA_POSTHOG_HOST: collector.url,
        MARFA_POSTHOG_PROJECT_TOKEN: "phc_test_token",
      });
      globalThis.__marfaTelemetryInstanceId?.(INSTANCE_ID);
      await emitEverything();
      await globalThis.__marfaOtelShutdown?.();

      expect(sent("/v1/traces").length).toBeGreaterThan(0);
      expect(sent("/v1/logs").length).toBeGreaterThan(0);
      for (const request of [...sent("/v1/traces"), ...sent("/v1/logs")]) {
        expect(request.text).toMatch(named(INSTANCE_ID));
      }
      const [exception] = collector.events.filter(
        (e) => e.event === "$exception",
      );
      expect(exception?.properties["service.instance.id"]).toBe(INSTANCE_ID);
    });

    it("still sends what it holds, unnamed, when the server stops before it knows its id", async () => {
      // The witness for the case above: the same export, with the id told.
      await bootInstrumentation({
        OTEL_EXPORTER_OTLP_ENDPOINT: collector.url,
        MARFA_POSTHOG_HOST: collector.url,
        MARFA_POSTHOG_PROJECT_TOKEN: "phc_test_token",
      });
      await emitEverything();
      await globalThis.__marfaOtelShutdown?.();

      expect(sent("/v1/traces").length).toBeGreaterThan(0);
      expect(sent("/v1/logs").length).toBeGreaterThan(0);
      for (const request of [...sent("/v1/traces"), ...sent("/v1/logs")]) {
        expect(request.text).not.toContain("service.instance.id");
      }
      const [exception] = collector.events.filter(
        (e) => e.event === "$exception",
      );
      expect(exception).toBeDefined();
      expect(exception?.properties).not.toHaveProperty("service.instance.id");
    });
  });

  it("loads and sends nothing with no endpoint set", async () => {
    const boot = await bootInstrumentation({});

    const response = await appThatFails().request("/explode");
    expect(response.status).toBe(500);

    expect(boot.loadedPostHog()).toBe(false);
    expect(globalThis.__marfaReportException).toBeUndefined();
    expect(globalThis.__marfaOtelShutdown).toBeUndefined();
    expect(collector.events).toHaveLength(0);
  });

  it("stops the process on a PostHog pair without the endpoint, naming the setting", async () => {
    const write = vi
      .spyOn(process.stdout, "write")
      .mockImplementation(() => true);
    vi.spyOn(process, "exit").mockImplementation(() => {
      throw new Error("exited");
    });
    await expect(
      bootInstrumentation({
        MARFA_POSTHOG_HOST: collector.url,
        MARFA_POSTHOG_PROJECT_TOKEN: "phc_test_token",
      }),
    ).rejects.toThrow("exited");
    const written = write.mock.calls.map((call) => String(call[0])).join("");
    expect(written).toContain(
      "MARFA_POSTHOG_HOST needs OTEL_EXPORTER_OTLP_ENDPOINT set too",
    );
    expect(collector.events).toHaveLength(0);
  });

  it("stops the process on a PostHog host without a project token, naming the setting", async () => {
    const write = vi
      .spyOn(process.stdout, "write")
      .mockImplementation(() => true);
    const exit = vi.spyOn(process, "exit").mockImplementation(() => {
      throw new Error("exited");
    });
    await expect(
      bootInstrumentation({
        OTEL_EXPORTER_OTLP_ENDPOINT: collector.url,
        MARFA_POSTHOG_HOST: collector.url,
      }),
    ).rejects.toThrow("exited");
    expect(exit).toHaveBeenCalledWith(1);
    const written = write.mock.calls.map((call) => String(call[0])).join("");
    expect(written).toContain(
      "MARFA_POSTHOG_HOST needs MARFA_POSTHOG_PROJECT_TOKEN set too",
    );
  });
});
