import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { createTestContext, request, seedOauthBearer } from "../test-utils.js";
import type { TestContext } from "../test-utils.js";
import type { Connector, ConnectorRun } from "../storage/interface.js";
import { RUNS_KEPT_PER_CONNECTOR } from "../storage/sqlite/connector-store.js";

let ctx: TestContext;
/** A second working key, for the doors that answer the connector's own
 *  key alone. */
let otherKey: string;

/** A working key of its own source, minted through the first. */
async function mintKey(source: string): Promise<{ id: string; key: string }> {
  const minted = await request(ctx.app, "POST", "/keys", {
    key: ctx.workingKey,
    body: { label: `${source} key`, source },
  });
  expect(minted.status).toBe(201);
  return json<{ id: string; key: string }>(minted);
}

beforeAll(async () => {
  ctx = await createTestContext();
  otherKey = (await mintKey("another-process")).key;
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

  it("answers one 201 and one 200 with one id when a key registers twice at once", async () => {
    const [a, b] = await Promise.all([
      register(ctx.workingKey, "raced"),
      register(ctx.workingKey, "raced"),
    ]);
    expect([a.status, b.status].sort()).toEqual([200, 201]);
    expect(b.connector.id).toBe(a.connector.id);
    const listed = await json<{ data: Connector[] }>(
      await request(ctx.app, "GET", "/connectors", { key: otherKey }),
    );
    expect(listed.data.filter((row) => row.id === a.connector.id)).toHaveLength(
      1,
    );
    expect(await remove(ctx.workingKey, a.connector.id)).toBe(200);
  });

  it("refuses an app's session token, which reads but is not a key", async () => {
    const mine = await register(ctx.workingKey, "mine, read by an app");
    const { token } = await seedOauthBearer(ctx.storage, ["openid"]);
    const listed = await request(ctx.app, "GET", "/connectors", { key: token });
    expect(listed.status).toBe(200);
    const one = await request(
      ctx.app,
      "GET",
      `/connectors/${mine.connector.id}`,
      { key: token },
    );
    expect(one.status).toBe(200);
    const refused = await request(ctx.app, "POST", "/connectors", {
      key: token,
      body: { name: "an app" },
    });
    expect(refused.status).toBe(403);
    expect(await json<{ error: { code: string } }>(refused)).toMatchObject({
      error: { code: "forbidden" },
    });
    expect(
      (await ctx.storage.connectors.list()).filter(
        (row) => row.name === "an app",
      ),
    ).toEqual([]);
    // Nor is it the connector's own key on the doors that ask for one.
    const path = `/connectors/${mine.connector.id}`;
    for (const [method, sub, body] of [
      ["POST", "/heartbeat", undefined],
      [
        "POST",
        "/runs",
        { outcome: "succeeded", started_at: at(1000), finished_at: at(0) },
      ],
      ["DELETE", "", undefined],
    ] as const) {
      const res = await request(ctx.app, method, `${path}${sub}`, {
        key: token,
        body,
      });
      expect(res.status, `${method} ${sub}`).toBe(403);
    }
    expect(
      (await ctx.storage.connectors.get(mine.connector.id))?.last_heartbeat_at,
    ).toBeNull();
    expect(await remove(ctx.workingKey, mine.connector.id)).toBe(200);
  });

  it("answers 404 connector_not_found on every door under an id nothing carries", async () => {
    const unknown = "/connectors/01a0c000-0000-7000-8000-000000000000";
    for (const [method, sub, body] of [
      ["GET", "", undefined],
      ["DELETE", "", undefined],
      ["POST", "/heartbeat", undefined],
      [
        "POST",
        "/runs",
        { outcome: "succeeded", started_at: at(1000), finished_at: at(0) },
      ],
      ["GET", "/runs", undefined],
    ] as const) {
      const res = await request(ctx.app, method, `${unknown}${sub}`, {
        key: ctx.operatorKey,
        body,
      });
      expect(res.status, `${method} ${sub}`).toBe(404);
      expect(await json<{ error: { code: string } }>(res)).toMatchObject({
        error: { code: "connector_not_found" },
      });
    }
    // The store behind the doors answers the same absence.
    const id = "01a0c000-0000-7000-8000-000000000000";
    expect(await ctx.storage.connectors.heartbeat(id)).toBeNull();
    expect(await ctx.storage.connectors.remove(id)).toBe(false);
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
    const removed = await request(
      ctx.app,
      "DELETE",
      `/connectors/${again.connector.id}`,
      { key: ctx.workingKey },
    );
    expect(removed.status).toBe(200);
    expect(await json<unknown>(removed)).toEqual({ ok: true });
    expect(await remove(ctx.workingKey, again.connector.id)).toBe(404);

    const root = await request(ctx.app, "GET", "/", { key: otherKey });
    expect((await json<{ features: string[] }>(root)).features).toContain(
      "connectors",
    );
  });

  it("answers one 200 and one 404 when a registration is removed twice at once, auditing once", async () => {
    const mine = await register(ctx.workingKey, "removed twice");
    const statuses = await Promise.all([
      remove(ctx.workingKey, mine.connector.id),
      remove(ctx.operatorKey, mine.connector.id),
    ]);
    expect(statuses.sort()).toEqual([200, 404]);
    const rows = await ctx.storage.audit.list({
      resource_id: mine.connector.id,
      limit: 10,
    });
    expect(rows.data.map((row) => row.action).sort()).toEqual([
      "connector.delete",
      "connector.register",
    ]);
  });

  it("keeps a registration whose key was revoked, until the operator removes it", async () => {
    const minted = await request(ctx.app, "POST", "/keys", {
      key: ctx.workingKey,
      body: { label: "short-lived", source: "short-lived" },
    });
    expect(minted.status).toBe(201);
    const { id: keyId, key } = await json<{ id: string; key: string }>(minted);
    const mine = await register(key, "short-lived reader");
    expect(mine.status).toBe(201);
    expect(mine.connector.key_id).toBe(keyId);
    const heartbeat = () =>
      request(ctx.app, "POST", `/connectors/${mine.connector.id}/heartbeat`, {
        key,
      });
    expect((await heartbeat()).status).toBe(200);

    const revoked = await request(ctx.app, "DELETE", `/keys/${keyId}`, {
      key: ctx.operatorKey,
    });
    expect(revoked.status).toBe(200);
    expect((await heartbeat()).status).toBe(401);
    const read = await request(
      ctx.app,
      "GET",
      `/connectors/${mine.connector.id}`,
      { key: otherKey },
    );
    expect(read.status).toBe(200);
    expect(await json<Connector>(read)).toMatchObject({
      key_id: keyId,
      source: "short-lived",
      last_heartbeat_at: expect.any(String) as string,
    });

    // A source is unique among live keys only: a successor minted under
    // the revoked key's source is another key, not this registration's.
    const successor = await mintKey("short-lived");
    const path = `/connectors/${mine.connector.id}`;
    const beat = await request(ctx.app, "POST", `${path}/heartbeat`, {
      key: successor.key,
    });
    expect(beat.status).toBe(403);
    const run = await request(ctx.app, "POST", `${path}/runs`, {
      key: successor.key,
      body: { outcome: "succeeded", started_at: at(1000), finished_at: at(0) },
    });
    expect(run.status).toBe(403);
    const own = await register(successor.key, "the successor");
    expect(own.status).toBe(201);
    expect(own.connector.id).not.toBe(mine.connector.id);
    expect(own.connector.key_id).toBe(successor.id);
    expect(await remove(successor.key, own.connector.id)).toBe(200);
    expect(await remove(ctx.operatorKey, mine.connector.id)).toBe(200);
  });

  it("writes audit rows for every registration and a removal, and none for a heartbeat or a run", async () => {
    const mine = await register(ctx.workingKey, "audited");
    expect(mine.status).toBe(201);
    const again = await register(ctx.workingKey, "audited, renamed");
    expect(again.status).toBe(200);
    const beat = await request(
      ctx.app,
      "POST",
      `/connectors/${mine.connector.id}/heartbeat`,
      {
        key: ctx.workingKey,
      },
    );
    expect(beat.status).toBe(200);
    const run = await request(
      ctx.app,
      "POST",
      `/connectors/${mine.connector.id}/runs`,
      {
        key: ctx.workingKey,
        body: {
          outcome: "succeeded",
          started_at: at(1000),
          finished_at: at(0),
        },
      },
    );
    expect(run.status).toBe(201);
    expect(await remove(ctx.workingKey, mine.connector.id)).toBe(200);
    const rows = await ctx.storage.audit.list({
      resource_id: mine.connector.id,
      limit: 10,
    });
    const written = rows.data.map((row) => [row.action, row.details]);
    written.sort((a, b) => (JSON.stringify(a) < JSON.stringify(b) ? -1 : 1));
    expect(written).toEqual([
      ["connector.delete", { name: "audited, renamed" }],
      ["connector.register", { name: "audited", created: true }],
      ["connector.register", { name: "audited, renamed", created: false }],
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
      { outcome: "failed", started_at: at(1000), finished_at: "tomorrow" },
      { started_at: at(1000), finished_at: at(0) },
      {
        outcome: "failed",
        started_at: at(1000),
        finished_at: at(0),
        summary: "s".repeat(2001),
      },
      {
        outcome: "failed",
        started_at: at(1000),
        finished_at: at(0),
        error: "e".repeat(2001),
      },
    ]) {
      const res = await request(ctx.app, "POST", path, {
        key: ctx.workingKey,
        body,
      });
      expect(res.status, JSON.stringify(body).slice(0, 60)).toBe(400);
    }
    for (const key of [otherKey, ctx.operatorKey]) {
      const theirs = await request(ctx.app, "POST", path, {
        key,
        body: { outcome: "failed", started_at: at(1000), finished_at: at(0) },
      });
      expect(theirs.status).toBe(403);
    }
    expect(
      await json<{ data: ConnectorRun[] }>(
        await request(ctx.app, "GET", path, { key: otherKey }),
      ),
    ).toEqual({ data: [run], next_cursor: null });

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
    // An instant run, and a summary and an error at their caps, are fine.
    const instant = at(0);
    const capped = await request(ctx.app, "POST", path, {
      key: ctx.workingKey,
      body: {
        outcome: "succeeded",
        started_at: instant,
        finished_at: instant,
        summary: "s".repeat(2000),
        error: "e".repeat(2000),
      },
    });
    expect(capped.status).toBe(201);
    // Reported last with the earliest start: newest by report, stamped by
    // the server's clock, not by when the run says it started.
    const late = await request(ctx.app, "POST", path, {
      key: ctx.workingKey,
      body: {
        outcome: "succeeded",
        started_at: at(90_000),
        finished_at: at(80_000),
        summary: "reported late",
      },
    });
    expect(late.status).toBe(201);
    const lateRun = await json<ConnectorRun>(late);
    const cappedRun = await json<ConnectorRun>(capped);
    expect(lateRun.reported_at >= cappedRun.reported_at).toBe(true);
    expect(lateRun.reported_at).not.toBe(lateRun.started_at);

    const listed = await request(ctx.app, "GET", path, { key: otherKey });
    expect(listed.status).toBe(200);
    const runs = await json<{ data: ConnectorRun[] }>(listed);
    expect(runs.data.map((r) => r.summary)).toEqual([
      "reported late",
      "s".repeat(2000),
      null,
      "12 messages",
    ]);
    const one = await json<{ data: ConnectorRun[] }>(
      await request(ctx.app, "GET", `${path}?limit=1`, { key: otherKey }),
    );
    expect(one.data.map((r) => r.summary)).toEqual(["reported late"]);
    for (const limit of ["0", "201", "x"]) {
      expect(
        (
          await request(ctx.app, "GET", `${path}?limit=${limit}`, {
            key: otherKey,
          })
        ).status,
      ).toBe(400);
    }
    expect(
      (await ctx.storage.connectors.get(mine.connector.id))?.last_run?.summary,
    ).toBe("reported late");
    expect(await remove(ctx.workingKey, mine.connector.id)).toBe(200);
  });

  it("keeps each connector's runs to itself", async () => {
    const a = await register(ctx.workingKey, "a");
    const b = await register(otherKey, "b");
    const third = await mintKey("a-third-process");
    const c = await register(third.key, "c");
    for (const [key, id, summary] of [
      [ctx.workingKey, a.connector.id, "a's run"],
      [otherKey, b.connector.id, "b's run"],
    ] as const) {
      const res = await request(ctx.app, "POST", `/connectors/${id}/runs`, {
        key,
        body: {
          outcome: "succeeded",
          started_at: at(1000),
          finished_at: at(0),
          summary,
        },
      });
      expect(res.status).toBe(201);
    }
    const runsOf = async (id: string) =>
      (
        await json<{ data: ConnectorRun[] }>(
          await request(ctx.app, "GET", `/connectors/${id}/runs`, {
            key: third.key,
          }),
        )
      ).data.map((r) => r.summary);
    expect(await runsOf(a.connector.id)).toEqual(["a's run"]);
    expect(await runsOf(b.connector.id)).toEqual(["b's run"]);
    expect(await runsOf(c.connector.id)).toEqual([]);
    const listed = await json<{ data: Connector[] }>(
      await request(ctx.app, "GET", "/connectors", { key: third.key }),
    );
    const lastRunOf = (id: string) =>
      listed.data.find((row) => row.id === id)?.last_run?.summary ?? null;
    expect(lastRunOf(a.connector.id)).toBe("a's run");
    expect(lastRunOf(b.connector.id)).toBe("b's run");
    expect(lastRunOf(c.connector.id)).toBeNull();
    // A hundred and one runs on one connector trim nothing of another's.
    for (let i = 0; i <= RUNS_KEPT_PER_CONNECTOR; i++) {
      const res = await request(
        ctx.app,
        "POST",
        `/connectors/${a.connector.id}/runs`,
        {
          key: ctx.workingKey,
          body: {
            outcome: "succeeded",
            started_at: at(1000),
            finished_at: at(0),
          },
        },
      );
      expect(res.status).toBe(201);
    }
    expect(await runsOf(b.connector.id)).toEqual(["b's run"]);
    expect(await remove(ctx.workingKey, a.connector.id)).toBe(200);
    expect(await remove(otherKey, b.connector.id)).toBe(200);
    expect(await remove(third.key, c.connector.id)).toBe(200);
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
    expect(RUNS_KEPT_PER_CONNECTOR).toBe(100);
    const kept = await ctx.storage.connectors.listRuns(mine.connector.id, 500);
    expect(kept).toHaveLength(RUNS_KEPT_PER_CONNECTOR);
    const byDefault = await json<{ data: ConnectorRun[] }>(
      await request(ctx.app, "GET", `/connectors/${mine.connector.id}/runs`, {
        key: otherKey,
      }),
    );
    expect(byDefault.data).toHaveLength(50);
    const two = await json<{ data: ConnectorRun[] }>(
      await request(
        ctx.app,
        "GET",
        `/connectors/${mine.connector.id}/runs?limit=200`,
        { key: otherKey },
      ),
    );
    expect(two.data).toHaveLength(RUNS_KEPT_PER_CONNECTOR);
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
