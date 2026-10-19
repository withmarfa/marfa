import { dirname } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  bootFreshServer,
  FRESH_SERVER_TIMEOUT_MS,
  type FreshServer,
  serverOutput,
} from "../../utils/fresh-server.js";
import {
  COLLECTOR_BUDGET_MS,
  COLLECTOR_TEST_TIMEOUT_MS,
  expectFixedFailure as expectFixed,
  startFaultSinks,
  until,
  type FaultSinks,
} from "../../utils/fault-sinks.js";
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
 * **Faults the target makes.** A fault met after a response began, or by
 * work no request waits on, has no arrangement in the stored file that does
 * not depend on timing, so those are set through the target's `fail` faults
 * and held in `fault-reports-detached.test.ts`.
 */
let server: FreshServer | undefined;
let sinks: FaultSinks | undefined;

beforeAll(async () => {
  sinks = await startFaultSinks();
  server = await bootFreshServer("fault-reports", sinks.env());
}, 2 * FRESH_SERVER_TIMEOUT_MS);

afterAll(async () => {
  await server?.stop();
  await sinks?.close();
}, 2 * FRESH_SERVER_TIMEOUT_MS);

/** A stream re-reads its credential every 30 seconds. */
const HEARTBEAT_BUDGET_MS = 45_000;

/** What the renamed table makes the statement and the driver say. */
const STATEMENT = "INSERT INTO event_log";
const DRIVER_MESSAGE = "no such table";
const CODE = "SQLITE_ERROR";

/** Holds a report to the rule: the fixed failure and its code, and nothing of the statement. */
function expectFixedFailure(reported: string): void {
  expectFixed(reported, CODE, ["event_log", "VALUES (?", DRIVER_MESSAGE]);
}

/** Everything the server logged, which its state directory holds. */
function serverLog(): string {
  return serverOutput(dirname(server!.sqlitePath));
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
      sinks!.notifications.find((entry) => entry.request_id === requestId),
    );

    expect(sent.method).toBe("POST");
    expect(sent.path).toBe("/items");
    expectFixedFailure(String(sent.error));
    expectFixedFailure(JSON.stringify(sent));
    expect(JSON.stringify(sinks!.notifications)).not.toContain(marker);
    // One notification for the one fault.
    expect(
      sinks!.notifications.filter((entry) => entry.request_id === requestId),
    ).toHaveLength(1);
  });

  it(
    "is carried by the log record sent to the telemetry collector as a database failure with its SQLite code, and none of the statement, the driver's message or the values",
    async () => {
      const { marker, requestId } = await faulted();
      const record = await until(
        "the fault's log record",
        () =>
          sinks!
            .sentLogRecords()
            .find(
              (entry) =>
                entry.body === "Unhandled error" &&
                entry.attributes.request_id === requestId,
            ),
        COLLECTOR_BUDGET_MS,
      );

      expectFixedFailure(String(record.attributes.error));
      expectFixedFailure(JSON.stringify(record));
      // Whichever attribute of whichever record carries it.
      expect(JSON.stringify(sinks!.logRecords)).not.toContain(marker);
      expect(JSON.stringify(sinks!.logRecords)).not.toContain(STATEMENT);
      expect(JSON.stringify(sinks!.logRecords)).not.toContain(DRIVER_MESSAGE);
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
          sinks!
            .sentSpans()
            .find(
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
      expect(JSON.stringify(sinks!.traces)).not.toContain(marker);
      expect(JSON.stringify(sinks!.traces)).not.toContain(STATEMENT);
      expect(JSON.stringify(sinks!.traces)).not.toContain(DRIVER_MESSAGE);
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
          (sinks!.trackedErrors as unknown as { batch: Event[] }[])
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
      expect(JSON.stringify(sinks!.trackedErrors)).not.toContain(marker);
      expect(JSON.stringify(sinks!.trackedErrors)).not.toContain(
        DRIVER_MESSAGE,
      );
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
