import { createServer, type Server } from "node:http";
import { gunzipSync } from "node:zlib";
import { expect } from "vitest";

/**
 * Where a server or the command line under test reports an unhandled fault,
 * in the places a fixture can read: the log records, spans and metrics it exports over
 * OTLP, and the exceptions the server sends to error tracking. One receiver on
 * the loopback address is all three, so a fixture boots its server with
 * {@link FaultSinks.serverEnv}, or runs the command line with
 * {@link FaultSinks.env}, and reads what arrived. The server posts a batch to
 * PostHog's capture v1.
 */
export interface FaultSinks {
  /**
   * The command line's settings that point its reports at the receiver. They
   * name the switch too, since a test run tells the command line to send
   * nothing unless a fixture says otherwise.
   */
  env(): Record<string, string>;
  /**
   * The seeds of a booted test server's stored settings that point its three
   * reports at the receiver.
   */
  serverEnv(): Record<string, string>;
  /** What it was sent as OTLP traces, as OTLP log records, as OTLP metrics and as error tracking's events. */
  readonly traces: Record<string, unknown>[];
  readonly logRecords: Record<string, unknown>[];
  readonly metrics: Record<string, unknown>[];
  readonly trackedErrors: Record<string, unknown>[];
  /** Bodies posted to any other path, so a fixture can show nothing else was sent. */
  readonly elsewhere: Record<string, unknown>[];
  /** The headers of each batch the server posted to capture v1, in order. */
  readonly trackedHeaders: Record<string, string | string[] | undefined>[];
  /**
   * When each batch the server posted to capture v1 reached the receiver, as
   * `performance.now()` read on the request, parallel to `trackedErrors`.
   */
  readonly trackedArrivals: number[];
  /** Each OTLP post, of any signal, with its headers, in order. */
  readonly exports: {
    signal: "traces" | "logs" | "metrics";
    headers: Record<string, string | string[] | undefined>;
    body: Record<string, unknown>;
    /** `performance.now()` when the request reached the receiver, before its body was read. */
    arrivedAt: number;
  }[];
  sentLogRecords(): {
    body: unknown;
    attributes: Record<string, unknown>;
  }[];
  sentSpans(): {
    attributes: Record<string, unknown>;
    events: { name: string; attributes: Record<string, unknown> }[];
  }[];
  /** The `$exception` events error tracking was sent. */
  sentExceptions(): {
    event: string;
    uuid?: string;
    distinct_id?: string;
    timestamp?: string;
    options?: { process_person_profile?: boolean };
    properties: {
      [property: string]: unknown;
      request_id?: string;
      method?: string;
      path?: string;
      error_code?: string;
      $exception_list?: { type: string; value: string }[];
    };
  }[];
  close(): Promise<void>;
}

/**
 * How long a batching exporter may take to send: spans leave on a few
 * seconds' delay and exceptions on a longer one.
 */
export const COLLECTOR_BUDGET_MS = 60_000;
export const COLLECTOR_TEST_TIMEOUT_MS = COLLECTOR_BUDGET_MS + 15_000;

/** Where the server posts its exceptions under the PostHog host: capture v1. */
export const CAPTURE_V1 = "/i/v1/analytics/events";

type OtlpValue = {
  stringValue?: string;
  intValue?: number | string;
  doubleValue?: number;
  boolValue?: boolean;
  kvlistValue?: { values: OtlpAttribute[] };
  arrayValue?: { values: OtlpValue[] };
};
type OtlpAttribute = { key: string; value: OtlpValue };

/** An OTLP value as the plain value it stands for. */
function plain(value: OtlpValue): unknown {
  if (value.kvlistValue !== undefined)
    return attributesOf(value.kvlistValue.values);
  if (value.arrayValue !== undefined) return value.arrayValue.values.map(plain);
  return (
    value.stringValue ?? value.intValue ?? value.doubleValue ?? value.boolValue
  );
}

function attributesOf(
  list: OtlpAttribute[] | undefined,
): Record<string, unknown> {
  return Object.fromEntries((list ?? []).map((a) => [a.key, plain(a.value)]));
}

export async function startFaultSinks(): Promise<FaultSinks> {
  const traces: Record<string, unknown>[] = [];
  const logRecords: Record<string, unknown>[] = [];
  const metrics: Record<string, unknown>[] = [];
  const trackedErrors: Record<string, unknown>[] = [];
  const elsewhere: Record<string, unknown>[] = [];
  const trackedHeaders: FaultSinks["trackedHeaders"][number][] = [];
  const trackedArrivals: number[] = [];
  const exports: FaultSinks["exports"][number][] = [];
  const receiver: Server = createServer((request, response) => {
    const arrivedAt = performance.now();
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      try {
        let raw = Buffer.concat(chunks);
        if (request.headers["content-encoding"] === "gzip")
          raw = gunzipSync(raw);
        const parsed = JSON.parse(raw.toString("utf8")) as Record<
          string,
          unknown
        >;
        const path = request.url ?? "";
        if (path.startsWith("/v1/traces")) {
          traces.push(parsed);
          exports.push({
            signal: "traces",
            headers: { ...request.headers },
            body: parsed,
            arrivedAt,
          });
        } else if (path.startsWith("/v1/metrics")) {
          metrics.push(parsed);
          exports.push({
            signal: "metrics",
            headers: { ...request.headers },
            body: parsed,
            arrivedAt,
          });
        } else if (path.startsWith("/v1/logs")) {
          logRecords.push(parsed);
          exports.push({
            signal: "logs",
            headers: { ...request.headers },
            body: parsed,
            arrivedAt,
          });
        } else if (path.startsWith(CAPTURE_V1)) {
          trackedErrors.push(parsed);
          trackedHeaders.push({ ...request.headers });
          trackedArrivals.push(arrivedAt);
        } else elsewhere.push(parsed);
      } finally {
        response
          .writeHead(200, { "Content-Type": "application/json" })
          .end("{}");
      }
    });
  });
  await new Promise<void>((resolve) =>
    receiver.listen(0, "127.0.0.1", resolve),
  );
  const address = receiver.address();
  if (typeof address !== "object" || address === null) {
    throw new Error("the receiver did not bind to a port");
  }
  const origin = `http://127.0.0.1:${String(address.port)}`;
  return {
    env: () => ({
      OTEL_SDK_DISABLED: "false",
      OTEL_EXPORTER_OTLP_ENDPOINT: origin,
      MARFA_POSTHOG_HOST: origin,
      MARFA_POSTHOG_PROJECT_TOKEN: "phc_conformance_fixture",
    }),
    serverEnv: () => ({
      MARFA_OTEL_EXPORTER_OTLP_ENDPOINT: origin,
      MARFA_POSTHOG_HOST: origin,
      MARFA_POSTHOG_PROJECT_TOKEN: "phc_conformance_fixture",
    }),
    traces,
    logRecords,
    metrics,
    trackedErrors,
    elsewhere,
    trackedHeaders,
    trackedArrivals,
    exports,
    sentLogRecords() {
      type Batch = {
        resourceLogs: {
          scopeLogs: {
            logRecords: { body: OtlpValue; attributes?: OtlpAttribute[] }[];
          }[];
        }[];
      };
      return (logRecords as unknown as Batch[]).flatMap((batch) =>
        batch.resourceLogs.flatMap((resource) =>
          resource.scopeLogs.flatMap((scope) =>
            scope.logRecords.map((record) => ({
              body: plain(record.body),
              attributes: attributesOf(record.attributes),
            })),
          ),
        ),
      );
    },
    sentSpans() {
      type Batch = {
        resourceSpans: {
          scopeSpans: {
            spans: {
              attributes?: OtlpAttribute[];
              events?: { name: string; attributes?: OtlpAttribute[] }[];
            }[];
          }[];
        }[];
      };
      return (traces as unknown as Batch[]).flatMap((batch) =>
        batch.resourceSpans.flatMap((resource) =>
          resource.scopeSpans.flatMap((scope) =>
            scope.spans.map((span) => ({
              attributes: attributesOf(span.attributes),
              events: (span.events ?? []).map((event) => ({
                name: event.name,
                attributes: attributesOf(event.attributes),
              })),
            })),
          ),
        ),
      );
    },
    sentExceptions() {
      type Event = ReturnType<FaultSinks["sentExceptions"]>[number];
      return (trackedErrors as unknown as { batch: Event[] }[])
        .flatMap((batch) => batch.batch)
        .filter((entry) => entry.event === "$exception");
    },
    async close() {
      await new Promise<void>((resolve) => {
        receiver.close(() => resolve());
        receiver.closeAllConnections();
      });
    },
  };
}

/** Polls `read` until it answers something other than `undefined`. */
export async function until<T>(
  what: string,
  read: () => T | undefined | Promise<T | undefined>,
  budgetMs = 15_000,
): Promise<T> {
  const deadline = Date.now() + budgetMs;
  for (;;) {
    const found = await read();
    if (found !== undefined) return found;
    if (Date.now() > deadline) throw new Error(`${what} never arrived`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

/**
 * Holds a report to the rule: the fixed failure and its SQLite code, and none
 * of what the statement or the driver said. `forbidden` is what this fault's
 * statement and driver would have put in it.
 */
export function expectFixedFailure(
  reported: string,
  code: string,
  forbidden: readonly string[],
): void {
  expect(reported).toContain("Database operation failed");
  expect(reported).toContain(code);
  for (const text of forbidden) expect(reported).not.toContain(text);
}
