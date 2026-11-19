import { afterAll, beforeAll, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import {
  bootFreshServer,
  FRESH_SERVER_TIMEOUT_MS,
  type FreshServer,
} from "../../utils/fresh-server.js";
import { controlRequest } from "../../utils/control-request.js";
import {
  COLLECTOR_BUDGET_MS,
  COLLECTOR_TEST_TIMEOUT_MS,
  startFaultSinks,
  until,
  type FaultSinks,
} from "../../utils/fault-sinks.js";

/**
 * A connector whose run failed is an attention entry, and where error
 * tracking is on, one report of type `ConnectorRunFailed` that names nothing
 * of the connector. A connector that reports problems or has gone quiet is an
 * entry of the same kind and sends no report. The PostHog host is a receiver
 * the fixture runs, on a server of its own.
 */
let server: FreshServer;
let sinks: FaultSinks;

const DAY_MS = 86_400_000;

beforeAll(async () => {
  sinks = await startFaultSinks();
  server = await bootFreshServer("connector-fault-reports", sinks.env());
}, 2 * FRESH_SERVER_TIMEOUT_MS);

afterAll(async () => {
  await server.stop();
  await sinks.close();
}, 2 * FRESH_SERVER_TIMEOUT_MS);

/** A key registered as a connector under `name`. */
async function connector(name: string): Promise<{ id: string; key: string }> {
  const minted = await controlRequest(server.controlSocket, "/keys", {
    method: "POST",
    body: {
      label: "connector",
      source: `connector-${randomUUID()}`,
      type_permissions: { "core.note": "read" },
    },
  });
  expect(minted.status, JSON.stringify(minted.body)).toBe(201);
  const key = (minted.body as { key: string }).key;
  const registered = await call(key, "/connectors", "POST", { name });
  expect(registered.status).toBe(201);
  const { id } = (await registered.json()) as { id: string };
  return { id, key };
}

function call(
  key: string,
  path: string,
  method: string,
  body: unknown,
): Promise<Response> {
  return fetch(`${server.apiUrl}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${key}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
}

async function listed(id: string): Promise<void> {
  const answer = await controlRequest(server.controlSocket, "/attention");
  expect(answer.status).toBe(200);
  const entries = (
    answer.body as { data: { kind: string; reference: string }[] }
  ).data;
  expect(entries).toContainEqual(
    expect.objectContaining({ kind: "connector", reference: id }),
  );
}

const connectorReports = () =>
  sinks
    .sentExceptions()
    .filter(
      (event) =>
        event.properties.$exception_list?.[0]?.type === "ConnectorRunFailed",
    );

it(
  "sends one ConnectorRunFailed report for a connector's failed run, naming nothing of it, and none for problems or silence",
  async () => {
    const troubled = await connector(`Troubled ${randomUUID()}`);
    const put = await call(
      troubled.key,
      `/connectors/${troubled.id}/state`,
      "PUT",
      {
        process: "p",
        state: {},
        problems: { "feed/remote": "Unavailable" },
      },
    );
    expect(put.status).toBe(200);
    await listed(troubled.id);

    const quiet = await connector(`Quiet ${randomUUID()}`);
    await server.advanceClock(DAY_MS + 60_000);
    await listed(quiet.id);

    const name = `Failing ${randomUUID()}`;
    const failing = await connector(name);
    const at = new Date(Date.now() + server.clockOffsetMs).toISOString();
    const run = await call(
      failing.key,
      `/connectors/${failing.id}/runs`,
      "POST",
      {
        outcome: "failed",
        started_at: at,
        finished_at: at,
        summary: "summary-that-stays-home",
        error: "error-that-stays-home",
      },
    );
    expect(run.status).toBe(201);
    await listed(failing.id);

    const report = await until(
      "the ConnectorRunFailed report",
      () => connectorReports()[0],
      COLLECTOR_BUDGET_MS,
    );
    // The entries for problems and silence were announced first, so a report
    // of either would have come before this one.
    expect(connectorReports()).toHaveLength(1);
    expect(report.properties.$exception_list?.[0]?.value).toBe(
      "A connector reported that its last run failed.",
    );
    for (const field of ["request_id", "method", "path", "error_code"]) {
      expect(report.properties[field], field).toBeUndefined();
    }
    const sent = JSON.stringify(report);
    for (const absent of [
      failing.id,
      name,
      "error-that-stays-home",
      "summary-that-stays-home",
      troubled.id,
      quiet.id,
    ]) {
      expect(sent).not.toContain(absent);
    }
  },
  COLLECTOR_TEST_TIMEOUT_MS,
);
