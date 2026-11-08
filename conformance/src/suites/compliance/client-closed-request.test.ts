import { connect } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  bootFreshServer,
  FRESH_SERVER_TIMEOUT_MS,
  type FreshServer,
} from "../../utils/fresh-server.js";
import {
  COLLECTOR_BUDGET_MS,
  COLLECTOR_TEST_TIMEOUT_MS,
  startFaultSinks,
  until,
  type FaultSinks,
} from "../../utils/fault-sinks.js";

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

async function serverLog(): Promise<Record<string, unknown>[]> {
  return (await server!.output())
    .split("\n")
    .filter((text) => text.startsWith("{"))
    .map((text) => JSON.parse(text) as Record<string, unknown>);
}

/**
 * Starts a `POST /items` that promises far more bytes than it sends, holds the
 * connection open for `holdMs` after the send, then resets it, and settles
 * once the connection is closed.
 */
function dropUpload(requestId: string, holdMs: number): Promise<void> {
  const { hostname, port } = new URL(server!.apiUrl);
  return new Promise((resolve) => {
    const socket = connect(Number(port), hostname, () => {
      socket.write(
        `POST /items HTTP/1.1\r\nHost: ${hostname}\r\nConnection: close\r\n` +
          `Authorization: Bearer ${server!.workingKey}\r\nX-Request-ID: ${requestId}\r\n` +
          `Content-Type: application/json\r\nContent-Length: 100000\r\n\r\n`,
      );
      socket.write(Buffer.alloc(1000, 1), () => {
        setTimeout(() => socket.resetAndDestroy(), holdMs);
      });
    });
    socket.on("error", () => undefined);
    socket.on("close", () => {
      resolve();
    });
  });
}

/**
 * Drops uploads until the server shows one it met while reading the body: a
 * reset that lands before the server has parsed the request leaves no log
 * line, so the hold before the reset grows with each attempt. Settles on the
 * ids of every attempt, the last of which is the one the server logged.
 */
async function dropUntilLogged(base: string): Promise<string[]> {
  const attempts: string[] = [];
  for (let attempt = 0; attempt < 12; attempt++) {
    const id = `${base}-${attempt}`;
    attempts.push(id);
    await dropUpload(id, attempt * 150);
    const deadline = Date.now() + 2_000;
    while (Date.now() < deadline) {
      if (await logLine(id)) return attempts;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  throw new Error("the server never logged a dropped upload");
}

async function logLine(
  requestId: string,
): Promise<Record<string, unknown> | undefined> {
  return (await serverLog()).find(
    (entry) => entry.request_id === requestId && entry.transport === "http",
  );
}

function create(requestId: string): Promise<Response> {
  return fetch(`${server!.apiUrl}/items`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${server!.workingKey}`,
      "Content-Type": "application/json",
      "X-Request-ID": requestId,
    },
    body: JSON.stringify({
      type: "core.note",
      properties: { body: "faulted" },
    }),
  });
}

describe("a request whose client closed the connection before the server answered", () => {
  it(
    "is not logged as an unhandled fault, sent to the error webhook or reported to error tracking",
    async () => {
      const attempts = await dropUntilLogged("client-closed-request-dropped");
      const dropped = new Set(attempts);
      // The drop took the abort path: the server logged it as one the client left.
      expect((await logLine(attempts[attempts.length - 1]!))?.status).toBe(499);

      // The witness: a real fault on the same server is reported on every
      // channel the drop's report would have used.
      const faulted = "client-closed-request-faulted";
      await server!.setFault("fail:audit=item.create");
      try {
        expect((await create(faulted)).status).toBe(500);
      } finally {
        await server!.clearFault("fail:audit");
      }
      await until("the fault's log line", async () =>
        (await serverLog()).find(
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
        (await serverLog()).filter(
          (entry) =>
            entry.message === "Unhandled error" &&
            dropped.has(entry.request_id as string),
        ),
      ).toEqual([]);
      expect(
        sinks!.notifications.filter((entry) =>
          dropped.has(entry.request_id as string),
        ),
      ).toEqual([]);
      expect(
        sinks!
          .sentExceptions()
          .filter((entry) =>
            dropped.has(entry.properties.request_id as string),
          ),
      ).toEqual([]);
    },
    COLLECTOR_TEST_TIMEOUT_MS,
  );
});
