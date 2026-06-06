/**
 * OpenTelemetry bootstrap.
 *
 * MUST be loaded before any instrumented module, via Node's `--import`:
 *   prod: `node --import ./dist/instrumentation.js dist/index.js`
 *   dev:  `tsx  --import ./src/instrumentation.ts  src/index.ts`
 * ESM hoists `import` statements, so calling an init function at the top of
 * `index.ts` would run AFTER index.ts's own imports (`node:http`, `postgres`,
 * `@hono/node-server`, ...) have already been evaluated — too late for HTTP
 * auto-instrumentation to patch them. A `--import` preload finishes (its
 * top-level await is awaited) before the main entry loads.
 *
 * Config is read from the environment DIRECTLY — the one sanctioned
 * exception to the single-config-read-site invariant, because this runs
 * before `loadConfig` and before any app code. The pure parsers are reused
 * from `config.ts` (no side effects on import).
 *
 * Full no-op when `MARFA_OTEL_ENABLED !== "true"`: the heavy SDK modules are
 * dynamically imported only inside the enabled branch, so a disabled boot
 * never loads them. Traces and logs are independently gated on their
 * endpoint being set — hosted test mode sets only the logs endpoint
 * (PostHog has no general-trace store), so traces are built but unexported.
 */
import { parseOtelHeaders, parseOtelSampleRatio } from "./config.js";

declare global {
  /**
   * Flush + shut down the OpenTelemetry pipelines. Set here when OTel is
   * enabled so `index.ts`'s graceful-shutdown handler can await a final
   * flush before `process.exit` — critical on the ephemeral hosted
   * container, where scale-to-zero SIGTERMs the process and the last batch
   * of error logs/traces would otherwise be lost. Undefined when OTel is
   * off; the caller no-ops.
   */
  var __marfaOtelShutdown: (() => Promise<void>) | undefined;
}

function bootLog(
  level: "info" | "warn",
  message: string,
  extra: Record<string, unknown> = {},
): void {
  process.stdout.write(
    `${JSON.stringify({ timestamp: new Date().toISOString(), level, message, ...extra })}\n`,
  );
}

async function start(): Promise<void> {
  if (process.env.MARFA_OTEL_ENABLED !== "true") return;

  const tracesEndpoint =
    process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT ??
    process.env.OTEL_EXPORTER_OTLP_ENDPOINT ??
    "";
  const logsEndpoint =
    process.env.OTEL_EXPORTER_OTLP_LOGS_ENDPOINT ??
    process.env.OTEL_EXPORTER_OTLP_ENDPOINT ??
    "";
  const headers = parseOtelHeaders(
    process.env.OTEL_EXPORTER_OTLP_TRACES_HEADERS ??
      process.env.OTEL_EXPORTER_OTLP_HEADERS,
  );
  const sampleRatio = parseOtelSampleRatio(process.env.MARFA_OTEL_SAMPLE_RATIO);
  const serviceName = process.env.OTEL_SERVICE_NAME ?? "marfa-server";

  if (!tracesEndpoint && !logsEndpoint) {
    bootLog(
      "warn",
      "MARFA_OTEL_ENABLED=true but no OTLP endpoint set; OpenTelemetry is inert.",
    );
    return;
  }

  const { resourceFromAttributes } = await import("@opentelemetry/resources");
  const { ATTR_SERVICE_NAME, ATTR_SERVICE_VERSION } =
    await import("@opentelemetry/semantic-conventions");
  const resource = resourceFromAttributes({
    [ATTR_SERVICE_NAME]: serviceName,
    [ATTR_SERVICE_VERSION]: process.env.MARFA_VERSION_SHA ?? "dev",
  });

  interface Shutdownable {
    shutdown: () => Promise<void>;
  }
  let tracerProvider: Shutdownable | undefined;
  let loggerProvider: Shutdownable | undefined;

  // ---- Traces: AlwaysOn sampler + redaction + error/baseline export gate ----
  if (tracesEndpoint) {
    const [
      { NodeTracerProvider },
      { AlwaysOnSampler, BatchSpanProcessor },
      { OTLPTraceExporter },
      { registerInstrumentations },
      { HttpInstrumentation },
      { PiiRedactionSpanProcessor },
      { ErrorBucketFilterSpanProcessor },
    ] = await Promise.all([
      import("@opentelemetry/sdk-trace-node"),
      import("@opentelemetry/sdk-trace-base"),
      import("@opentelemetry/exporter-trace-otlp-http"),
      import("@opentelemetry/instrumentation"),
      import("@opentelemetry/instrumentation-http"),
      import("./otel/redaction.js"),
      import("./otel/error-aware-sampler.js"),
    ]);

    const traceExporter = new OTLPTraceExporter({
      url: tracesEndpoint,
      headers,
    });
    const provider = new NodeTracerProvider({
      resource,
      sampler: new AlwaysOnSampler(),
      spanProcessors: [
        // Order matters: redact in place first, then the export gate.
        new PiiRedactionSpanProcessor(),
        new ErrorBucketFilterSpanProcessor(
          new BatchSpanProcessor(traceExporter),
          sampleRatio,
        ),
      ],
    });
    provider.register();
    tracerProvider = provider;
    registerInstrumentations({
      instrumentations: [
        // PII discipline: never lift request/response headers onto span
        // attributes by default — auth/cookie headers would leak.
        new HttpInstrumentation({ headersToSpanAttributes: {} }),
      ],
    });
  }

  // ---- Logs: redaction + OTLP export (PostHog in hosted) ----
  if (logsEndpoint) {
    const [
      { LoggerProvider, BatchLogRecordProcessor },
      { OTLPLogExporter },
      { logs },
      { PiiRedactionLogRecordProcessor },
    ] = await Promise.all([
      import("@opentelemetry/sdk-logs"),
      import("@opentelemetry/exporter-logs-otlp-http"),
      import("@opentelemetry/api-logs"),
      import("./otel/redaction.js"),
    ]);

    const logExporter = new OTLPLogExporter({ url: logsEndpoint, headers });
    const provider = new LoggerProvider({
      resource,
      processors: [
        new PiiRedactionLogRecordProcessor(),
        new BatchLogRecordProcessor(logExporter),
      ],
    });
    logs.setGlobalLoggerProvider(provider);
    loggerProvider = provider;
  }

  globalThis.__marfaOtelShutdown = async () => {
    await Promise.allSettled([
      tracerProvider?.shutdown(),
      loggerProvider?.shutdown(),
    ]);
  };

  bootLog("info", "OpenTelemetry initialized", {
    service_name: serviceName,
    traces: Boolean(tracesEndpoint),
    logs: Boolean(logsEndpoint),
    sample_ratio: sampleRatio,
  });
}

await start();
