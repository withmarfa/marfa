/**
 * OpenTelemetry bootstrap.
 *
 * MUST be loaded before any instrumented module, via Node's `--import`:
 *   prod: `node --import ./dist/instrumentation.js dist/index.js`
 *   dev:  `tsx  --import ./src/instrumentation.ts  src/index.ts`
 * ESM hoists `import` statements, so calling an init function at the top of
 * `index.ts` would run AFTER index.ts's own imports (`node:http`,
 * `@hono/node-server`, ...) have already been evaluated — too late for HTTP
 * auto-instrumentation to patch them. A `--import` preload finishes (its
 * top-level await is awaited) before the main entry loads.
 *
 * Settings come from `bootConfig()`, the same read the server entry gets
 * after this preload finishes, so a bad value stops the process here,
 * before anything else has started.
 *
 * Full no-op while `MARFA_OTEL_ENABLED` is off: the heavy SDK modules are
 * dynamically imported only inside the enabled branch, so a disabled boot
 * never loads them. Traces and logs are independently gated on their
 * endpoint being set — a deployment exporting to PostHog sets only the
 * logs endpoint, because there is no general-trace store to point at, so
 * traces are built but unexported.
 *
 * Exceptions are a third, separate pipeline, gated on `MARFA_POSTHOG_HOST`
 * and `MARFA_POSTHOG_PROJECT_TOKEN`. PostHog's error tracking groups
 * `$exception` events, and an OTLP log record lands in its logs product
 * whatever exception attributes it carries, so the logs pipeline alone
 * leaves error tracking empty. `posthog-node` builds those events from a
 * thrown value, stack frames included.
 */
import { bootConfig, SettingsError } from "./config.js";
import type { AppConfig } from "./config.js";
import { reportableError } from "./error-text.js";

declare global {
  /**
   * Flush + shut down the OpenTelemetry pipelines. Set here when OTel is
   * enabled so `index.ts`'s graceful-shutdown handler can await a final
   * flush before `process.exit` — critical on an ephemeral container,
   * where scale-to-zero SIGTERMs the process and the last batch
   * of error logs/traces would otherwise be lost. Undefined when OTel is
   * off; the caller no-ops.
   */
  var __marfaOtelShutdown: (() => Promise<void>) | undefined;
  /**
   * Report an error no handler answered to PostHog's error tracking. Set
   * here only when exception reporting is configured; undefined otherwise,
   * and the error handler skips it.
   */
  var __marfaReportException:
    | ((err: unknown, properties: Record<string, string | undefined>) => void)
    | undefined;
}

function bootLog(
  level: "info" | "warn" | "error",
  message: string,
  extra: Record<string, unknown> = {},
): void {
  process.stdout.write(
    `${JSON.stringify({ timestamp: new Date().toISOString(), level, message, ...extra })}\n`,
  );
}

function readConfig(): AppConfig {
  try {
    return bootConfig();
  } catch (err) {
    if (!(err instanceof SettingsError)) throw err;
    bootLog("error", "Failed to start server", { error: err.message });
    process.exit(1);
  }
}

async function start(): Promise<void> {
  const config = readConfig();
  const otel = config.otel;
  if (!otel?.enabled) return;

  const {
    tracesEndpoint,
    logsEndpoint,
    sampleRatio,
    serviceName,
    posthogHost,
    posthogToken,
  } = otel;
  const reportExceptions = Boolean(posthogHost);

  if (!tracesEndpoint && !logsEndpoint && !reportExceptions) {
    bootLog(
      "warn",
      "MARFA_OTEL_ENABLED is on but no OTLP endpoint or PostHog host is set; OpenTelemetry is inert.",
    );
    return;
  }
  // The settings schema refuses an exporting configuration without it.
  const deploymentEnvironment = otel.environment ?? "";

  // Resource attribute key for the deployment environment. The literal
  // string is used deliberately rather than a `@opentelemetry/semantic-conventions`
  // constant — the deployment-environment attribute moved namespaces across
  // spec versions, so a constant import risks resolving to `undefined` on a
  // mismatched package version. The wire key is stable; pin it directly.

  const { resourceFromAttributes } = await import("@opentelemetry/resources");
  const { ATTR_SERVICE_NAME, ATTR_SERVICE_VERSION } =
    await import("@opentelemetry/semantic-conventions");
  const resourceAttributes = {
    [ATTR_SERVICE_NAME]: serviceName,
    [ATTR_SERVICE_VERSION]: config.versionSha ?? "dev",
    "deployment.environment": deploymentEnvironment,
  };
  const resource = resourceFromAttributes(resourceAttributes);

  interface Shutdownable {
    shutdown: () => Promise<void>;
  }
  let tracerProvider: Shutdownable | undefined;
  let loggerProvider: Shutdownable | undefined;
  let exceptionClient: Shutdownable | undefined;

  // ---- Traces ----
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
      headers: otel.tracesHeaders,
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

  // ---- Logs ----
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

    const logExporter = new OTLPLogExporter({
      url: logsEndpoint,
      headers: otel.logsHeaders,
    });
    const provider = new LoggerProvider({
      resource,
      processors: [
        new PiiRedactionLogRecordProcessor(),
        // The processor takes its exporter on an options object rather than
        // positionally. Passing it positionally still type-checks against a
        // loose signature and yields a processor with no exporter, so logs
        // batch and are then dropped without a word.
        new BatchLogRecordProcessor({ exporter: logExporter }),
      ],
    });
    logs.setGlobalLoggerProvider(provider);
    loggerProvider = provider;
  }

  // ---- Exceptions ----
  if (reportExceptions) {
    const { PostHog } = await import("posthog-node");
    const client = new PostHog(posthogToken, {
      host: posthogHost,
      // The address an event arrives from is the server's own, so a
      // location looked up from it describes the host, not a person.
      disableGeoip: true,
    });
    exceptionClient = client;
    globalThis.__marfaReportException = (err, properties) => {
      // No distinct id: the event is the instance's, and the client then
      // sends it without creating a person.
      client.captureException(reportableError(err), undefined, {
        ...resourceAttributes,
        ...properties,
      });
    };
  }

  globalThis.__marfaOtelShutdown = async () => {
    await Promise.allSettled([
      tracerProvider?.shutdown(),
      loggerProvider?.shutdown(),
      exceptionClient?.shutdown(),
    ]);
  };

  bootLog("info", "OpenTelemetry initialized", {
    service_name: serviceName,
    traces: Boolean(tracesEndpoint),
    logs: Boolean(logsEndpoint),
    exceptions: reportExceptions,
    sample_ratio: sampleRatio,
  });
}

await start();
