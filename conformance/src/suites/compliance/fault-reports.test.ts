import { existsSync, readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { dirname, join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  bootFreshServer,
  FRESH_SERVER_TIMEOUT_MS,
  type FreshServer,
} from "../../utils/fresh-server.js";
import { withInstanceDatabase } from "../../utils/instance-database.js";

/**
 * What the server reports of an unhandled fault that failed a database
 * statement, in the two places a fixture can read: its log and its error
 * webhook. Each carries the failed statement, with placeholders where the
 * values were, and the driver's own reason, and none of the values the write
 * was given.
 *
 * **A fault the fixture makes, on a server of its own.** A table the write
 * reaches is renamed in the stored file, as `internal-error.test.ts` does,
 * and the error webhook names a receiver the fixture runs.
 *
 * **What a fixture cannot reach.** The telemetry record of the log line, the
 * exception sent to error tracking and the exception event on the request's
 * span each need a collector this fixture does not run; a fault met by a
 * background job or after a response began has no arrangement that does not
 * depend on timing; and the driver's reasons a request can produce quote no
 * value of the write, so the withholding of a reason that does is not
 * reachable over HTTP. The server's own suite holds those.
 */
let server: FreshServer | undefined;
let receiver: Server | undefined;

/** What the receiver has been sent, parsed. */
const notifications: Record<string, unknown>[] = [];

beforeAll(async () => {
  receiver = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      try {
        notifications.push(
          JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<
            string,
            unknown
          >,
        );
      } finally {
        response.writeHead(204).end();
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
  it("is logged with the statement and the driver's reason, and none of the values the statement was bound to", async () => {
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
    const reported = String(line.error);
    // The statement, with a placeholder where each value was.
    expect(reported).toContain("INSERT INTO event_log");
    expect(reported).toContain("VALUES (?, ?, ?, ?, ?, ?)");
    // The driver's own reason.
    expect(reported).toContain("no such table: event_log");
    // Nowhere in the log, whichever field carries it.
    expect(serverLog()).not.toContain(marker);
  });

  it("is sent to the error webhook with the statement and the driver's reason, and none of the values the statement was bound to", async () => {
    const { marker, requestId } = await faulted();
    const sent = await until("the error webhook's notification", () =>
      notifications.find((entry) => entry.request_id === requestId),
    );

    expect(sent.method).toBe("POST");
    expect(sent.path).toBe("/items");
    const reported = String(sent.error);
    expect(reported).toContain("INSERT INTO event_log");
    expect(reported).toContain("VALUES (?, ?, ?, ?, ?, ?)");
    expect(reported).toContain("no such table: event_log");
    expect(JSON.stringify(notifications)).not.toContain(marker);
    // One notification for the one fault.
    expect(
      notifications.filter((entry) => entry.request_id === requestId),
    ).toHaveLength(1);
  });
});
