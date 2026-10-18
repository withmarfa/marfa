import { createServer, type Server } from "node:http";
import { gunzipSync } from "node:zlib";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  bootFreshServer,
  FRESH_SERVER_TIMEOUT_MS,
  type FreshServer,
} from "../../utils/fresh-server.js";
import { withInstanceDatabase } from "../../utils/instance-database.js";

/**
 * What the server's telemetry says about where it came from: the instance's
 * own id on every log record, span and exception, the attributes and service
 * name the operator set in place of the server's own, and the environment an
 * error notification names.
 *
 * **A server of its own, with a receiver the fixture runs.** The receiver is
 * the OTLP collector for the log records and spans, the PostHog host for the
 * exception, and the error webhook, as `fault-reports.test.ts` arranges it.
 */
let server: FreshServer | undefined;
let receiver: Server | undefined;

const notifications: Record<string, unknown>[] = [];
const traces: Record<string, unknown>[] = [];
const logRecords: Record<string, unknown>[] = [];
const trackedErrors: Record<string, unknown>[] = [];

const ENVIRONMENT = "rehearsal";
const SERVICE = "marfa-fixture";
const TEAM = "a b";

beforeAll(async () => {
  receiver = createServer((request, response) => {
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
        else notifications.push(parsed);
      } finally {
        response
          .writeHead(200, { "Content-Type": "application/json" })
          .end("{}");
      }
    });
  });
  await new Promise<void>((resolve) =>
    receiver!.listen(0, "127.0.0.1", resolve),
  );
  const address = receiver.address();
  if (typeof address !== "object" || address === null) {
    throw new Error("the receiver did not bind to a port");
  }
  const base = `http://127.0.0.1:${String(address.port)}`;
  server = await bootFreshServer("telemetry-identity", {
    ERROR_WEBHOOK_URL: `${base}/errors`,
    OTEL_EXPORTER_OTLP_ENDPOINT: base,
    MARFA_POSTHOG_HOST: base,
    MARFA_POSTHOG_PROJECT_TOKEN: "phc_conformance_fixture",
    OTEL_SERVICE_NAME: SERVICE,
    OTEL_RESOURCE_ATTRIBUTES: `deployment.environment=${ENVIRONMENT},team=a%20b`,
  });
}, 2 * FRESH_SERVER_TIMEOUT_MS);

afterAll(async () => {
  await server?.stop();
  await new Promise<void>((resolve) => {
    if (receiver === undefined) resolve();
    else receiver.close(() => resolve());
    receiver?.closeAllConnections();
  });
}, 2 * FRESH_SERVER_TIMEOUT_MS);

/** Spans leave on a few seconds' delay and exceptions on a longer one. */
const COLLECTOR_BUDGET_MS = 60_000;
const COLLECTOR_TEST_TIMEOUT_MS = COLLECTOR_BUDGET_MS + 15_000;

async function until<T>(
  what: string,
  read: () => T | undefined,
  budgetMs = COLLECTOR_BUDGET_MS,
): Promise<T> {
  const deadline = Date.now() + budgetMs;
  for (;;) {
    const found = read();
    if (found !== undefined) return found;
    if (Date.now() > deadline) throw new Error(`${what} never arrived`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

type OtlpAttribute = { key: string; value: { stringValue?: string } };
type Batches = {
  resource: { attributes?: OtlpAttribute[] };
}[];

/** The resource attributes of each batch the collector was sent. */
function resourcesOf(
  sent: Record<string, unknown>[],
  field: "resourceLogs" | "resourceSpans",
): Record<string, string | undefined>[] {
  return sent.flatMap((batch) =>
    (batch[field] as Batches).map((entry) =>
      Object.fromEntries(
        (entry.resource.attributes ?? []).map((a) => [
          a.key,
          a.value.stringValue,
        ]),
      ),
    ),
  );
}

async function instanceId(): Promise<string> {
  const response = await fetch(`${server!.apiUrl}/`, {
    headers: { Accept: "application/json" },
  });
  return ((await response.json()) as { instance_id: string }).instance_id;
}

describe("what a server's telemetry says of where it came from", () => {
  it(
    "names the instance's id on every log record and span it exports",
    async () => {
      const id = await instanceId();
      // A request makes a span, and its log line is a record.
      expect((await fetch(`${server!.apiUrl}/health`)).status).toBe(200);
      await until("an exported span", () =>
        traces.length > 0 ? true : undefined,
      );
      await until("an exported log record", () =>
        logRecords.length > 0 ? true : undefined,
      );

      for (const [field, sent] of [
        ["resourceSpans", traces],
        ["resourceLogs", logRecords],
      ] as const) {
        const resources = resourcesOf(sent, field);
        expect(resources.length, field).toBeGreaterThan(0);
        for (const resource of resources) {
          expect(resource["service.instance.id"], field).toBe(id);
        }
      }
    },
    COLLECTOR_TEST_TIMEOUT_MS,
  );

  it(
    "names the attributes and the service name the operator set, in place of its own",
    async () => {
      await until("an exported log record", () =>
        logRecords.length > 0 ? true : undefined,
      );
      for (const [field, sent] of [
        ["resourceSpans", traces],
        ["resourceLogs", logRecords],
      ] as const) {
        for (const resource of resourcesOf(sent, field)) {
          expect(resource["service.name"], field).toBe(SERVICE);
          expect(resource["deployment.environment"], field).toBe(ENVIRONMENT);
          expect(resource.team, field).toBe(TEAM);
        }
      }
    },
    COLLECTOR_TEST_TIMEOUT_MS,
  );

  it(
    "names the instance and the environment in an exception and an error notification",
    async () => {
      const id = await instanceId();
      const requestId = "telemetry-identity-faulted";
      // The witness: with the table there the write lands.
      const post = (request: string) =>
        fetch(`${server!.apiUrl}/items`, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${server!.workingKey}`,
            "Content-Type": "application/json",
            "X-Request-ID": request,
          },
          body: JSON.stringify({
            type: "core.note",
            properties: { body: "telemetry identity" },
          }),
        });
      expect((await post("telemetry-identity-landed")).status).toBe(201);
      withInstanceDatabase(server!.sqlitePath, (db) => {
        db.exec("ALTER TABLE event_log RENAME TO event_log_gone");
      });
      try {
        expect((await post(requestId)).status).toBe(500);
      } finally {
        withInstanceDatabase(server!.sqlitePath, (db) => {
          db.exec("ALTER TABLE event_log_gone RENAME TO event_log");
        });
      }

      type Event = {
        event: string;
        properties: Record<string, string | undefined>;
      };
      const exception = await until(
        "the exception sent to error tracking",
        () =>
          (trackedErrors as unknown as { batch: Event[] }[])
            .flatMap((batch) => batch.batch)
            .find(
              (entry) =>
                entry.event === "$exception" &&
                entry.properties.request_id === requestId,
            ),
      );
      expect(exception.properties["service.instance.id"]).toBe(id);
      expect(exception.properties["deployment.environment"]).toBe(ENVIRONMENT);
      expect(exception.properties["service.name"]).toBe(SERVICE);

      const notification = await until("the error notification", () =>
        notifications.find((entry) => entry.request_id === requestId),
      );
      expect(notification.environment).toBe(ENVIRONMENT);
    },
    COLLECTOR_TEST_TIMEOUT_MS,
  );
});
