import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MarfaClient } from "../../client/api.js";
import {
  COLLECTOR_BUDGET_MS,
  COLLECTOR_TEST_TIMEOUT_MS,
  expectFixedFailure,
  startFaultSinks,
  until,
  type FaultSinks,
} from "../../utils/fault-sinks.js";
import {
  bootFreshServer,
  FRESH_SERVER_TIMEOUT_MS,
  type FreshServer,
  serverOutput,
} from "../../utils/fresh-server.js";
import { idOf, send } from "../../utils/inbound-sender.js";
import { DAY_MS, quiet } from "../../utils/moved-clock.js";

/**
 * What the server does when storing an inbound receipt, or removing what is
 * past its retention, fails in the database. The target fails the statement
 * through its `fail:inbound-receipt` and `fail:inbound-cleanup` faults
 * (`conformance/README.md`, "Faults"), so the failure is a statement's own,
 * with the receipt's content among the values it was bound to.
 */
let server: FreshServer;
let sinks: FaultSinks;
let serial = 0;

beforeAll(async () => {
  sinks = await startFaultSinks();
  server = await bootFreshServer("inbound-faults", {
    ...sinks.env(),
    // Far enough off that no pass but the ones this file asks for runs.
    MARFA_INBOUND_CLEANUP_INTERVAL_MS: "3153600000000",
  });
  // The scheduler makes the job's first run itself some seconds after the
  // boot, and the clock moved below would make it due again. Waiting for it
  // here puts the job's next run an interval away.
  await quiet(server, ["inbound-delivery-cleanup"]);
}, 2 * FRESH_SERVER_TIMEOUT_MS);

afterAll(async () => {
  await server.stop();
  await sinks.close();
}, 2 * FRESH_SERVER_TIMEOUT_MS);

function operator(): MarfaClient {
  return new MarfaClient({
    baseUrl: server.apiUrl,
    apiKey: server.managementKey,
  });
}

/** A value no other text in a report could be. */
const sentinel = (kind: string) => `${kind}-${randomBytes(9).toString("hex")}`;

/** A registration and an address of its own. */
async function endpoint() {
  serial += 1;
  const label = `inbound-faults-${String(serial)}`;
  const minted = await new MarfaClient({
    baseUrl: server.apiUrl,
    apiKey: server.workingKey,
  }).createKey({ label, source: label, default_tier: "library" });
  expect(minted.status).toBe(201);
  const client = new MarfaClient({
    baseUrl: server.apiUrl,
    apiKey: minted.data.key,
  });
  const registered = await client.registerConnector({ name: label });
  expect(registered.status).toBe(201);
  const made = await client.createInboundEndpoint(registered.data.id);
  expect(made.status).toBe(201);
  return { client, id: registered.data.id, path: made.data.path };
}

const firedCount = async (name: string) =>
  (await server.faults()).find((fault) => fault.name === name)?.fired;

describe("a run of inbound-delivery-cleanup that fails while it removes deliveries", () => {
  it("keeps every delivery it was removing, with its body, and removes them on the run after", async () => {
    const { client, id, path } = await endpoint();
    const bodies = [sentinel("one"), sentinel("two"), sentinel("three")];
    const delivered = await Promise.all(
      bodies.map(async (body) => idOf(await send(server.apiUrl, path, body))),
    );
    const handled = await client.markInboundDeliveriesHandled(id, {
      ids: delivered,
      outcome: "processed",
    });
    expect(handled.status).toBe(200);
    // Past the seven days a handled delivery is kept.
    await server.advanceClock(8 * DAY_MS);

    const kept = async () => {
      const listed = await client.listInboundDeliveries(id, {
        state: "any",
        limit: 200,
      });
      expect(listed.status).toBe(200);
      const found: Record<string, string | undefined> = {};
      for (const row of listed.data.data) {
        const body = await client.getInboundDeliveryBody(id, row.id);
        found[row.id] = body.status === 200 ? await body.text() : undefined;
      }
      return found;
    };
    expect(await kept()).toEqual(
      Object.fromEntries(delivered.map((d, i) => [d, bodies[i]])),
    );

    await server.setFault("fail:inbound-cleanup");
    const failed = await operator().runHousekeeping("inbound-delivery-cleanup");
    // The witness that the fault ended the run after it chose what to remove.
    expect(await firedCount("fail:inbound-cleanup")).toBe(1);
    expect(failed.status).toBe(200);
    expect(failed.data.outcome).toBe("error");
    expect(await kept()).toEqual(
      Object.fromEntries(delivered.map((d, i) => [d, bodies[i]])),
    );

    // The witness that the run removes them when it does not fail.
    const removed = await operator().runHousekeeping(
      "inbound-delivery-cleanup",
    );
    expect(removed.data.outcome).toBe("ok");
    expect(removed.data.result).toMatchObject({ deleted: 3 });
    expect(await kept()).toEqual({});
  });
});

describe("a receipt whose storing fails on a database fault", () => {
  /**
   * A receipt is stored by two statements, its metadata and then its body,
   * and `reach` names the one that fails.
   */
  async function receiptFails(
    which: "metadata" | "body",
    reach: "1" | "2",
  ): Promise<void> {
    const { client, id, path } = await endpoint();
    const content = {
      query: sentinel("query"),
      header: sentinel("header"),
      body: sentinel("body"),
    };
    const token = path.split("/").at(-1)!;
    const requestId = sentinel(`receipt-${which}`);
    const headers = ["X-Sentinel", content.header, "X-Request-ID", requestId];
    const to = `${path}?q=${content.query}`;

    // The witness: with no fault the same receipt is stored with its
    // headers, its query and its body, which are the values the statements
    // it is stored with are bound to.
    const landed = idOf(
      await send(server.apiUrl, to, content.body, [
        "X-Sentinel",
        content.header,
      ]),
    );
    const row = (
      await client.listInboundDeliveries(id, { state: "any", limit: 200 })
    ).data.data.find((candidate) => candidate.id === landed);
    expect(JSON.stringify(row)).toContain(content.header);
    expect(JSON.stringify(row)).toContain(content.query);
    expect(await (await client.getInboundDeliveryBody(id, landed)).text()).toBe(
      content.body,
    );

    await server.setFault(`fail:inbound-receipt=${reach}`);
    const refused = await send(server.apiUrl, to, content.body, headers);
    expect(refused.status).toBe(500);
    expect(await firedCount("fail:inbound-receipt")).toBe(1);
    const listed = await client.listInboundDeliveries(id, {
      state: "any",
      limit: 200,
    });
    // Only the receipt that landed; the refused one stored nothing.
    expect(listed.data.data.map((candidate) => candidate.id)).toEqual([landed]);

    const secrets = [content.query, content.header, content.body, token];
    const holdsNone = (text: string) => {
      for (const secret of secrets) expect(text).not.toContain(secret);
      for (const statement of ["Failed query", "params", "disk I/O error"])
        expect(text).not.toContain(statement);
    };
    const forbidden = ["Failed query", "params", "disk I/O error"];

    const log = await until("the fault's log line", () =>
      serverOutput(server.stateDir)
        .split("\n")
        .filter((text) => text.startsWith("{"))
        .map((text) => JSON.parse(text) as Record<string, unknown>)
        .find(
          (entry) =>
            entry.message === "Unhandled error" &&
            entry.request_id === requestId,
        ),
    );
    expectFixedFailure(JSON.stringify(log), "SQLITE_IOERR", forbidden);
    holdsNone(serverOutput(server.stateDir));

    const sent = await until("the error webhook's notification", () =>
      sinks.notifications.find((entry) => entry.request_id === requestId),
    );
    expectFixedFailure(JSON.stringify(sent), "SQLITE_IOERR", forbidden);
    holdsNone(JSON.stringify(sinks.notifications));

    const record = await until(
      "the fault's telemetry log record",
      () =>
        sinks
          .sentLogRecords()
          .find(
            (entry) =>
              entry.body === "Unhandled error" &&
              entry.attributes.request_id === requestId,
          ),
      COLLECTOR_BUDGET_MS,
    );
    expectFixedFailure(JSON.stringify(record), "SQLITE_IOERR", forbidden);
    holdsNone(JSON.stringify(sinks.logRecords));

    const span = await until(
      "the faulted request's span",
      () =>
        sinks
          .sentSpans()
          .find((entry) => entry.attributes["marfa.request_id"] === requestId),
      COLLECTOR_BUDGET_MS,
    );
    const exception = span.events.find((event) => event.name === "exception");
    expectFixedFailure(
      JSON.stringify(exception?.attributes),
      "SQLITE_IOERR",
      forbidden,
    );
    holdsNone(JSON.stringify(sinks.traces));

    const tracked = await until(
      "the exception sent to error tracking",
      () =>
        sinks
          .sentExceptions()
          .find((entry) => entry.properties.request_id === requestId),
      COLLECTOR_BUDGET_MS,
    );
    expectFixedFailure(
      (tracked.properties.$exception_list ?? [])
        .map((entry) => entry.value)
        .join("\n"),
      "SQLITE_IOERR",
      forbidden,
    );
    holdsNone(JSON.stringify(sinks.trackedErrors));
  }

  it(
    "keeps the address, headers, query and body out of every report when the statement storing its metadata fails",
    () => receiptFails("metadata", "1"),
    COLLECTOR_TEST_TIMEOUT_MS,
  );

  it(
    "keeps the address, headers, query and body out of every report when the statement storing its body fails",
    () => receiptFails("body", "2"),
    COLLECTOR_TEST_TIMEOUT_MS,
  );
});
