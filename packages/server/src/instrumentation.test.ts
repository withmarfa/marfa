import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { gunzipSync } from "node:zlib";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
  close: () => Promise<void>;
}> {
  const events: CapturedEvent[] = [];
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
): Promise<{ loadedPostHog: () => boolean }> {
  const hermetic: Record<string, string> = {
    OTEL_EXPORTER_OTLP_ENDPOINT: "",
    OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: "",
    OTEL_EXPORTER_OTLP_LOGS_ENDPOINT: "",
    MARFA_POSTHOG_HOST: "",
    MARFA_POSTHOG_PROJECT_TOKEN: "",
  };
  for (const [name, value] of Object.entries({ ...hermetic, ...env })) {
    vi.stubEnv(name, value);
  }
  let loaded = false;
  vi.doMock("posthog-node", async (importOriginal) => {
    loaded = true;
    return importOriginal();
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
    globalThis.__marfaOtelShutdown = undefined;
    globalThis.__marfaReportException = undefined;
    vi.doUnmock("posthog-node");
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    await collector.close();
  });

  it("reports a thrown error as an exception with its stack and environment", async () => {
    const boot = await bootInstrumentation({
      MARFA_OTEL_ENABLED: "true",
      MARFA_OTEL_ENVIRONMENT: "test-environment",
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
    expect(captured?.properties["deployment.environment"]).toBe(
      "test-environment",
    );
    expect(captured?.properties.path).toBe("/explode");
    const list = captured?.properties.$exception_list as ExceptionEntry[];
    expect(list[0]?.type).toBe("Error");
    expect(list[0]?.value).toBe("deliberate failure for error tracking");
    const frames = list[0]?.stacktrace?.frames ?? [];
    expect(
      frames.some((frame) => frame.filename?.includes("instrumentation.test")),
    ).toBe(true);
  });

  it("loads and sends nothing with telemetry off", async () => {
    const boot = await bootInstrumentation({
      MARFA_OTEL_ENABLED: "false",
      MARFA_OTEL_ENVIRONMENT: "test-environment",
      MARFA_POSTHOG_HOST: collector.url,
      MARFA_POSTHOG_PROJECT_TOKEN: "phc_test_token",
    });

    const response = await appThatFails().request("/explode");
    expect(response.status).toBe(500);

    expect(boot.loadedPostHog()).toBe(false);
    expect(globalThis.__marfaReportException).toBeUndefined();
    expect(globalThis.__marfaOtelShutdown).toBeUndefined();
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
        MARFA_OTEL_ENABLED: "true",
        MARFA_OTEL_ENVIRONMENT: "test-environment",
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
