import { existsSync, readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { dirname, join } from "node:path";
import { gunzipSync } from "node:zlib";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  bootFreshServer,
  FRESH_SERVER_TIMEOUT_MS,
  type FreshServer,
} from "../../utils/fresh-server.js";
import { withInstanceDatabase } from "../../utils/instance-database.js";

/**
 * What the server reports of an unhandled fault that failed a database
 * statement, in the places a fixture can read: its log, its error webhook,
 * the log record and the span's exception event it exports, and the
 * exception it sends to error tracking. Each carries `Database operation
 * failed` and the SQLite result code, and none of the statement, the driver's
 * own message or the values the write was given.
 *
 * **A fault the fixture makes, on a server of its own.** A table the write
 * reaches is renamed in the stored file, as `internal-error.test.ts` does,
 * and the error webhook names a receiver the fixture runs.
 *
 * **Where the telemetry goes.** The server exports its log record, its
 * spans and its exceptions over HTTP, so the receiver the fixture runs is
 * also the collector for all three: the OTLP endpoint takes the log records
 * and spans, and the PostHog host takes the exception sent to error tracking.
 *
 * **What a fixture cannot reach.** A fault met by a background job or after
 * a response began has no arrangement that does not depend on timing. The
 * server's own suite holds those.
 */
let server: FreshServer | undefined;
let receiver: Server | undefined;

/** What the receiver has been sent, parsed. */
const notifications: Record<string, unknown>[] = [];
/** What it has been sent as OTLP traces, as OTLP log records and as error tracking's events. */
const traces: Record<string, unknown>[] = [];
const logRecords: Record<string, unknown>[] = [];
const trackedErrors: Record<string, unknown>[] = [];

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
  server = await bootFreshServer("fault-reports", {
    ERROR_WEBHOOK_URL: `http://127.0.0.1:${String(address.port)}/errors`,
    MARFA_OTEL_ENABLED: "true",
    OTEL_EXPORTER_OTLP_ENDPOINT: `http://127.0.0.1:${String(address.port)}`,
    MARFA_POSTHOG_HOST: `http://127.0.0.1:${String(address.port)}`,
    MARFA_POSTHOG_PROJECT_TOKEN: "phc_conformance_fixture",
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

/**
 * How long a batching exporter may take to send: spans leave on a few
 * seconds' delay and exceptions on a longer one.
 */
const COLLECTOR_BUDGET_MS = 60_000;
/** A stream re-reads its credential every 30 seconds. */
const HEARTBEAT_BUDGET_MS = 45_000;
const COLLECTOR_TEST_TIMEOUT_MS = COLLECTOR_BUDGET_MS + 15_000;

/** What the renamed table makes the statement and the driver say. */
const STATEMENT = "INSERT INTO event_log";
const DRIVER_MESSAGE = "no such table";
const FIXED = "Database operation failed";
const CODE = "SQLITE_ERROR";

/** Holds a report to the rule: the fixed failure and its code, and nothing of the statement. */
function expectFixedFailure(reported: string): void {
  expect(reported).toContain(FIXED);
  expect(reported).toContain(CODE);
  expect(reported).not.toContain("event_log");
  expect(reported).not.toContain("VALUES (?");
  expect(reported).not.toContain(DRIVER_MESSAGE);
}

/** The server's own log, which its state directory holds. */
function serverLog(): string {
  const path = join(dirname(server!.sqlitePath), "server.log");
  return existsSync(path) ? readFileSync(path, "utf8") : "";
}

async function until<T>(
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

/** Every log record the collector has been sent, as its body and attributes. */
function sentLogRecords(): {
  body: unknown;
  attributes: Record<string, unknown>;
}[] {
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
}

/** Every span the collector has been sent, with its attributes and the attributes of each event. */
function sentSpans(): {
  attributes: Record<string, unknown>;
  events: { name: string; attributes: Record<string, unknown> }[];
}[] {
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
}

function postNote(marker: string, requestId: string): Promise<Response> {
  return fetch(`${server!.apiUrl}/items`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${server!.workingKey}`,
      "Content-Type": "application/json",
      "X-Request-ID": requestId,
    },
    body: JSON.stringify({
      type: "core.note",
      properties: { body: marker },
      tags: [marker],
    }),
  });
}

interface Fault {
  marker: string;
  requestId: string;
}

let fault: Promise<Fault> | undefined;

/**
 * One fault for the file: the webhook sends a given error once a minute, so
 * a second identical fault would not reach the receiver.
 */
function faulted(): Promise<Fault> {
  fault ??= (async () => {
    const marker = `marker-${Date.now().toString(36)}`;
    // The witness: with the table there the write lands, and the log row it
    // stores carries the properties and the tag, which are the values the
    // failing statement is bound to.
    const landed = await postNote(marker, "fault-reports-landed");
    expect(landed.status).toBe(201);
    const stored = withInstanceDatabase(server!.sqlitePath, (db) =>
      db
        .prepare("SELECT payload FROM event_log ORDER BY id DESC LIMIT 1")
        .get(),
    ) as { payload: string };
    expect(stored.payload).toContain(marker);

    const requestId = "fault-reports-faulted";
    withInstanceDatabase(server!.sqlitePath, (db) => {
      db.exec("ALTER TABLE event_log RENAME TO event_log_gone");
    });
    try {
      const refused = await postNote(marker, requestId);
      expect(refused.status).toBe(500);
    } finally {
      withInstanceDatabase(server!.sqlitePath, (db) => {
        db.exec("ALTER TABLE event_log_gone RENAME TO event_log");
      });
    }
    return { marker, requestId };
  })();
  return fault;
}

describe("an unhandled fault in which a statement failed", () => {
  it("is logged as a database failure with its SQLite code, and none of the statement, the driver's message or the values", async () => {
    const { marker, requestId } = await faulted();
    const line = await until("the fault's log line", () =>
      serverLog()
        .split("\n")
        .filter((text) => text.startsWith("{"))
        .map((text) => JSON.parse(text) as Record<string, unknown>)
        .find(
          (entry) =>
            entry.message === "Unhandled error" &&
            entry.request_id === requestId,
        ),
    );

    expect(line.level).toBe("error");
    expect(line.method).toBe("POST");
    expect(line.path).toBe("/items");
    expectFixedFailure(String(line.error));
    // Nowhere in the fault's line, whichever field carries it.
    expectFixedFailure(JSON.stringify(line));
    // Nowhere in the log.
    expect(serverLog()).not.toContain(marker);
    expect(serverLog()).not.toContain(STATEMENT);
    expect(serverLog()).not.toContain(DRIVER_MESSAGE);
  });

  it("is sent to the error webhook as a database failure with its SQLite code, and none of the statement, the driver's message or the values", async () => {
    const { marker, requestId } = await faulted();
    const sent = await until("the error webhook's notification", () =>
      notifications.find((entry) => entry.request_id === requestId),
    );

    expect(sent.method).toBe("POST");
    expect(sent.path).toBe("/items");
    expectFixedFailure(String(sent.error));
    expectFixedFailure(JSON.stringify(sent));
    expect(JSON.stringify(notifications)).not.toContain(marker);
    // One notification for the one fault.
    expect(
      notifications.filter((entry) => entry.request_id === requestId),
    ).toHaveLength(1);
  });

  it(
    "is carried by the log record sent to the telemetry collector as a database failure with its SQLite code, and none of the statement, the driver's message or the values",
    async () => {
      const { marker, requestId } = await faulted();
      const record = await until(
        "the fault's log record",
        () =>
          sentLogRecords().find(
            (entry) =>
              entry.body === "Unhandled error" &&
              entry.attributes.request_id === requestId,
          ),
        COLLECTOR_BUDGET_MS,
      );

      expectFixedFailure(String(record.attributes.error));
      expectFixedFailure(JSON.stringify(record));
      // Whichever attribute of whichever record carries it.
      expect(JSON.stringify(logRecords)).not.toContain(marker);
      expect(JSON.stringify(logRecords)).not.toContain(STATEMENT);
      expect(JSON.stringify(logRecords)).not.toContain(DRIVER_MESSAGE);
    },
    COLLECTOR_TEST_TIMEOUT_MS,
  );

  it(
    "is carried by the exception event on the request's span as a database failure with its SQLite code, and none of the statement, the driver's message or the values",
    async () => {
      const { marker, requestId } = await faulted();
      const span = await until(
        "the faulted request's span",
        () =>
          sentSpans().find(
            (entry) => entry.attributes["marfa.request_id"] === requestId,
          ),
        COLLECTOR_BUDGET_MS,
      );

      expect(span.attributes["http.response.status_code"]).toBe(500);
      expect(span.attributes["error.code"]).toBe("internal_error");
      const events = span.events.filter((event) => event.name === "exception");
      expect(events).toHaveLength(1);
      const exception = events[0]!.attributes;
      expectFixedFailure(String(exception["exception.message"]));
      expectFixedFailure(JSON.stringify(exception));
      expect(JSON.stringify(traces)).not.toContain(marker);
      expect(JSON.stringify(traces)).not.toContain(STATEMENT);
      expect(JSON.stringify(traces)).not.toContain(DRIVER_MESSAGE);
    },
    COLLECTOR_TEST_TIMEOUT_MS,
  );

  it(
    "is sent to error tracking as a database failure with its SQLite code, and none of the statement, the driver's message or the values",
    async () => {
      const { marker, requestId } = await faulted();
      type Event = {
        event: string;
        properties: {
          request_id?: string;
          method?: string;
          path?: string;
          $exception_list?: { type: string; value: string }[];
        };
      };
      const sent = await until(
        "the exception sent to error tracking",
        () =>
          (trackedErrors as unknown as { batch: Event[] }[])
            .flatMap((batch) => batch.batch)
            .find(
              (entry) =>
                entry.event === "$exception" &&
                entry.properties.request_id === requestId,
            ),
        COLLECTOR_BUDGET_MS,
      );

      expect(sent.properties.method).toBe("POST");
      expect(sent.properties.path).toBe("/items");
      const reported = (sent.properties.$exception_list ?? [])
        .map((entry) => entry.value)
        .join("\n");
      expectFixedFailure(reported);
      expect(
        (sent.properties.$exception_list ?? []).map((entry) => entry.type),
      ).toEqual(["DatabaseFailure"]);
      // Error tracking also carries the server's own source lines around each
      // frame, which hold its statements' text with no value in them.
      expect(JSON.stringify(trackedErrors)).not.toContain(marker);
      expect(JSON.stringify(trackedErrors)).not.toContain(DRIVER_MESSAGE);
    },
    COLLECTOR_TEST_TIMEOUT_MS,
  );
});

describe("a warning about an event stream that cannot be read", () => {
  function sql(text: string): void {
    withInstanceDatabase(server!.sqlitePath, (db) => {
      db.exec(text);
    });
  }

  /** The `[events]` warnings in the server's log. */
  function eventWarnings(): string[] {
    return serverLog()
      .split("\n")
      .filter((text) => text.startsWith("[events] closing the stream"));
  }

  function openStream(headers: Record<string, string> = {}): Promise<Response> {
    return fetch(`${server!.apiUrl}/events`, {
      headers: {
        Authorization: `Bearer ${server!.workingKey}`,
        Accept: "text/event-stream",
        ...headers,
      },
    });
  }

  /** What a stream sent until it ended, which a stream that failed does on its own. */
  async function readToEnd(
    reader: ReadableStreamDefaultReader<Uint8Array>,
  ): Promise<string> {
    const decoder = new TextDecoder();
    let text = "";
    for (;;) {
      const { value, done } = await reader.read();
      if (done) return text;
      text += decoder.decode(value);
    }
  }

  it(
    "names a database failure with its SQLite code and none of the statement or the credential's values, for the head of the log, a catch-up and the credential",
    async () => {
      // The witness: a stream is served while the log and the keys are there,
      // and says where it is.
      const served = await openStream();
      expect(served.status).toBe(200);
      const reader = served.body!.getReader();
      const first = await reader.read();
      expect(new TextDecoder().decode(first.value)).toContain(": connected");
      await reader.cancel();

      // The head of the log cannot be read.
      const known = new Set(eventWarnings());
      sql("ALTER TABLE event_log RENAME TO event_log_gone");
      let headStream: string;
      try {
        headStream = await readToEnd((await openStream()).body!.getReader());
      } finally {
        sql("ALTER TABLE event_log_gone RENAME TO event_log");
      }
      expect(headStream).not.toContain("stream_cursor");
      const head = await until("the head's warning", () =>
        eventWarnings().find((text) => !known.has(text)),
      );
      expect(head).toContain("the event-log head could not be read");
      expectFixedFailure(head);

      // A catch-up fails after the head was read. The log's sequence is moved
      // up so that the cursor is a number nothing else in the statement is,
      // and a view in place of the table answers the head and not the rows.
      sql("UPDATE sqlite_sequence SET seq = 7391850 WHERE name = 'event_log'");
      const created = await fetch(`${server!.apiUrl}/items`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${server!.workingKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          type: "core.note",
          properties: { body: "after the cursor" },
        }),
      });
      expect(created.status).toBe(201);
      sql(
        "ALTER TABLE event_log RENAME TO event_log_gone; CREATE VIEW event_log AS SELECT id, created_at FROM event_log_gone",
      );
      let catchUp: string;
      try {
        catchUp = await readToEnd(
          (await openStream({ "Last-Event-ID": "7391850" })).body!.getReader(),
        );
      } finally {
        sql(
          "DROP VIEW event_log; ALTER TABLE event_log_gone RENAME TO event_log",
        );
      }
      expect(catchUp).toContain('"reason":"replay_failed"');
      const replay = await until("the catch-up's warning", () =>
        eventWarnings().find((text) => text.includes("the catch-up could not")),
      );
      expectFixedFailure(replay);
      expect(replay).not.toContain("params");

      // The credential cannot be read again at the stream's next heartbeat.
      const current = await fetch(`${server!.apiUrl}/keys/current`, {
        headers: { Authorization: `Bearer ${server!.workingKey}` },
      });
      const { id: keyId } = (await current.json()) as { id: string };
      const live = await openStream();
      expect(live.status).toBe(200);
      const liveReader = live.body!.getReader();
      await liveReader.read();
      sql("ALTER TABLE api_keys RENAME TO api_keys_gone");
      let ended: string;
      try {
        ended = await readToEnd(liveReader);
      } finally {
        sql("ALTER TABLE api_keys_gone RENAME TO api_keys");
      }
      expect(ended).toContain('"reason":"live_delivery_failed"');
      const credential = await until(
        "the credential's warning",
        () =>
          eventWarnings().find((text) =>
            text.includes("the credential could not be read again"),
          ),
        HEARTBEAT_BUDGET_MS,
      );
      expectFixedFailure(credential);
      expect(credential).not.toContain("api_keys");
      expect(credential).not.toContain("params");
      expect(credential).not.toContain(keyId);
      expect(credential).not.toContain(server!.workingKey);
    },
    HEARTBEAT_BUDGET_MS + 30_000,
  );
});
