import { dirname } from "node:path";
import { connect } from "node:net";
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
  startFaultSinks,
  until,
  type FaultSinks,
} from "../../utils/fault-sinks.js";
import { withInstanceDatabase } from "../../utils/instance-database.js";

/**
 * A client that closes its connection while it is still sending a request
 * leaves nobody to answer, and the server did nothing wrong: it logs the
 * request, and reports no fault.
 *
 * **A server of its own, with the reports pointed at the fixture.** The
 * error webhook and error tracking name a receiver the fixture runs.
 *
 * **The witness.** An absence is only worth asserting where the thing is
 * producible. After the drop, the fixture makes a real fault on the same
 * server, as `internal-error.test.ts` does, and waits for the webhook and
 * error tracking to carry it; the drop's report, had there been one, was sent
 * before that.
 */
let server: FreshServer | undefined;
let sinks: FaultSinks | undefined;

beforeAll(async () => {
  sinks = await startFaultSinks();
  server = await bootFreshServer("client-closed-request", sinks.env());
}, 2 * FRESH_SERVER_TIMEOUT_MS);

afterAll(async () => {
  await server?.stop();
  await sinks?.close();
}, 2 * FRESH_SERVER_TIMEOUT_MS);

function serverLog(): Record<string, unknown>[] {
  return serverOutput(dirname(server!.sqlitePath))
    .split("\n")
    .filter((text) => text.startsWith("{"))
    .map((text) => JSON.parse(text) as Record<string, unknown>);
}

/**
 * Starts a `POST /blobs` that promises far more bytes than it sends, then
 * resets the connection, and settles once the connection is closed.
 */
function dropUpload(requestId: string): Promise<void> {
  const { hostname, port } = new URL(server!.apiUrl);
  return new Promise((resolve) => {
    const socket = connect(Number(port), hostname, () => {
      socket.write(
        `POST /blobs HTTP/1.1\r\nHost: ${hostname}\r\nConnection: close\r\n` +
          `Authorization: Bearer ${server!.workingKey}\r\nX-Request-ID: ${requestId}\r\n` +
          `Content-Type: application/octet-stream\r\nContent-Length: 100000\r\n\r\n`,
      );
      socket.write(Buffer.alloc(1000, 1), () => {
        socket.resetAndDestroy();
      });
    });
    socket.on("error", () => undefined);
    socket.on("close", () => {
      resolve();
    });
  });
}

function audit(requestId: string): Promise<Response> {
  return fetch(`${server!.apiUrl}/audit`, {
    headers: {
      Authorization: `Bearer ${server!.workingKey}`,
      "X-Request-ID": requestId,
    },
  });
}

describe("a request whose client closed the connection before the server answered", () => {
  it(
    "is not logged as an unhandled fault, sent to the error webhook or reported to error tracking",
    async () => {
      const dropped = "client-closed-request-dropped";
      await dropUpload(dropped);
      // The server has met the request: its own log line for it exists.
      await until("the dropped request's log line", () =>
        serverLog().find(
          (entry) => entry.request_id === dropped && entry.transport === "http",
        ),
      );

      // The witness: a real fault on the same server is reported on every
      // channel the drop's report would have used.
      const faulted = "client-closed-request-faulted";
      withInstanceDatabase(server!.sqlitePath, (db) => {
        db.exec("ALTER TABLE audit_log RENAME TO audit_log_gone");
      });
      try {
        expect((await audit(faulted)).status).toBe(500);
      } finally {
        withInstanceDatabase(server!.sqlitePath, (db) => {
          db.exec("ALTER TABLE audit_log_gone RENAME TO audit_log");
        });
      }
      await until("the fault's log line", () =>
        serverLog().find(
          (entry) =>
            entry.message === "Unhandled error" && entry.request_id === faulted,
        ),
      );
      await until("the fault's webhook notification", () =>
        sinks!.notifications.find((entry) => entry.request_id === faulted),
      );
      await until(
        "the fault's exception in error tracking",
        () =>
          sinks!
            .sentExceptions()
            .find((entry) => entry.properties.request_id === faulted),
        COLLECTOR_BUDGET_MS,
      );

      expect(
        serverLog().filter(
          (entry) =>
            entry.message === "Unhandled error" && entry.request_id === dropped,
        ),
      ).toEqual([]);
      expect(
        sinks!.notifications.filter((entry) => entry.request_id === dropped),
      ).toEqual([]);
      expect(
        sinks!
          .sentExceptions()
          .filter((entry) => entry.properties.request_id === dropped),
      ).toEqual([]);
    },
    COLLECTOR_TEST_TIMEOUT_MS,
  );
});
