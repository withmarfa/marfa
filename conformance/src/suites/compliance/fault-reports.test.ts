import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  bootFreshServer,
  FRESH_SERVER_TIMEOUT_MS,
  type FreshServer,
} from "../../utils/fresh-server.js";
import {
  COLLECTOR_BUDGET_MS,
  COLLECTOR_TEST_TIMEOUT_MS,
  expectFixedFailure as expectFixed,
  startFaultSinks,
  until,
  type FaultSinks,
} from "../../utils/fault-sinks.js";

/**
 * What the server reports of an unhandled fault that failed a database
 * statement, in the places a fixture can read: its log, its error webhook,
 * the log record and the span's exception event it exports, and the
 * exception it sends to error tracking. Each carries `Database operation
 * failed` and the SQLite result code, and none of the statement, the driver's
 * own message or the values the write was given.
 *
 * **A fault the fixture makes, on a server of its own.** The target fails the
 * statement that stores a write's audit entry, as `internal-error.test.ts`
 * does, and the error webhook names a receiver the fixture runs. The failure
 * carries the statement and the values it was bound to, as a real one does,
 * so a report that held them back is the report's doing.
 *
 * **Where the telemetry goes.** The server exports its log record, its
 * spans and its exceptions over HTTP, so the receiver the fixture runs is
 * also the collector for all three: the OTLP endpoint takes the log records
 * and spans, and the PostHog host takes the exception sent to error tracking.
 *
 * **Faults met out of a request's reach.** A fault met after a response
 * began, or by work no request waits on, is held in
 * `fault-reports-detached.test.ts`.
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

/** What the failed statement and the driver would have put in a report. */
const STATEMENT = "Failed query";
const DRIVER_MESSAGE = "disk I/O error";
const CODE = "SQLITE_IOERR";

/** Holds a report to the rule: the fixed failure and its code, and nothing of the statement. */
function expectFixedFailure(reported: string): void {
  expectFixed(reported, CODE, [STATEMENT, "params", DRIVER_MESSAGE, keyId]);
}

/** Everything the server logged so far. */
function serverLog(): Promise<string> {
  return server!.output();
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
/** The key that wrote the fixture's notes, which the failed statement is bound to. */
let keyId = "";

/**
 * One fault for the file: the webhook sends a given error once a minute, so
 * a second identical fault would not reach the receiver.
 */
function faulted(): Promise<Fault> {
  fault ??= (async () => {
    const marker = `marker-${Date.now().toString(36)}`;
    // The witness: with no fault the write lands, and the entry it stores
    // names the key that wrote it, a value the failing statement is bound to.
    const landed = await postNote(marker, "fault-reports-landed");
    expect(landed.status).toBe(201);
    const { item } = (await landed.json()) as { item: { id: string } };
    const recorded = await fetch(
      `${server!.apiUrl}/audit?action=item.create&resource_id=${item.id}`,
      { headers: { Authorization: `Bearer ${server!.workingKey}` } },
    );
    const entries = ((await recorded.json()) as { data: { key_id: string }[] })
      .data;
    expect(entries).toHaveLength(1);
    keyId = entries[0]!.key_id;

    const requestId = "fault-reports-faulted";
    await server!.setFault("fail:audit=item.create");
    const refused = await postNote(marker, requestId);
    expect(refused.status).toBe(500);
    return { marker, requestId };
  })();
  return fault;
}

describe("an unhandled fault in which a statement failed", () => {
  it("is logged as a database failure with its SQLite code, and none of the statement, the driver's message or the values", async () => {
    const { marker, requestId } = await faulted();
    const line = await until("the fault's log line", async () =>
      (await serverLog())
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
    const log = await serverLog();
    expect(log).not.toContain(marker);
    expect(log).not.toContain(STATEMENT);
    expect(log).not.toContain(DRIVER_MESSAGE);
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

/** A stream re-reads its credential every 30 seconds. */
const HEARTBEAT_BUDGET_MS = 45_000;

describe("a warning about an event stream that cannot be read", () => {
  /** The warnings in the server's log, as its JSON lines. */
  async function warnings(): Promise<Record<string, unknown>[]> {
    return (await serverLog())
      .split("\n")
      .filter((text) => text.startsWith("{"))
      .map((text) => JSON.parse(text) as Record<string, unknown>)
      .filter((line) => line.level === "warn");
  }

  /** Waits for the warnings a fault adds, and holds each to the rule. */
  async function newWarnings(
    what: string,
    before: number,
    timeoutMs?: number,
  ): Promise<void> {
    const added = await until(
      what,
      async () => {
        const now = (await warnings())
          .slice(before)
          .map((line) => JSON.stringify(line));
        return now.some((text) => text.includes("Database operation failed"))
          ? now
          : undefined;
      },
      timeoutMs,
    );
    expectFixedFailure(
      added.find((text) => text.includes("Database operation failed"))!,
    );
    for (const text of added) {
      for (const forbidden of [STATEMENT, "params", DRIVER_MESSAGE, keyId]) {
        expect(text).not.toContain(forbidden);
      }
    }
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
      expect(new TextDecoder().decode(first.value)).toContain("stream_cursor");
      await reader.cancel();

      // The head of the log cannot be read.
      let before = (await warnings()).length;
      await server!.setFault("fail:stream-head");
      const headStream = await readToEnd(
        (await openStream()).body!.getReader(),
      );
      expect(headStream).not.toContain("stream_cursor");
      expect(headStream).toContain('"reason":"read_failed"');
      await newWarnings("the head's warning", before);

      // A catch-up fails after the head was read.
      before = (await warnings()).length;
      await server!.setFault("fail:stream-replay");
      const catchUp = await readToEnd(
        (await openStream({ "Last-Event-ID": "0" })).body!.getReader(),
      );
      expect(catchUp).toContain('"reason":"read_failed"');
      await newWarnings("the catch-up's warning", before);

      // The credential cannot be read again at the stream's next heartbeat.
      const current = await fetch(`${server!.apiUrl}/keys/current`, {
        headers: { Authorization: `Bearer ${server!.workingKey}` },
      });
      const { id: currentKey } = (await current.json()) as { id: string };
      const live = await openStream();
      expect(live.status).toBe(200);
      const liveReader = live.body!.getReader();
      await liveReader.read();
      before = (await warnings()).length;
      await server!.setFault("fail:stream-credential");
      const ended = await readToEnd(liveReader);
      expect(ended).toContain('"reason":"read_failed"');
      await newWarnings(
        "the credential's warning",
        before,
        HEARTBEAT_BUDGET_MS,
      );
      const credential = JSON.stringify((await warnings()).slice(before));
      expect(credential).not.toContain("api_keys");
      expect(credential).not.toContain(currentKey);
      expect(credential).not.toContain(server!.workingKey);
    },
    HEARTBEAT_BUDGET_MS + 30_000,
  );
});
