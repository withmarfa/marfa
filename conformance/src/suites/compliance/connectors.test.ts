import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import { MarfaClient } from "../../client/api.js";
import type { TestContext } from "../../client/types.js";
import {
  createTestContext,
  createSecondClient,
  cleanup,
  getOperatorClient,
  removeTrackedRegistrations,
} from "../../utils/setup.js";
import { expectMatchesSchema } from "../../utils/openapi.js";

let client: MarfaClient;
let ctx: TestContext;
let other: MarfaClient;

beforeAll(async () => {
  ({ ctx, client } = await createTestContext("compliance", "connectors"));
  other = await createSecondClient(ctx, "other-connector");
});

beforeEach(async () => {
  // A fixture that failed before it removed its registration would hand
  // the next one a `200` where it expects `201`: each starts from none.
  await removeTrackedRegistrations(ctx);
});

afterAll(async () => {
  // Revoking the keys leaves their registrations standing (statement 5);
  // `cleanup` removes them through the operator first.
  await cleanup(ctx);
});

const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

async function register(c: MarfaClient, name: string, description?: string) {
  const res = await c.registerConnector({ name, description });
  expect([200, 201]).toContain(res.status);
  return res;
}

describe("registration", () => {
  it("registers the key as a connector and lists it", async () => {
    const created = await client.registerConnector({
      name: `${ctx.runId} mail reader`,
      description: "reads a mailbox on a person's behalf",
    });
    expect(created.status).toBe(201);
    await expectMatchesSchema("POST", "/connectors", 201, created.data);
    expect(created.data.name).toBe(`${ctx.runId} mail reader`);
    expect(created.data.description).toBe(
      "reads a mailbox on a person's behalf",
    );
    expect(created.data.key_id).toBe(ctx.trackedKeys[0]);
    expect(created.data.source).toBe(ctx.source);
    expect(created.data.registered_at).toMatch(ISO);
    expect(created.data.updated_at).toBe(created.data.registered_at);
    expect(created.data.last_heartbeat_at).toBeNull();
    expect(created.data.last_run).toBeNull();
    expect(created.data.hold_expires_at).toBeNull();

    await new Promise((resolve) => setTimeout(resolve, 5));
    const theirs = await register(other, `${ctx.runId} calendar reader`);
    const listed = await other.listConnectors();
    expect(listed.status).toBe(200);
    await expectMatchesSchema("GET", "/connectors", 200, listed.data);
    const ids = listed.data.data.map((row) => row.id);
    expect(ids).toContain(created.data.id);
    // Newest first: the later registration is listed ahead of the earlier.
    expect(ids.indexOf(theirs.data.id)).toBeLessThan(
      ids.indexOf(created.data.id),
    );
    const one = await other.getConnector(created.data.id);
    expect(one.status).toBe(200);
    await expectMatchesSchema("GET", "/connectors/{id}", 200, one.data);
    expect(one.data).toEqual(created.data);

    expect((await client.deleteConnector(created.data.id)).status).toBe(200);
    expect((await other.deleteConnector(theirs.data.id)).status).toBe(200);
  });

  it("refuses a name or a description outside the bounds", async () => {
    const fine = await client.registerConnector({
      name: "n".repeat(200),
      description: "d".repeat(2000),
    });
    expect(fine.status).toBe(201);
    expect((await client.deleteConnector(fine.data.id)).status).toBe(200);
    for (const body of [
      { name: "" },
      { name: "n".repeat(201) },
      { name: `${ctx.runId} fine`, description: "d".repeat(2001) },
    ]) {
      const refused = await client.registerConnector(body);
      expect(refused.status, JSON.stringify(body).slice(0, 40)).toBe(400);
      expect(refused.error?.error.code).toBe("validation_error");
    }
    const listed = await client.listConnectors();
    expect(listed.data.data.map((row) => row.key_id)).not.toContain(
      ctx.trackedKeys[0],
    );
  });

  it("registers once per key, updating on repeat", async () => {
    const first = await client.registerConnector({ name: `${ctx.runId} v1` });
    expect(first.status).toBe(201);
    await new Promise((resolve) => setTimeout(resolve, 5));
    const again = await client.registerConnector({
      name: `${ctx.runId} v2`,
      description: "renamed",
    });
    expect(again.status).toBe(200);
    await expectMatchesSchema("POST", "/connectors", 200, again.data);
    expect(again.data.id).toBe(first.data.id);
    expect(again.data.name).toBe(`${ctx.runId} v2`);
    expect(again.data.description).toBe("renamed");
    expect(again.data.registered_at).toBe(first.data.registered_at);
    expect(Date.parse(again.data.updated_at)).toBeGreaterThan(
      Date.parse(first.data.updated_at),
    );
    const mine = (await client.listConnectors()).data.data.filter(
      (row) => row.key_id === ctx.trackedKeys[0],
    );
    expect(mine).toHaveLength(1);
    expect((await client.deleteConnector(first.data.id)).status).toBe(200);
  });

  it("answers 404 for an unknown connector, where a registered one answers", async () => {
    const real = await register(client, `${ctx.runId} real`);
    expect((await client.getConnector(real.data.id)).status).toBe(200);
    expect((await client.heartbeatConnector(real.data.id)).status).toBe(200);
    const at = new Date().toISOString();
    const run = {
      outcome: "succeeded" as const,
      started_at: at,
      finished_at: at,
    };
    expect((await client.reportConnectorRun(real.data.id, run)).status).toBe(
      201,
    );
    expect((await client.listConnectorRuns(real.data.id)).status).toBe(200);
    expect((await client.holdConnector(real.data.id, "p")).status).toBe(200);
    expect((await client.releaseConnectorHold(real.data.id, "p")).status).toBe(
      200,
    );
    expect((await client.getConnectorState(real.data.id)).status).toBe(200);
    expect((await client.listConnectorAgreements(real.data.id)).status).toBe(
      200,
    );
    expect(
      (await client.findConnectorAgreements(real.data.id, ["x"])).status,
    ).toBe(200);
    expect(
      (await client.writeConnectorAgreements(real.data.id, { process: "p" }))
        .status,
    ).toBe(200);
    expect(
      (
        await client.replaceConnectorState(real.data.id, {
          process: "p",
          state: {},
        })
      ).status,
    ).toBe(200);
    expect((await client.clearConnectorState(real.data.id)).status).toBe(200);

    const unknown = "01a0c000-0000-7000-8000-000000000000";
    for (const [door, res] of [
      ["GET /connectors/{id}", await client.getConnector(unknown)],
      [
        "POST /connectors/{id}/heartbeat",
        await client.heartbeatConnector(unknown),
      ],
      [
        "POST /connectors/{id}/runs",
        await client.reportConnectorRun(unknown, run),
      ],
      ["GET /connectors/{id}/runs", await client.listConnectorRuns(unknown)],
      ["POST /connectors/{id}/hold", await client.holdConnector(unknown, "p")],
      [
        "DELETE /connectors/{id}/hold",
        await client.releaseConnectorHold(unknown, "p"),
      ],
      ["GET /connectors/{id}/state", await client.getConnectorState(unknown)],
      [
        "PUT /connectors/{id}/state",
        await client.replaceConnectorState(unknown, {
          process: "p",
          state: {},
        }),
      ],
      [
        "DELETE /connectors/{id}/state",
        await client.clearConnectorState(unknown),
      ],
      [
        "POST /connectors/{id}/agreements",
        await client.writeConnectorAgreements(unknown, { process: "p" }),
      ],
      [
        "POST /connectors/{id}/agreements/find",
        await client.findConnectorAgreements(unknown, ["x"]),
      ],
      [
        "GET /connectors/{id}/agreements",
        await client.listConnectorAgreements(unknown),
      ],
      ["DELETE /connectors/{id}", await client.deleteConnector(unknown)],
    ] as const) {
      expect(res.status, door).toBe(404);
      expect(res.error?.error.code, door).toBe("connector_not_found");
    }
    expect((await client.deleteConnector(real.data.id)).status).toBe(200);
  });

  it("removes a registration for its own key or the operator, never another", async () => {
    const mine = await register(client, `${ctx.runId} mine`);
    const theirs = await other.deleteConnector(mine.data.id);
    expect(theirs.status).toBe(403);
    expect(theirs.error?.error.code).toBe("forbidden");
    expect((await client.getConnector(mine.data.id)).status).toBe(200);
    const operator = await getOperatorClient().deleteConnector(mine.data.id);
    expect(operator.status).toBe(200);
    expect((await client.getConnector(mine.data.id)).status).toBe(404);
    const again = await register(client, `${ctx.runId} mine again`);
    const own = await client.deleteConnector(again.data.id);
    expect(own.status).toBe(200);
    await expectMatchesSchema("DELETE", "/connectors/{id}", 200, own.data);
    expect(own.data).toEqual({ ok: true });
    expect((await client.getConnector(again.data.id)).status).toBe(404);
  });

  it("keeps a registration whose key was revoked, until the operator removes it", async () => {
    const shortLived = await createSecondClient(ctx, "short-lived");
    const mine = await shortLived.registerConnector({
      name: `${ctx.runId} short-lived reader`,
    });
    expect(mine.status).toBe(201);
    expect((await shortLived.heartbeatConnector(mine.data.id)).status).toBe(
      200,
    );

    const operator = getOperatorClient();
    expect((await operator.revokeKey(mine.data.key_id)).status).toBe(200);
    const refused = await shortLived.heartbeatConnector(mine.data.id);
    expect(refused.status).toBe(401);
    const standing = await client.getConnector(mine.data.id);
    expect(standing.status).toBe(200);
    expect(standing.data.key_id).toBe(mine.data.key_id);
    expect(standing.data.source).toBe(mine.data.source);
    expect(standing.data.last_heartbeat_at).toMatch(ISO);
    expect(
      (await client.listConnectors()).data.data.map((row) => row.id),
    ).toContain(mine.data.id);

    expect((await operator.deleteConnector(mine.data.id)).status).toBe(200);
    expect((await client.getConnector(mine.data.id)).status).toBe(404);
  });
});

describe("heartbeats and runs", () => {
  it("takes a heartbeat from the connector's key alone", async () => {
    const mine = await register(client, `${ctx.runId} beats`);
    for (const c of [other, getOperatorClient()]) {
      const refused = await c.heartbeatConnector(mine.data.id);
      expect(refused.status).toBe(403);
      expect(refused.error?.error.code).toBe("forbidden");
    }
    expect(
      (await client.getConnector(mine.data.id)).data.last_heartbeat_at,
    ).toBeNull();
    const beat = await client.heartbeatConnector(mine.data.id);
    expect(beat.status).toBe(200);
    await expectMatchesSchema(
      "POST",
      "/connectors/{id}/heartbeat",
      200,
      beat.data,
    );
    expect(beat.data.last_heartbeat_at).toMatch(ISO);
    // The server's clock: no later than now, no earlier than the
    // registration, and moved by the next beat.
    expect(Date.parse(beat.data.last_heartbeat_at)).toBeGreaterThanOrEqual(
      Date.parse(mine.data.registered_at),
    );
    expect(Date.parse(beat.data.last_heartbeat_at)).toBeLessThanOrEqual(
      Date.now() + 1_000,
    );
    expect(
      (await other.getConnector(mine.data.id)).data.last_heartbeat_at,
    ).toBe(beat.data.last_heartbeat_at);
    await new Promise((resolve) => setTimeout(resolve, 5));
    const again = await client.heartbeatConnector(mine.data.id);
    expect(again.status).toBe(200);
    expect(Date.parse(again.data.last_heartbeat_at)).toBeGreaterThan(
      Date.parse(beat.data.last_heartbeat_at),
    );
    expect((await client.deleteConnector(mine.data.id)).status).toBe(200);
  });

  it("records a run from the connector's key and refuses an outcome it does not know", async () => {
    const mine = await register(client, `${ctx.runId} runs`);
    const startedAt = new Date(Date.now() - 5_000).toISOString();
    const finishedAt = new Date().toISOString();
    const run = await client.reportConnectorRun(mine.data.id, {
      outcome: "succeeded",
      started_at: startedAt,
      finished_at: finishedAt,
      summary: "12 messages",
    });
    expect(run.status).toBe(201);
    await expectMatchesSchema("POST", "/connectors/{id}/runs", 201, run.data);
    expect(run.data).toMatchObject({
      connector_id: mine.data.id,
      outcome: "succeeded",
      started_at: startedAt,
      finished_at: finishedAt,
      summary: "12 messages",
      error: null,
    });
    const failed = await client.reportConnectorRun(mine.data.id, {
      outcome: "failed",
      started_at: startedAt,
      finished_at: finishedAt,
      error: "the mailbox refused the token",
    });
    expect(failed.status).toBe(201);
    await expectMatchesSchema(
      "POST",
      "/connectors/{id}/runs",
      201,
      failed.data,
    );
    expect(failed.data.summary).toBeNull();
    // An instant run, and a summary and an error at their caps, are fine.
    const capped = await client.reportConnectorRun(mine.data.id, {
      outcome: "succeeded",
      started_at: finishedAt,
      finished_at: finishedAt,
      summary: "s".repeat(2000),
      error: "e".repeat(2000),
    });
    expect(capped.status).toBe(201);
    const good = {
      outcome: "succeeded" as const,
      started_at: startedAt,
      finished_at: finishedAt,
    };
    for (const [what, body] of [
      [
        "an outcome it does not know",
        { ...good, outcome: "skipped" as "failed" },
      ],
      [
        "a finish before the start",
        { ...good, started_at: finishedAt, finished_at: startedAt },
      ],
      ["a start that is not a timestamp", { ...good, started_at: "yesterday" }],
      [
        "a finish that is not a timestamp",
        { ...good, finished_at: "tomorrow" },
      ],
      ["a summary over its cap", { ...good, summary: "s".repeat(2001) }],
      ["an error over its cap", { ...good, error: "e".repeat(2001) }],
    ] as const) {
      const refused = await client.reportConnectorRun(mine.data.id, body);
      expect(refused.status, what).toBe(400);
      expect(refused.error?.error.code, what).toBe("validation_error");
    }
    for (const c of [other, getOperatorClient()]) {
      const theirs = await c.reportConnectorRun(mine.data.id, good);
      expect(theirs.status).toBe(403);
      expect(theirs.error?.error.code).toBe("forbidden");
    }
    expect(
      (await client.listConnectorRuns(mine.data.id)).data.data,
    ).toHaveLength(3);
    expect((await client.deleteConnector(mine.data.id)).status).toBe(200);
  });

  it("lists runs newest first and names the last on the registration", async () => {
    const mine = await register(client, `${ctx.runId} ordered`);
    const at = (offset: number) => new Date(Date.now() - offset).toISOString();
    for (const [n, outcome] of [
      [3, "succeeded"],
      [2, "failed"],
      [1, "succeeded"],
    ] as const) {
      const res = await client.reportConnectorRun(mine.data.id, {
        outcome,
        started_at: at(n * 2_000),
        finished_at: at(n * 1_000),
        summary: `run ${String(n)}`,
      });
      expect(res.status).toBe(201);
    }
    // Reported last with the earliest start: newest by report, the report
    // stamped by the server's clock rather than by when the run says it
    // started.
    await new Promise((resolve) => setTimeout(resolve, 5));
    const late = await client.reportConnectorRun(mine.data.id, {
      outcome: "succeeded",
      started_at: at(90_000),
      finished_at: at(80_000),
      summary: "reported late",
    });
    expect(late.status).toBe(201);
    expect(late.data.reported_at).not.toBe(late.data.started_at);
    const runs = await other.listConnectorRuns(mine.data.id);
    expect(runs.status).toBe(200);
    await expectMatchesSchema("GET", "/connectors/{id}/runs", 200, runs.data);
    expect(runs.data.data.map((run) => run.summary)).toEqual([
      "reported late",
      "run 1",
      "run 2",
      "run 3",
    ]);
    expect(Date.parse(runs.data.data[0]?.reported_at ?? "")).toBeGreaterThan(
      Date.parse(runs.data.data[1]?.reported_at ?? ""),
    );
    const two = await other.listConnectorRuns(mine.data.id, { limit: 2 });
    expect(two.data.data.map((run) => run.summary)).toEqual([
      "reported late",
      "run 1",
    ]);
    // A page the limit cut says so, and its cursor reaches the rest.
    expect(two.data.next_cursor).not.toBeNull();
    const rest = await other.listConnectorRuns(mine.data.id, {
      limit: 2,
      cursor: two.data.next_cursor!,
    });
    expect(rest.data.data.map((run) => run.summary)).toEqual([
      "run 2",
      "run 3",
    ]);
    expect(rest.data.next_cursor).toBeNull();
    const listed = await other.getConnector(mine.data.id);
    expect(listed.data.last_run?.summary).toBe("reported late");
    expect(
      (await other.listConnectors()).data.data.find(
        (row) => row.id === mine.data.id,
      )?.last_run?.summary,
    ).toBe("reported late");

    // Each connector's runs are its own: another's listing and `last_run`
    // see none of these.
    const theirs = await register(other, `${ctx.runId} theirs`);
    const theirRun = await other.reportConnectorRun(theirs.data.id, {
      outcome: "failed",
      started_at: at(2_000),
      finished_at: at(1_000),
      summary: "their run",
    });
    expect(theirRun.status).toBe(201);
    expect(
      (await client.listConnectorRuns(theirs.data.id)).data.data.map(
        (run) => run.summary,
      ),
    ).toEqual(["their run"]);
    expect(
      (await client.listConnectorRuns(mine.data.id)).data.data.map(
        (run) => run.summary,
      ),
    ).toEqual(["reported late", "run 1", "run 2", "run 3"]);
    const rows = (await client.listConnectors()).data.data;
    expect(
      rows.find((row) => row.id === theirs.data.id)?.last_run?.summary,
    ).toBe("their run");
    expect(rows.find((row) => row.id === mine.data.id)?.last_run?.summary).toBe(
      "reported late",
    );
    expect((await other.deleteConnector(theirs.data.id)).status).toBe(200);
    expect((await client.deleteConnector(mine.data.id)).status).toBe(200);
  });

  it("refuses a query key the runs listing does not declare", async () => {
    const mine = await register(client, `${ctx.runId} unknown key`);
    const refused = await other.rawRequest<unknown>(
      `/connectors/${mine.data.id}/runs?outcome=failed`,
    );
    expect(refused.status).toBe(400);
    expect(refused.error?.error.code).toBe("validation_error");
    expect(refused.error?.error.details?.["unknown_parameters"]).toEqual([
      "outcome",
    ]);
    // Witness: the declared key is answered.
    expect(
      (await other.listConnectorRuns(mine.data.id, { limit: 1 })).status,
    ).toBe(200);
  });

  it("keeps the last hundred runs", async () => {
    const mine = await register(client, `${ctx.runId} hundred`);
    const at = new Date().toISOString();
    for (let i = 1; i <= 101; i++) {
      const res = await client.reportConnectorRun(mine.data.id, {
        outcome: "succeeded",
        started_at: at,
        finished_at: at,
        summary: `run ${String(i)}`,
      });
      expect(res.status).toBe(201);
    }
    const runs = await client.listConnectorRuns(mine.data.id, { limit: 200 });
    expect(runs.data.data).toHaveLength(100);
    const summaries = runs.data.data.map((run) => run.summary);
    expect(summaries).toContain("run 101");
    expect(summaries).toContain("run 2");
    expect(summaries).not.toContain("run 1");
    // The listing's bounds: 50 unless given, and nothing past 200.
    const unlimited = await client.listConnectorRuns(mine.data.id);
    expect(unlimited.status).toBe(200);
    expect(unlimited.data.data).toHaveLength(50);
    expect(unlimited.data.data[0]?.summary).toBe("run 101");
    const past = await client.listConnectorRuns(mine.data.id, { limit: 201 });
    expect(past.status).toBe(400);
    expect(past.error?.error.code).toBe("validation_error");
    expect(
      (await client.listConnectorRuns(mine.data.id, { limit: 0 })).status,
    ).toBe(400);
    expect((await client.deleteConnector(mine.data.id)).status).toBe(200);
  });

  it("audits every registration and a removal, not a heartbeat or a run", async () => {
    const mine = await register(client, `${ctx.runId} audited`);
    expect(mine.status).toBe(201);
    const again = await register(client, `${ctx.runId} audited, renamed`);
    expect(again.status).toBe(200);
    expect((await client.heartbeatConnector(mine.data.id)).status).toBe(200);
    const at = new Date().toISOString();
    const run = await client.reportConnectorRun(mine.data.id, {
      outcome: "succeeded",
      started_at: at,
      finished_at: at,
    });
    expect(run.status).toBe(201);
    expect((await client.deleteConnector(mine.data.id)).status).toBe(200);
    const rows = await client.listAudit({ resource_id: mine.data.id });
    expect(rows.status).toBe(200);
    const written = rows.data.data.map((row) => [
      row.action,
      row.details.name,
      row.details.created,
    ]);
    written.sort((a, b) => (JSON.stringify(a) < JSON.stringify(b) ? -1 : 1));
    expect(written).toEqual([
      ["connector.delete", `${ctx.runId} audited, renamed`, undefined],
      ["connector.register", `${ctx.runId} audited`, true],
      ["connector.register", `${ctx.runId} audited, renamed`, false],
    ]);
  });
});
