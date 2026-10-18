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
 * One setting turns it on: `OTEL_EXPORTER_OTLP_ENDPOINT`. Set, the server
 * exports traces and logs to it (each to its path under it, or to its own
 * `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT` or `OTEL_EXPORTER_OTLP_LOGS_ENDPOINT`
 * as written), and the traces carry a span for each storage call below the
 * HTTP span. Unset, nothing is exported and none of the heavy SDK modules is
 * loaded: they are dynamically imported only past that check. A request's
 * trace and its log lines share the request id and the trace id.
 *
 * Every export names the instance it came from, so that several instances
 * sending to one project can be told apart: `service.instance.id` is the
 * instance's own id, the `instance_id` that `GET /` answers. The id lives in
 * the database, which opens after this preload, so the attribute is a
 * promise the server settles once it has read the id (`index.ts`), and the
 * exporters hold each batch until it has. A server that stops before that
 * settles it empty, so what was queued still leaves, unnamed. The instance's
 * configured name is not an attribute: it can change while the server runs,
 * which a resource, fixed at start, cannot follow, and it can be personal.
 *
 * Exceptions are a third, separate pipeline, gated on `MARFA_POSTHOG_HOST`
 * and `MARFA_POSTHOG_PROJECT_TOKEN`, and on the endpoint being set. PostHog's
 * error tracking groups `$exception` events, and its documentation describes
 * no way for OTLP logs or traces to become them, so the two OTLP pipelines
 * leave error tracking empty. `posthog-node` builds those events from a
 * thrown value, stack frames included.
 */
import { bootConfig, SettingsError } from "./config.js";
import type { AppConfig } from "./config.js";
import { DEFAULT_DEPLOYMENT_ENVIRONMENT } from "./deployment-environment.js";
import { reportableError } from "./error-text.js";
import * as clock from "./clock.js";

declare global {
  /**
   * Flush + shut down the OpenTelemetry pipelines. Set here when
   * telemetry is on so `index.ts`'s graceful-shutdown handler can await a final
   * flush before `process.exit` — critical on an ephemeral container,
   * where scale-to-zero SIGTERMs the process and the last batch
   * of error logs/traces would otherwise be lost. Undefined when
   * telemetry is off; the caller no-ops.
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
  /**
   * Tell telemetry which instance this server is, once its database has
   * said. Set here only when telemetry is on, and undefined otherwise.
   */
  var __marfaTelemetryInstanceId: ((instanceId: string) => void) | undefined;
}

function bootLog(
  level: "info" | "warn" | "error",
  message: string,
  extra: Record<string, unknown> = {},
): void {
  process.stdout.write(
    `${JSON.stringify({ timestamp: clock.now().toISOString(), level, message, ...extra })}\n`,
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
  if (!otel) return;

  const {
    tracesEndpoint,
    logsEndpoint,
    sampleRatio,
    serviceName,
    resourceAttributes: chosenAttributes,
    posthogHost,
    posthogToken,
  } = otel;
  const reportExceptions = Boolean(posthogHost);

  // Resource attribute key for the deployment environment. The literal
  // string is used deliberately rather than a `@opentelemetry/semantic-conventions`
  // constant — the deployment-environment attribute moved namespaces across
  // spec versions, so a constant import risks resolving to `undefined` on a
  // mismatched package version. The wire key is stable; pin it directly.

  const { resourceFromAttributes } = await import("@opentelemetry/resources");
  const { ATTR_SERVICE_NAME, ATTR_SERVICE_VERSION, ATTR_SERVICE_INSTANCE_ID } =
    await import("@opentelemetry/semantic-conventions");
  // What `OTEL_RESOURCE_ATTRIBUTES` names replaces the server's own of the
  // same name. The environment has two names in the convention, so naming
  // either leaves the other unsent rather than contradicting it.
  const environmentChosen =
    "deployment.environment.name" in chosenAttributes ||
    "deployment.environment" in chosenAttributes;
  const staticAttributes: Record<string, string> = {
    [ATTR_SERVICE_VERSION]: config.versionSha ?? "dev",
    ...(environmentChosen
      ? {}
      : { "deployment.environment": DEFAULT_DEPLOYMENT_ENVIRONMENT }),
    ...chosenAttributes,
    [ATTR_SERVICE_NAME]: serviceName,
  };
  const instanceChosen = ATTR_SERVICE_INSTANCE_ID in chosenAttributes;
  // The convention asks that a stable id taken from the service's own data
  // pass through a UUID v5 first. This one does not: it is already a UUID,
  // it reveals nothing the instance's root does not, and an operator needs
  // to find the instance an export came from by the id it answers.
  let instanceId: string | undefined;
  let settleInstanceId!: (id: string | undefined) => void;
  const instanceKnown = new Promise<string | undefined>((resolve) => {
    settleInstanceId = resolve;
  });
  const resource = resourceFromAttributes({
    ...staticAttributes,
    ...(instanceChosen ? {} : { [ATTR_SERVICE_INSTANCE_ID]: instanceKnown }),
  });
  globalThis.__marfaTelemetryInstanceId = (id) => {
    instanceId = id;
    settleInstanceId(id);
  };

  interface Shutdownable {
    shutdown: () => Promise<void>;
  }
  let exceptionClient: Shutdownable | undefined;

  // ---- Traces ----
  const [
    { NodeTracerProvider },
    { AlwaysOnSampler, BatchSpanProcessor },
    { OTLPTraceExporter },
    { registerInstrumentations },
    { HttpInstrumentation },
    { PiiRedactionSpanProcessor, PiiRedactionLogRecordProcessor },
    { BATCH_QUEUE_SIZE, ErrorBucketFilterSpanProcessor },
  ] = await Promise.all([
    import("@opentelemetry/sdk-trace-node"),
    import("@opentelemetry/sdk-trace-base"),
    import("@opentelemetry/exporter-trace-otlp-http"),
    import("@opentelemetry/instrumentation"),
    import("@opentelemetry/instrumentation-http"),
    import("./otel/redaction.js"),
    import("./otel/error-aware-sampler.js"),
  ]);

  const tracerProvider = new NodeTracerProvider({
    resource,
    sampler: new AlwaysOnSampler(),
    spanProcessors: [
      // Order matters: redact in place first, then the export gate. Every
      // span passes through both, the storage spans among them.
      new PiiRedactionSpanProcessor(),
      new ErrorBucketFilterSpanProcessor(
        new BatchSpanProcessor(
          new OTLPTraceExporter({
            url: tracesEndpoint,
            headers: otel.tracesHeaders,
          }),
          { maxQueueSize: BATCH_QUEUE_SIZE },
        ),
        sampleRatio,
      ),
    ],
  });
  tracerProvider.register();
  registerInstrumentations({
    instrumentations: [
      // PII discipline: never lift request/response headers onto span
      // attributes by default — auth/cookie headers would leak.
      new HttpInstrumentation({ headersToSpanAttributes: {} }),
    ],
  });

  // ---- Logs ----
  const [
    { LoggerProvider, BatchLogRecordProcessor },
    { OTLPLogExporter },
    { logs },
  ] = await Promise.all([
    import("@opentelemetry/sdk-logs"),
    import("@opentelemetry/exporter-logs-otlp-http"),
    import("@opentelemetry/api-logs"),
  ]);

  const loggerProvider = new LoggerProvider({
    resource,
    processors: [
      new PiiRedactionLogRecordProcessor(),
      // The processor takes its exporter on an options object rather than
      // positionally. Passing it positionally still type-checks against a
      // loose signature and yields a processor with no exporter, so logs
      // batch and are then dropped without a word.
      new BatchLogRecordProcessor({
        exporter: new OTLPLogExporter({
          url: logsEndpoint,
          headers: otel.logsHeaders,
        }),
      }),
    ],
  });
  logs.setGlobalLoggerProvider(loggerProvider);

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
        ...staticAttributes,
        ...(instanceId === undefined || instanceChosen
          ? {}
          : { [ATTR_SERVICE_INSTANCE_ID]: instanceId }),
        ...properties,
      });
    };
  }

  globalThis.__marfaOtelShutdown = async () => {
    settleInstanceId(undefined);
    await Promise.allSettled([
      tracerProvider.shutdown(),
      loggerProvider.shutdown(),
      exceptionClient?.shutdown(),
    ]);
  };

  bootLog("info", "OpenTelemetry initialized", {
    service_name: serviceName,
    exceptions: reportExceptions,
    sample_ratio: sampleRatio,
  });
}

await start();
