import { createServer, type Server } from "node:http";
import { gunzipSync } from "node:zlib";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  bootFreshServer,
  FRESH_SERVER_TIMEOUT_MS,
  type FreshServer,
} from "../../utils/fresh-server.js";
import { CAPTURE_V1 } from "../../utils/fault-sinks.js";

/**
 * What the server's telemetry says about where it came from: the instance's
 * own id and the server's version on every log record, span and exception,
 * the attributes and service name the operator set in place of the server's
 * own, no environment the operator did not name, and the environment an
 * error notification names. Which requests leave a log record is here too.
 *
 * **A server of its own, with a receiver the fixture runs.** The receiver is
 * the OTLP collector for the log records and spans, the PostHog host for the
 * exception, and the error webhook, as `fault-reports.test.ts` arranges it.
 */
let server: FreshServer | undefined;
let receiver: Server | undefined;
let base = "";

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
        else if (path.startsWith(CAPTURE_V1)) trackedErrors.push(parsed);
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
  base = `http://127.0.0.1:${String(address.port)}`;
  server = await bootFreshServer("telemetry-identity", {
    ...reporting(),
    OTEL_SERVICE_NAME: SERVICE,
    OTEL_RESOURCE_ATTRIBUTES: `deployment.environment=${ENVIRONMENT},team=a%20b`,
  });
}, 2 * FRESH_SERVER_TIMEOUT_MS);

/** Every report pointed at the receiver, and every trace kept. */
function reporting(): Record<string, string> {
  return {
    MARFA_ERROR_WEBHOOK_URL: `${base}/errors`,
    OTEL_SDK_DISABLED: "false",
    OTEL_EXPORTER_OTLP_ENDPOINT: base,
    MARFA_POSTHOG_HOST: base,
    MARFA_POSTHOG_PROJECT_TOKEN: "phc_conformance_fixture",
    // Every trace, so a request that succeeds is exported too.
    MARFA_OTEL_SAMPLE_RATIO: "1",
  };
}

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

function plainAttributes(
  list: OtlpAttribute[] | undefined,
): Record<string, string | undefined> {
  return Object.fromEntries(
    (list ?? []).map((a) => [a.key, a.value.stringValue]),
  );
}

/** The resource attributes of each batch the collector was sent. */
function resourcesOf(
  sent: Record<string, unknown>[],
  field: "resourceLogs" | "resourceSpans",
): Record<string, string | undefined>[] {
  return sent.flatMap((batch) =>
    (batch[field] as Batches).map((entry) =>
      plainAttributes(entry.resource.attributes),
    ),
  );
}

/** The `request_id` of each log record the collector was sent. */
function loggedRequestIds(): (string | undefined)[] {
  type Logs = {
    scopeLogs: { logRecords: { attributes?: OtlpAttribute[] }[] }[];
  }[];
  return logRecords.flatMap((batch) =>
    (batch.resourceLogs as Logs).flatMap((resource) =>
      resource.scopeLogs.flatMap((scope) =>
        scope.logRecords.map(
          (record) => plainAttributes(record.attributes).request_id,
        ),
      ),
    ),
  );
}

type Event = {
  event: string;
  properties: Record<string, string | undefined>;
};

/** The exception sent for the request `requestId`, once it has arrived. */
function exceptionOf(requestId: string): Promise<Event> {
  return until("the exception sent to error tracking", () =>
    (trackedErrors as unknown as { batch: Event[] }[])
      .flatMap((batch) => batch.batch)
      .find(
        (entry) =>
          entry.event === "$exception" &&
          entry.properties.request_id === requestId,
      ),
  );
}

/** What `target` was exported, told apart by its instance id. */
function resourcesFrom(
  id: string,
): { field: string; resource: Record<string, string | undefined> }[] {
  return (["resourceSpans", "resourceLogs"] as const).flatMap((field) =>
    resourcesOf(field === "resourceSpans" ? traces : logRecords, field)
      .filter((resource) => resource["service.instance.id"] === id)
      .map((resource) => ({ field, resource })),
  );
}

/**
 * One unhandled fault under `requestId`: the audit entry of one write fails,
 * as `fault-reports.test.ts` makes it.
 */
async function faulted(target: FreshServer, requestId: string): Promise<void> {
  const post = (request: string) =>
    fetch(`${target.apiUrl}/items`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${target.workingKey}`,
        "Content-Type": "application/json",
        "X-Request-ID": request,
      },
      body: JSON.stringify({
        type: "core.note",
        properties: { body: "telemetry identity" },
      }),
    });
  // The witness: with no fault the write lands.
  expect((await post(`${requestId}-landed`)).status).toBe(201);
  await target.setFault("fail:audit=item.create");
  expect((await post(requestId)).status).toBe(500);
}

async function described(
  target: FreshServer = server!,
): Promise<{ instance_id: string; version: string }> {
  const response = await fetch(`${target.apiUrl}/`, {
    headers: { Accept: "application/json" },
  });
  return (await response.json()) as { instance_id: string; version: string };
}

async function instanceId(): Promise<string> {
  return (await described()).instance_id;
}

describe("what a server's telemetry says of where it came from", () => {
  it(
    "names the instance's id on every log record and span it exports",
    async () => {
      const id = await instanceId();
      // A request makes a span, and a refused one's log line is a record.
      expect((await fetch(`${server!.apiUrl}/items`)).status).toBe(401);
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
      await faulted(server!, requestId);

      const exception = await exceptionOf(requestId);
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

  it(
    "names its version on every log record, span and exception, unless the operator names one",
    async () => {
      const { instance_id: id, version } = await described();
      const requestId = "telemetry-identity-version";
      await faulted(server!, requestId);
      expect((await exceptionOf(requestId)).properties["service.version"]).toBe(
        version,
      );
      const own = await until("this server's exports", () => {
        const found = resourcesFrom(id);
        return found.some(({ field }) => field === "resourceSpans") &&
          found.some(({ field }) => field === "resourceLogs")
          ? found
          : undefined;
      });
      for (const { field, resource } of own) {
        expect(resource["service.version"], field).toBe(version);
      }

      const named = await bootFreshServer("telemetry-identity-version", {
        ...reporting(),
        OTEL_RESOURCE_ATTRIBUTES: "service.version=9.8.7",
      });
      try {
        const namedId = (await described(named)).instance_id;
        const namedRequest = "telemetry-identity-named-version";
        await faulted(named, namedRequest);
        expect(
          (await exceptionOf(namedRequest)).properties["service.version"],
        ).toBe("9.8.7");
        const theirs = await until("the named server's exports", () => {
          const found = resourcesFrom(namedId);
          return found.some(({ field }) => field === "resourceSpans") &&
            found.some(({ field }) => field === "resourceLogs")
            ? found
            : undefined;
        });
        for (const { field, resource } of theirs) {
          expect(resource["service.version"], field).toBe("9.8.7");
        }
      } finally {
        await named.stop();
      }
    },
    COLLECTOR_TEST_TIMEOUT_MS + FRESH_SERVER_TIMEOUT_MS,
  );

  it(
    "names no environment of its own when the operator names none",
    async () => {
      // The witness: this fixture's own server names the environment it was
      // given, on what it exports and on the exception.
      const witness = "telemetry-identity-environment-witness";
      await faulted(server!, witness);
      expect(
        (await exceptionOf(witness)).properties["deployment.environment"],
      ).toBe(ENVIRONMENT);

      const unnamed = await bootFreshServer("telemetry-identity-unnamed", {
        ...reporting(),
        OTEL_RESOURCE_ATTRIBUTES: "",
      });
      try {
        const id = (await described(unnamed)).instance_id;
        const requestId = "telemetry-identity-unnamed";
        await faulted(unnamed, requestId);
        const exception = await exceptionOf(requestId);
        expect(exception.properties).not.toHaveProperty(
          "deployment.environment",
        );
        expect(exception.properties).not.toHaveProperty(
          "deployment.environment.name",
        );
        const exported = await until("the unnamed server's exports", () => {
          const found = resourcesFrom(id);
          return found.some(({ field }) => field === "resourceSpans") &&
            found.some(({ field }) => field === "resourceLogs")
            ? found
            : undefined;
        });
        for (const { field, resource } of exported) {
          expect(resource, field).not.toHaveProperty("deployment.environment");
          expect(resource, field).not.toHaveProperty(
            "deployment.environment.name",
          );
        }
      } finally {
        await unnamed.stop();
      }
    },
    COLLECTOR_TEST_TIMEOUT_MS + FRESH_SERVER_TIMEOUT_MS,
  );

  it(
    "exports no log record of a health check or a quick read that went well, and does of a failed read and a write",
    async () => {
      const ask = (
        path: string,
        requestId: string,
        init: RequestInit = {},
      ): Promise<Response> =>
        fetch(`${server!.apiUrl}${path}`, {
          ...init,
          headers: {
            Authorization: `Bearer ${server!.workingKey}`,
            "Content-Type": "application/json",
            "X-Request-ID": requestId,
          },
        });
      const quiet = ["quiet-health", "quiet-list", "quiet-head"];
      expect((await ask("/health", quiet[0]!)).status).toBe(200);
      expect((await ask("/items?limit=1", quiet[1]!)).status).toBe(200);
      expect(
        (await ask("/items?limit=1", quiet[2]!, { method: "HEAD" })).status,
      ).toBe(200);
      // The witnesses, sent after: a read that failed and a write.
      const failed = await ask("/items/no-such-item", "loud-missing");
      expect(failed.ok, String(failed.status)).toBe(false);
      const write = await ask("/items", "loud-write", {
        method: "POST",
        body: JSON.stringify({
          type: "core.note",
          properties: { body: "telemetry identity" },
        }),
      });
      expect(write.status).toBe(201);

      await until("the witnesses' log records", () =>
        ["loud-missing", "loud-write"].every((id) =>
          loggedRequestIds().includes(id),
        )
          ? true
          : undefined,
      );
      const logged = loggedRequestIds();
      for (const id of quiet) expect(logged, id).not.toContain(id);

      // Each still has its line in the request log on standard output.
      const output = await server!.output();
      for (const id of [...quiet, "loud-missing", "loud-write"]) {
        expect(output, id).toContain(`"request_id":"${id}"`);
      }
    },
    COLLECTOR_TEST_TIMEOUT_MS,
  );

  it(
    "names deployment.environment.name in an error notification before deployment.environment",
    async () => {
      // A server of its own, with telemetry off: the environment an alert
      // names comes from the attributes either way. The first server's
      // table cannot be put back in a state it will boot from again.
      const named = await bootFreshServer("telemetry-identity-name", {
        MARFA_ERROR_WEBHOOK_URL: `${base}/errors`,
        OTEL_RESOURCE_ATTRIBUTES:
          "deployment.environment=old,deployment.environment.name=named",
      });
      try {
        const requestId = "telemetry-identity-named";
        await faulted(named, requestId);
        const notification = await until("the error notification", () =>
          notifications.find((entry) => entry.request_id === requestId),
        );
        expect(notification.environment).toBe("named");
      } finally {
        await named.stop();
      }
    },
    COLLECTOR_TEST_TIMEOUT_MS + FRESH_SERVER_TIMEOUT_MS,
  );
});
