import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  bootFreshServer,
  FRESH_SERVER_TIMEOUT_MS,
  type FreshServer,
  serverOutput,
} from "../../utils/fresh-server.js";
import { expectFixedFailure, until } from "../../utils/fault-sinks.js";
import { movedClock, DAY_MS } from "../../utils/moved-clock.js";

/**
 * What the server logs of a fault that failed a database statement where no
 * answer can carry it: after a response began, and in work no request waits
 * on. Each carries `Database operation failed` and the SQLite result code,
 * and none of the statement, the driver's own message or the values the
 * statement was bound to.
 *
 * `fault-reports.test.ts` holds the faults that end a request with a `500`.
 * These two have no arrangement in the stored file that does not depend on
 * timing, so the target fails them: `fail:export-read` fails a page of an
 * export's read once its response has begun, and `fail:housekeeping:<job>`
 * fails the first statement of a run the scheduler started on its own.
 *
 * **The witness for what is absent.** The failed statement is the real one,
 * so the query layer's message for it carries the statement's text and the
 * values it was bound to; the server's own suite holds that
 * (`storage/write-faults.test.ts`). The fixture binds a value no other text
 * holds, and shows below that the same request, with no fault, is logged
 * without it, so its absence from the fault's report is the report's doing.
 */
let server: FreshServer | undefined;

beforeAll(async () => {
  server = await bootFreshServer("fault-reports-detached");
}, 2 * FRESH_SERVER_TIMEOUT_MS);

afterAll(async () => {
  await server?.stop();
}, 2 * FRESH_SERVER_TIMEOUT_MS);

const CODE = "SQLITE_IOERR";
/** What the failed statement and the driver would have put in a report. */
const FORBIDDEN = ["Failed query", "params", "disk I/O error"];

function serverLog(): string {
  return serverOutput(server!.stateDir);
}

/** The log's JSON lines. */
function logged(): Record<string, unknown>[] {
  return serverLog()
    .split("\n")
    .filter((text) => text.startsWith("{"))
    .map((text) => JSON.parse(text) as Record<string, unknown>);
}

describe("a fault that ends a response body after the response began", () => {
  it("logs a database failure after the response began with its SQLite code, and none of the statement, the driver's message or the values", async () => {
    // A filter value that only the statement holds: it is bound to the read.
    const sentinel = `source-${randomBytes(9).toString("hex")}`;
    const exportOf = () =>
      fetch(`${server!.apiUrl}/export?source=${sentinel}`, {
        headers: { Authorization: `Bearer ${server!.workingKey}` },
      });

    // The witness: with no fault the export is served whole and its log says
    // nothing of a failure.
    const served = await exportOf();
    expect(served.status).toBe(200);
    await served.text();
    expect(
      logged().some((line) => line.message === "Export stream failed"),
    ).toBe(false);

    await server!.setFault("fail:export-read");
    const response = await exportOf();
    // The response has begun: its status is out, and the failure ends the body.
    expect(response.status).toBe(200);
    await expect(response.text()).rejects.toThrow();
    const acted = (await server!.faults()).find(
      (fault) => fault.name === "fail:export-read",
    );
    expect(acted?.fired).toBe(1);

    const line = await until("the export's log line", () =>
      logged().find((entry) => entry.message === "Export stream failed"),
    );
    expect(line.level).toBe("error");
    expectFixedFailure(String(line.error), CODE, FORBIDDEN);
    expectFixedFailure(JSON.stringify(line), CODE, FORBIDDEN);
    expect(serverLog()).not.toContain(sentinel);
    for (const text of FORBIDDEN) expect(serverLog()).not.toContain(text);
  });
});

describe("a fault in work no request waits on", () => {
  it("logs a database failure in a scheduled run with its SQLite code, and none of the statement, the driver's message or the values", async () => {
    const job = "trash-purge";
    await server!.setFault(`fail:housekeeping:${job}`);
    // The job is due once the clock passes its first run, and the scheduler
    // starts it on its own poll: no request asks for the run or waits on it.
    await movedClock(server!).advance(DAY_MS);
    const line = await until(
      `the ${job} run's log line`,
      () =>
        logged().find((entry) => entry.message === `Housekeeping ${job} error`),
      30_000,
    );
    const acted = (await server!.faults()).find(
      (fault) => fault.name === `fail:housekeeping:${job}`,
    );
    expect(acted?.fired).toBe(1);

    expect(line.level).toBe("error");
    expectFixedFailure(String(line.error), CODE, FORBIDDEN);
    expectFixedFailure(JSON.stringify(line), CODE, FORBIDDEN);
    for (const text of FORBIDDEN) expect(serverLog()).not.toContain(text);
  });
});
