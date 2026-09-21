import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { createTestContext, request } from "../test-utils.js";
import type { TestContext } from "../test-utils.js";
import type { Connector, ConnectorRun } from "../storage/interface.js";
import { RUNS_KEPT_PER_CONNECTOR } from "../storage/sqlite/connector-store.js";

let ctx: TestContext;
/** A second working key, for the doors that answer the connector's own
 *  key alone. */
let otherKey: string;

beforeAll(async () => {
  ctx = await createTestContext();
  const minted = await request(ctx.app, "POST", "/keys", {
    key: ctx.workingKey,
    body: { label: "another process", source: "another-process" },
  });
  expect(minted.status).toBe(201);
  otherKey = ((await minted.json()) as { key: string }).key;
});

afterAll(async () => {
  await ctx.cleanup();
});

async function json<T>(res: Response): Promise<T> {
  return (await res.json()) as T;
}

async function register(
  key: string,
  name: string,
  description?: string,
): Promise<{ status: number; connector: Connector }> {
  const res = await request(ctx.app, "POST", "/connectors", {
    key,
    body: { name, ...(description === undefined ? {} : { description }) },
  });
  return { status: res.status, connector: await json<Connector>(res) };
}

async function remove(key: string, id: string): Promise<number> {
  return (await request(ctx.app, "DELETE", `/connectors/${id}`, { key }))
    .status;
}

const at = (offsetMs: number) => new Date(Date.now() - offsetMs).toISOString();

describe("POST /connectors", () => {
  it("registers the caller's key once, and updates on a repeat", async () => {
    const first = await register(
      ctx.workingKey,
      "mail reader",
      "reads a mailbox",
    );
    expect(first.status).toBe(201);
    expect(first.connector).toMatchObject({
      name: "mail reader",
      description: "reads a mailbox",
      last_heartbeat_at: null,
      last_run: null,
    });
    expect(first.connector.registered_at).toBe(first.connector.updated_at);

    await new Promise((resolve) => setTimeout(resolve, 5));
    const again = await register(ctx.workingKey, "mail reader v2");
    expect(again.status).toBe(200);
    expect(again.connector.id).toBe(first.connector.id);
    expect(again.connector.name).toBe("mail reader v2");
    expect(again.connector.description).toBeNull();
    expect(again.connector.registered_at).toBe(first.connector.registered_at);
    expect(again.connector.updated_at > first.connector.updated_at).toBe(true);

    // One row per key: a second key registers a second connector.
    const theirs = await register(otherKey, "calendar reader");
    expect(theirs.status).toBe(201);
    expect(theirs.connector.id).not.toBe(first.connector.id);
    const listed = await json<{ data: Connector[] }>(
      await request(ctx.app, "GET", "/connectors", { key: ctx.operatorKey }),
    );
    expect(listed.data.map((row) => row.id)).toEqual([
      theirs.connector.id,
      first.connector.id,
    ]);
    expect(listed.data[0]?.source).toBe("another-process");

    expect(await remove(ctx.workingKey, first.connector.id)).toBe(200);
    expect(await remove(otherKey, theirs.connector.id)).toBe(200);
  });

  it("refuses a name outside the bounds and a description over its cap", async () => {
    for (const body of [
      { name: "" },
      { name: "n".repeat(201) },
      { name: "fine", description: "d".repeat(2001) },
      {},
    ]) {
      const res = await request(ctx.app, "POST", "/connectors", {
        key: ctx.workingKey,
        body,
      });
      expect(res.status).toBe(400);
    }
    const fine = await register(
      ctx.workingKey,
      "n".repeat(200),
      "d".repeat(2000),
    );
    expect(fine.status).toBe(201);
    expect(await remove(ctx.workingKey, fine.connector.id)).toBe(200);
  });
});

describe("GET /connectors/{id} and DELETE /connectors/{id}", () => {
  it("answers one to any key, 404 for an unknown id, and removes for the own key or the operator", async () => {
    const mine = await register(ctx.workingKey, "mine");
    const read = await request(
      ctx.app,
      "GET",
      `/connectors/${mine.connector.id}`,
      {
        key: otherKey,
      },
    );
    expect(read.status).toBe(200);
    expect(await json<Connector>(read)).toEqual(mine.connector);
    const unknown = await request(
      ctx.app,
      "GET",
      "/connectors/01a0c000-0000-7000-8000-000000000000",
      { key: otherKey },
    );
    expect(unknown.status).toBe(404);
    expect(await json<{ error: { code: string } }>(unknown)).toMatchObject({
      error: { code: "connector_not_found" },
    });

    expect(await remove(otherKey, mine.connector.id)).toBe(403);
    expect(
      (
        await request(ctx.app, "GET", `/connectors/${mine.connector.id}`, {
          key: otherKey,
        })
      ).status,
    ).toBe(200);
    expect(await remove(ctx.operatorKey, mine.connector.id)).toBe(200);
    expect(
      (
        await request(ctx.app, "GET", `/connectors/${mine.connector.id}`, {
          key: otherKey,
        })
      ).status,
    ).toBe(404);

    const again = await register(ctx.workingKey, "mine again");
    expect(await remove(ctx.workingKey, again.connector.id)).toBe(200);
    expect(await remove(ctx.workingKey, again.connector.id)).toBe(404);
  });

  it("writes audit rows for a registration and a removal, and none for a heartbeat or a run", async () => {
    const mine = await register(ctx.workingKey, "audited");
    await request(
      ctx.app,
      "POST",
      `/connectors/${mine.connector.id}/heartbeat`,
      {
        key: ctx.workingKey,
      },
    );
    await request(ctx.app, "POST", `/connectors/${mine.connector.id}/runs`, {
      key: ctx.workingKey,
      body: { outcome: "succeeded", started_at: at(1000), finished_at: at(0) },
    });
    expect(await remove(ctx.workingKey, mine.connector.id)).toBe(200);
    const rows = await ctx.storage.audit.list({
      resource_id: mine.connector.id,
      limit: 10,
    });
    expect(rows.data.map((row) => row.action).sort()).toEqual([
      "connector.delete",
      "connector.register",
    ]);
  });
});

describe("POST /connectors/{id}/heartbeat", () => {
  it("stamps the server's clock for the connector's key alone", async () => {
    const mine = await register(ctx.workingKey, "beats");
    const refused = await request(
      ctx.app,
      "POST",
      `/connectors/${mine.connector.id}/heartbeat`,
      { key: otherKey },
    );
    expect(refused.status).toBe(403);
    const operator = await request(
      ctx.app,
      "POST",
      `/connectors/${mine.connector.id}/heartbeat`,
      { key: ctx.operatorKey },
    );
    expect(operator.status).toBe(403);
    expect(
      (await ctx.storage.connectors.get(mine.connector.id))?.last_heartbeat_at,
    ).toBeNull();

    const before = new Date().toISOString();
    const beat = await request(
      ctx.app,
      "POST",
      `/connectors/${mine.connector.id}/heartbeat`,
      { key: ctx.workingKey },
    );
    expect(beat.status).toBe(200);
    const { last_heartbeat_at } = await json<{ last_heartbeat_at: string }>(
      beat,
    );
    expect(last_heartbeat_at >= before).toBe(true);
    expect(
      (await ctx.storage.connectors.get(mine.connector.id))?.last_heartbeat_at,
    ).toBe(last_heartbeat_at);
    expect(await remove(ctx.workingKey, mine.connector.id)).toBe(200);
  });
});

describe("POST /connectors/{id}/runs and GET /connectors/{id}/runs", () => {
  it("records a run for the connector's key, refuses what it does not know, and lists newest first", async () => {
    const mine = await register(ctx.workingKey, "runs");
    const path = `/connectors/${mine.connector.id}/runs`;
    const recorded = await request(ctx.app, "POST", path, {
      key: ctx.workingKey,
      body: {
        outcome: "succeeded",
        started_at: at(5000),
        finished_at: at(4000),
        summary: "12 messages",
      },
    });
    expect(recorded.status).toBe(201);
    const run = await json<ConnectorRun>(recorded);
    expect(run).toMatchObject({
      connector_id: mine.connector.id,
      outcome: "succeeded",
      summary: "12 messages",
      error: null,
    });

    for (const body of [
      { outcome: "skipped", started_at: at(1000), finished_at: at(0) },
      { outcome: "failed", started_at: at(0), finished_at: at(1000) },
      { outcome: "failed", started_at: "yesterday", finished_at: at(0) },
      { started_at: at(1000), finished_at: at(0) },
    ]) {
      const res = await request(ctx.app, "POST", path, {
        key: ctx.workingKey,
        body,
      });
      expect(res.status, JSON.stringify(body)).toBe(400);
    }
    const theirs = await request(ctx.app, "POST", path, {
      key: otherKey,
      body: { outcome: "failed", started_at: at(1000), finished_at: at(0) },
    });
    expect(theirs.status).toBe(403);

    const failed = await request(ctx.app, "POST", path, {
      key: ctx.workingKey,
      body: {
        outcome: "failed",
        started_at: at(3000),
        finished_at: at(2000),
        error: "the mailbox refused the token",
      },
    });
    expect(failed.status).toBe(201);

    const listed = await request(ctx.app, "GET", path, { key: otherKey });
    expect(listed.status).toBe(200);
    const runs = await json<{ data: ConnectorRun[] }>(listed);
    expect(runs.data.map((r) => r.outcome)).toEqual(["failed", "succeeded"]);
    const one = await json<{ data: ConnectorRun[] }>(
      await request(ctx.app, "GET", `${path}?limit=1`, { key: otherKey }),
    );
    expect(one.data.map((r) => r.outcome)).toEqual(["failed"]);
    expect(
      (await ctx.storage.connectors.get(mine.connector.id))?.last_run?.error,
    ).toBe("the mailbox refused the token");
    expect(await remove(ctx.workingKey, mine.connector.id)).toBe(200);
  });

  it("keeps the newest hundred runs and drops the oldest beyond", async () => {
    const mine = await register(ctx.workingKey, "hundred");
    for (let i = 1; i <= RUNS_KEPT_PER_CONNECTOR + 1; i++) {
      const res = await request(
        ctx.app,
        "POST",
        `/connectors/${mine.connector.id}/runs`,
        {
          key: ctx.workingKey,
          body: {
            outcome: "succeeded",
            started_at: at(1000),
            finished_at: at(0),
            summary: `run ${String(i)}`,
          },
        },
      );
      expect(res.status).toBe(201);
    }
    const kept = await ctx.storage.connectors.listRuns(mine.connector.id, 500);
    expect(kept).toHaveLength(RUNS_KEPT_PER_CONNECTOR);
    const summaries = kept.map((r) => r.summary);
    expect(summaries[0]).toBe(`run ${String(RUNS_KEPT_PER_CONNECTOR + 1)}`);
    expect(summaries).toContain("run 2");
    expect(summaries).not.toContain("run 1");
    expect(await remove(ctx.workingKey, mine.connector.id)).toBe(200);
    expect(
      await ctx.storage.connectors.listRuns(mine.connector.id, 500),
    ).toEqual([]);
  });
});
