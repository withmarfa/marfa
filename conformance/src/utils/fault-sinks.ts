import { createServer, type Server } from "node:http";
import { gunzipSync } from "node:zlib";
import { expect } from "vitest";

/**
 * Where a server or the command line under test reports an unhandled fault,
 * in the places a fixture can read: the error webhook, the log records and
 * spans it exports over OTLP, and the exceptions it sends to error tracking.
 * One receiver on the loopback address is all four, so a fixture boots its
 * server with {@link FaultSinks.env} and reads what arrived. The command line
 * posts a single event to the capture path where the server posts a batch.
 */
export interface FaultSinks {
  /** The settings that point the server's four reports at the receiver. */
  env(): Record<string, string>;
  /** What the error webhook was sent, parsed. */
  readonly notifications: Record<string, unknown>[];
  /** What it was sent as OTLP traces, as OTLP log records and as error tracking's events. */
  readonly traces: Record<string, unknown>[];
  readonly logRecords: Record<string, unknown>[];
  readonly trackedErrors: Record<string, unknown>[];
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
    properties: {
      request_id?: string;
      method?: string;
      path?: string;
      command?: string;
      exit_code?: number;
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
  const notifications: Record<string, unknown>[] = [];
  const traces: Record<string, unknown>[] = [];
  const logRecords: Record<string, unknown>[] = [];
  const trackedErrors: Record<string, unknown>[] = [];
  const receiver: Server = createServer((request, response) => {
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
        if (path.startsWith("/v1/traces")) traces.push(parsed);
        else if (path.startsWith("/v1/logs")) logRecords.push(parsed);
        else if (path.startsWith("/batch")) trackedErrors.push(parsed);
        else if (path.startsWith("/i/v0/e/"))
          trackedErrors.push({ batch: [parsed] });
        else notifications.push(parsed);
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
      ERROR_WEBHOOK_URL: `${origin}/errors`,
      OTEL_EXPORTER_OTLP_ENDPOINT: origin,
      MARFA_POSTHOG_HOST: origin,
      MARFA_POSTHOG_PROJECT_TOKEN: "phc_conformance_fixture",
    }),
    notifications,
    traces,
    logRecords,
    trackedErrors,
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
  read: () => T | undefined,
  budgetMs = 15_000,
): Promise<T> {
  const deadline = Date.now() + budgetMs;
  for (;;) {
    const found = read();
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
