import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { Server } from "node:http";
import { join } from "node:path";
import { sql } from "drizzle-orm";
import { createClient } from "@libsql/client";
import { serve } from "@hono/node-server";
import { createConnection, setBusyBudgetMs } from "./connection.js";
import { wrapDbWithRequestContext } from "./request-context.js";
import { withCommitHooks, afterCommit } from "../commit-hooks.js";
import {
  createTestContext,
  request,
  readSse,
  readSseWriting,
  type TestContext,
} from "../../test-utils.js";
import { initEventLog, __resetEventLogForTests } from "../../pubsub.js";

const witness = vi.hoisted(() => ({
  busy: undefined as (() => void) | undefined,
}));
vi.mock("@libsql/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@libsql/client")>();
  return {
    ...actual,
    createClient: (...args: Parameters<typeof actual.createClient>) => {
      const client = actual.createClient(...args);
      const execute = client.execute.bind(client);
      client.execute = async (...parameters: Parameters<typeof execute>) => {
        try {
          return await execute(...parameters);
        } catch (error) {
          if (
            parameters[0] === "BEGIN IMMEDIATE" &&
            (error as { code?: string }).code === "SQLITE_BUSY"
          )
            witness.busy?.();
          throw error;
        }
      };
      return client;
    },
  };
});

let ctx: TestContext;
beforeEach(async () => {
  ctx = await createTestContext();
  initEventLog(ctx.storage.eventLog);
});
afterEach(async () => {
  witness.busy = undefined;
  vi.useRealTimers();
  setBusyBudgetMs(5000);
  __resetEventLogForTests();
  await ctx.cleanup();
});
async function note() {
  const created = await request(ctx.app, "POST", "/items", {
    key: ctx.workingKey,
    body: { type: "core.note", properties: { body: "initial" } },
  });
  expect(created.status).toBe(201);
  return ((await created.json()) as { item: { id: string } }).item.id;
}
async function write(id: string, body: string) {
  return ctx.storage.runInTransaction(async () => {
    const row = (await ctx.storage.items.get(id))!;
    expect(
      (
        await request(ctx.app, "PATCH", `/items/${id}`, {
          key: ctx.workingKey,
          body: { version: row.version, properties: { body } },
        })
      ).status,
    ).toBe(200);
  });
}
function itemFrames(text: string) {
  return text.split("\n\n").flatMap((block) => {
    const id = /^id: (\d+)$/m.exec(block)?.[1];
    const data = /^data: (.+)$/m.exec(block)?.[1];
    if (!id || !data) return [];
    const frame = JSON.parse(data) as {
      item?: { properties: { body: string }; version: number };
    };
    return frame.item
      ? [{ id, body: frame.item.properties.body, version: frame.item.version }]
      : [];
  });
}

describe("live announcements follow native writer admission", () => {
  it.each([false, true])(
    "keeps live and reconnect cursors in durable order (contended=%s)",
    async (contended) => {
      const locker = createClient({
        url: `file:${join(ctx.tmpDir, "test.db")}`,
      });
      try {
        const id = await note();
        const cursor = (await ctx.storage.eventLog.getMaxId())!;
        const response = await request(ctx.app, "GET", "/events", {
          key: ctx.workingKey,
          headers: { "Last-Event-ID": String(cursor) },
        });
        let busyRefusals = 0;
        const { text } = await readSseWriting(
          response,
          "event: stream_live",
          async () => {
            if (contended) {
              await locker.execute("BEGIN IMMEDIATE");
              const busy = new Promise<void>((resolve) => {
                witness.busy = () => {
                  busyRefusals++;
                  resolve();
                };
              });
              vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
              const first = write(id, "first-called");
              await busy;
              await locker.execute("ROLLBACK");
              await write(id, "second-called");
              await vi.advanceTimersByTimeAsync(2);
              await first;
              vi.useRealTimers();
            } else {
              await write(id, "first-called");
              await write(id, "second-called");
            }
          },
          (seen) =>
            seen.includes("first-called") && seen.includes("second-called"),
        );
        expect(busyRefusals).toBe(contended ? 1 : 0);
        const durable = await ctx.storage.eventLog.getAfter(cursor, 10);
        const wire = itemFrames(text);
        const order = contended
          ? ["second-called", "first-called"]
          : ["first-called", "second-called"];
        expect(durable.map((event) => String(event.id))).toEqual(
          wire.map((frame) => frame.id),
        );
        expect(wire.map((frame) => frame.body)).toEqual(order);
        expect(wire.map((frame) => frame.version)).toEqual([2, 3]);
        expect(text).not.toContain("stream_incomplete");
        expect((await ctx.storage.items.get(id))?.properties.body).toBe(
          wire.at(-1)?.body,
        );
        const reconnect = await request(ctx.app, "GET", "/events", {
          key: ctx.workingKey,
          headers: { "Last-Event-ID": wire[0]!.id },
        });
        const replay = await readSse(reconnect, {
          until: (seen) => seen.includes("event: stream_live"),
        });
        expect(itemFrames(replay.text)).toEqual([wire[1]]);
        const current = await request(ctx.app, "GET", "/events", {
          key: ctx.workingKey,
          headers: { "Last-Event-ID": wire[1]!.id },
        });
        const caughtUp = await readSse(current, {
          until: (seen) => seen.includes("event: stream_live"),
        });
        expect(itemFrames(caughtUp.text)).toEqual([]);
      } finally {
        witness.busy = undefined;
        vi.useRealTimers();
        locker.close();
      }
    },
  );

  it("an early native admission refusal leaves no announced frame and does not hold later writes", async () => {
    const id = await note();
    const cursor = (await ctx.storage.eventLog.getMaxId())!;
    const locker = createClient({ url: `file:${join(ctx.tmpDir, "test.db")}` });
    let bodyCalled = false,
      busyRefusals = 0;
    try {
      await locker.execute("BEGIN IMMEDIATE");
      setBusyBudgetMs(0);
      witness.busy = () => {
        busyRefusals++;
      };
      await expect(
        ctx.storage.runInTransaction(() => {
          bodyCalled = true;
          afterCommit(() => {
            throw new Error("unadmitted callback must not run");
          });
        }),
      ).rejects.toMatchObject({ code: "write_contention" });
      expect(busyRefusals).toBe(1);
      expect(bodyCalled).toBe(false);
      expect(await ctx.storage.eventLog.getAfter(cursor, 10)).toEqual([]);
      await locker.execute("ROLLBACK");
      setBusyBudgetMs(5000);
      witness.busy = undefined;
      const response = await request(ctx.app, "GET", "/events", {
        key: ctx.workingKey,
        headers: { "Last-Event-ID": String(cursor) },
      });
      const { text } = await readSseWriting(
        response,
        "event: stream_live",
        () => write(id, "later-admitted"),
        (seen) => seen.includes("later-admitted"),
      );
      const durable = await ctx.storage.eventLog.getAfter(cursor, 10);
      expect(itemFrames(text).map((frame) => frame.id)).toEqual(
        durable.map((event) => String(event.id)),
      );
      expect(itemFrames(text).map((frame) => frame.body)).toEqual([
        "later-admitted",
      ]);
      expect(text).not.toContain("stream_incomplete");
      expect((await ctx.storage.items.get(id))?.version).toBe(2);
    } finally {
      witness.busy = undefined;
      setBusyBudgetMs(5000);
      locker.close();
    }
  });
});

it("announcements follow native admission after an external lock refusal", async () => {
  const directory = mkdtempSync(join(tmpdir(), "marfa-admission-"));
  const path = join(directory, "test.db");
  const connection = await createConnection(path);
  const db = wrapDbWithRequestContext(connection.db);
  const locker = createClient({ url: `file:${path}` });
  const announced: string[] = [];
  try {
    await connection.raw.execute(
      "CREATE TABLE fixture (id INTEGER PRIMARY KEY AUTOINCREMENT, label TEXT)",
    );
    await locker.execute("BEGIN IMMEDIATE");
    const busy = new Promise<void>((resolve) => {
      witness.busy = resolve;
    });
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const write = (label: string) =>
      withCommitHooks(
        (body) => db.transaction(body),
        async () => {
          await db.run(sql`INSERT INTO fixture(label) VALUES (${label})`);
          afterCommit(() => announced.push(label));
        },
      );
    const first = write("first-called");
    await busy;
    await locker.execute("ROLLBACK");
    await write("second-called");
    await vi.advanceTimersByTimeAsync(2);
    await first;
    const durable = (
      await connection.raw.execute("SELECT label FROM fixture ORDER BY id")
    ).rows.map((row) => row.label);
    console.log("ADMISSION_ORDER", JSON.stringify({ durable, announced }));
    expect(durable).toEqual(["second-called", "first-called"]);
    expect(announced).toEqual(durable);
  } finally {
    witness.busy = undefined;
    vi.useRealTimers();
    locker.close();
    await connection.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

it("keeps an already live TCP subscriber and its reconnect cursor in native commit order", async () => {
  const ids = [await note(), await note()];
  const cursor = (await ctx.storage.eventLog.getMaxId())!;
  const server = serve({
    fetch: ctx.app.fetch,
    port: 0,
    hostname: "127.0.0.1",
  });
  if (!server.listening)
    await new Promise<void>((resolve) => server.once("listening", resolve));
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("server has no TCP address");
  const url = `http://127.0.0.1:${String(address.port)}`;
  const locker = createClient({ url: `file:${join(ctx.tmpDir, "test.db")}` });
  const headers = { Authorization: `Bearer ${ctx.workingKey}` };
  const patch = async (id: string, body: string) => {
    const response = await fetch(url + `/items/${id}`, {
      method: "PATCH",
      headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify({ version: 1, properties: { body } }),
    });
    expect(response.status).toBe(200);
    await response.body?.cancel();
  };
  try {
    const response = await fetch(url + "/events", {
      headers: { ...headers, "Last-Event-ID": String(cursor) },
    });
    expect(response.status).toBe(200);
    let busyRefusals = 0;
    const { text } = await readSseWriting(
      response,
      "event: stream_live",
      async () => {
        await locker.execute("BEGIN IMMEDIATE");
        const busy = new Promise<void>((resolve) => {
          witness.busy = () => {
            busyRefusals++;
            resolve();
          };
        });
        vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
        const first = patch(ids[0]!, "first-called");
        await busy;
        await locker.execute("ROLLBACK");
        await patch(ids[1]!, "second-called");
        await vi.advanceTimersByTimeAsync(2);
        await first;
        vi.useRealTimers();
      },
      (seen) => seen.includes("first-called") && seen.includes("second-called"),
    );
    expect(busyRefusals).toBe(1);
    const durable = await ctx.storage.eventLog.getAfter(cursor, 10);
    const wire = itemFrames(text);
    expect(durable.map((event) => event.item_id)).toEqual([ids[1], ids[0]]);
    expect(wire.map((frame) => frame.id)).toEqual(
      durable.map((event) => String(event.id)),
    );
    expect(wire.map((frame) => frame.body)).toEqual([
      "second-called",
      "first-called",
    ]);
    expect(text).not.toContain("stream_incomplete");
    const reconnect = await fetch(url + "/events", {
      headers: { ...headers, "Last-Event-ID": wire[0]!.id },
    });
    const replay = await readSse(reconnect, {
      until: (seen) => seen.includes("event: stream_live"),
    });
    expect(itemFrames(replay.text)).toEqual([wire[1]]);
    for (const [index, id] of ids.entries()) {
      const response = await fetch(url + `/items/${id}`, { headers });
      expect(response.status).toBe(200);
      const body = (await response.json()) as {
        item: { properties: { body: string } };
      };
      expect(body.item.properties.body).toBe(
        index === 0 ? "first-called" : "second-called",
      );
    }
  } finally {
    witness.busy = undefined;
    vi.useRealTimers();
    locker.close();
    if (server instanceof Server) server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => {
        if (error) reject(error);
        else resolve();
      }),
    );
  }
});
