import { createClient, type InStatement } from "@libsql/client";
import {
  getTypeSchema,
  registerTypeSchema,
  SYSTEM_TYPE_IDS,
  TYPE_REGISTRY,
  validateProperties,
} from "@withmarfa/shared";
import { sql } from "drizzle-orm";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { __resetEventLogForTests, initEventLog } from "../../pubsub.js";
import {
  createTestContext,
  readSse,
  readSseWriting,
  request,
  type TestContext,
} from "../../test-utils.js";
import { runAuditedTransaction } from "../audited-transaction.js";
import { afterCommit } from "../commit-hooks.js";
import { setPlatformDrift } from "../platform-drift.js";
import { createSqliteStorage } from "./index.js";
import * as registryContext from "./registry-context.js";
import { sqliteRequestContext } from "./request-context.js";

const fault = vi.hoisted(() => ({
  mode: "none",
  fired: false,
  readFailed: false,
  entered: undefined as (() => void) | undefined,
  release: undefined as Promise<void> | undefined,
}));
vi.mock("@libsql/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@libsql/client")>();
  return {
    ...actual,
    createClient: (...args: Parameters<typeof actual.createClient>) => {
      const client = actual.createClient(...args),
        execute = client.execute.bind(client);
      let reader = false;
      client.execute = async (
        statement: InStatement | string,
        ...rest: unknown[]
      ) => {
        const sql = typeof statement === "string" ? statement : statement.sql;
        if (sql === "BEGIN TRANSACTION READONLY") reader = true;
        if (reader && sql.startsWith("SELECT id, schema, origin, family")) {
          fault.entered?.();
          await fault.release;
          if (fault.readFailed) throw new Error("registry read witness");
        }
        const target =
          !reader && sql === "COMMIT" && !fault.fired && fault.mode !== "none";
        if (target && fault.mode === "before") {
          fault.fired = true;
          throw new Error("structural acknowledgment witness");
        }
        const result = await execute(statement, ...(rest as []));
        if (target && fault.mode === "after") {
          fault.fired = true;
          throw new Error("structural acknowledgment witness");
        }
        return result;
      };
      return client;
    },
  };
});
function gate() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
let ctx: TestContext;
let observer: ReturnType<typeof createClient>;
const schema = {
  id: "example.settlement",
  version: 1,
  fields: { title: { type: "string" as const, required: true } },
};
const changed = {
  ...schema,
  version: 2,
  fields: {
    ...schema.fields,
    required: { type: "string" as const, required: true },
  },
};
beforeEach(async () => {
  ctx = await createTestContext();
  observer = createClient({ url: `file:${join(ctx.tmpDir, "test.db")}` });
  await ctx.storage.types.create(schema);
});
afterEach(async () => {
  fault.mode = "none";
  fault.fired = false;
  fault.readFailed = false;
  fault.entered = undefined;
  fault.release = undefined;
  setPlatformDrift([]);
  vi.restoreAllMocks();
  __resetEventLogForTests();
  observer.close();
  await ctx.cleanup();
});
async function durable() {
  const result = await observer.execute({
    sql: "SELECT schema FROM types WHERE id = ?",
    args: [schema.id],
  });
  return JSON.parse(result.rows[0]?.schema as string) as typeof schema;
}

it.each(["before", "after"] as const)(
  "reconstructs an uncertain %s-COMMIT structure before releasing a queued writer",
  async (mode) => {
    const entered = gate(),
      release = gate(),
      bodyReady = gate(),
      bodyRelease = gate();
    let announcements = 0,
      secondEntered = false;
    fault.mode = mode;
    fault.entered = entered.resolve;
    fault.release = release.promise;
    const first = ctx.storage.runInTransaction(async () => {
      await ctx.storage.types.update(schema.id, changed);
      afterCommit(() => {
        announcements++;
      });
      bodyReady.resolve();
      await bodyRelease.promise;
    });
    const rejected = expect(first).rejects.toThrow(
      "structural acknowledgment witness",
    );
    await bodyReady.promise;
    const queued = ctx.storage.runInTransaction(() => {
      secondEntered = true;
      return getTypeSchema(schema.id);
    });
    bodyRelease.resolve();
    await entered.promise;
    expect(secondEntered).toBe(false);
    expect(fault.fired).toBe(true);
    expect(() => getTypeSchema(schema.id)).toThrow(
      "Storage registry state is unavailable",
    );
    const second = ctx.storage.runInTransaction(() => undefined);
    await expect(second).rejects.toThrow(
      "Storage registry state is unavailable",
    );
    expect(secondEntered).toBe(false);
    release.resolve();
    await rejected;
    expect(announcements).toBe(0);
    const expected = mode === "after" ? changed : schema;
    expect(await durable()).toEqual(expected);
    expect(getTypeSchema(schema.id)).toEqual(expected);
    expect(await queued).toEqual(expected);
    expect(secondEntered).toBe(true);
    expect(
      await ctx.storage.runInTransaction(() => getTypeSchema(schema.id)),
    ).toEqual(expected);
  },
);

it.each(["before", "after"] as const)(
  "the audit witness settles a structural %s-COMMIT only after registry reconstruction",
  async (mode) => {
    const created = await request(ctx.app, "POST", "/items", {
      key: ctx.workingKey,
      body: { type: "core.note", properties: { body: "extension owner" } },
    });
    expect(created.status).toBe(201);
    const { item } = (await created.json()) as { item: { id: string } };
    let emitted = 0,
      writes = 0;
    fault.mode = mode;
    const operation = runAuditedTransaction(
      ctx.storage,
      async () => {
        writes++;
        await ctx.storage.types.update(schema.id, changed);
        await ctx.storage.metadata.setExtension(
          item.id,
          "test",
          {
            value: "committed",
          },
          null,
        );
        afterCommit(() => {
          emitted++;
        });
        return "accepted";
      },
      {
        action: "test.structural",
        resource_type: "type",
        resource_id: schema.id,
      },
    );
    if (mode === "after") await expect(operation).resolves.toBe("accepted");
    else
      await expect(operation).rejects.toThrow(
        "structural acknowledgment witness",
      );
    expect(writes).toBe(1);
    expect(emitted).toBe(mode === "after" ? 1 : 0);
    expect(await durable()).toEqual(mode === "after" ? changed : schema);
    expect(getTypeSchema(schema.id)).toEqual(await durable());
    const audits = await observer.execute(
      "SELECT count(*) AS count FROM audit_log WHERE action = 'test.structural'",
    );
    expect(audits.rows[0]?.count).toBe(mode === "after" ? 1 : 0);
    expect(await ctx.storage.metadata.getExtensions(item.id)).toEqual(
      mode === "after" ? { test: { value: "committed" } } : {},
    );
  },
);

it("failed independent reconstruction fences registry-backed reads/writes until authoritative boot", async () => {
  fault.mode = "after";
  fault.readFailed = true;
  await expect(
    runAuditedTransaction(
      ctx.storage,
      () => ctx.storage.types.update(schema.id, changed),
      {
        action: "test.fenced_registry",
        resource_type: "type",
        resource_id: schema.id,
      },
    ),
  ).rejects.toMatchObject({
    message: "structural acknowledgment witness",
    control: { outcome: "unknown" },
  });
  expect(
    (
      await observer.execute(
        "SELECT count(*) AS count FROM audit_log WHERE action = 'test.fenced_registry'",
      )
    ).rows[0]?.count,
  ).toBe(1);
  expect(await durable()).toEqual(changed);
  expect(() => getTypeSchema(schema.id)).toThrow(
    "Storage registry state is unavailable",
  );
  await expect(ctx.storage.runInTransaction(() => undefined)).rejects.toThrow(
    "Storage registry state is unavailable",
  );
  const refused = await request(ctx.app, "GET", "/types", {
    key: ctx.workingKey,
  });
  expect(refused.status).toBe(500);
  const envelope = (await refused.json()) as {
    error: { code: string; message: string };
  };
  expect(envelope.error.code).toBe("internal_error");
  expect(JSON.stringify(envelope)).not.toMatch(/SELECT|params|stack/);
  fault.mode = "none";
  fault.readFailed = false;
  await ctx.storage.close();
  const reopened = await createSqliteStorage(join(ctx.tmpDir, "test.db"));
  try {
    expect(getTypeSchema(schema.id)).toEqual(changed);
    expect(
      await reopened.runInTransaction(() => getTypeSchema(schema.id)),
    ).toEqual(changed);
  } finally {
    await reopened.close();
  }
});

it("a native transaction-ending rollback discards staged structure and stops later work", async () => {
  await ctx.storage.runInTransaction(async () => {
    await sqliteRequestContext
      .getStore()!
      .tx.run(sql`CREATE TABLE registry_abort (id TEXT PRIMARY KEY)`);
  });
  let laterAttempted = false;
  await expect(
    ctx.storage.runInTransaction(async () => {
      await ctx.storage.types.update(schema.id, changed);
      const tx = sqliteRequestContext.getStore()!.tx;
      try {
        await tx.run(sql`INSERT INTO registry_abort VALUES ('duplicate')`);
        await tx.run(
          sql`INSERT OR ROLLBACK INTO registry_abort VALUES ('duplicate')`,
        );
      } catch {
        /* Root usability is still asserted at the next wrapped operation. */
      }
      await ctx.storage.types.create({
        id: "example.later",
        version: 1,
        fields: {},
      });
      laterAttempted = true;
    }),
  ).rejects.toThrow(/UNIQUE constraint failed/);
  expect(laterAttempted).toBe(false);
  expect(await durable()).toEqual(schema);
  expect(getTypeSchema(schema.id)).toEqual(schema);
  expect(getTypeSchema("example.later")).toBeUndefined();
});

it("an escaped async context cannot register after its root scope closes", async () => {
  const resume = gate();
  let escaped!: Promise<void>;
  await ctx.storage.runInTransaction(() => {
    escaped = (async () => {
      await resume.promise;
      registerTypeSchema({ id: "example.escaped", version: 1, fields: {} });
    })();
  });
  const rejection = expect(escaped).rejects.toThrow("context is closed");
  resume.resolve();
  await rejection;
  expect(getTypeSchema("example.escaped")).toBeUndefined();
});

it.each([false, true])(
  "the existing platform removal door commits its platform facet and system membership (rollback=%s)",
  async (rollback) => {
    const retired = {
      id: "system.retired_registry",
      version: 1,
      fields: { name: { type: "string" as const } },
    };
    await ctx.storage.types.create(retired, { origin: "platform" });
    setPlatformDrift([retired.id]);
    const map = TYPE_REGISTRY,
      set = SYSTEM_TYPE_IDS;
    expect(map.has(retired.id)).toBe(true);
    expect(set.has(retired.id)).toBe(true);
    expect(
      validateProperties(retired.id, { name: "before" }, { strict: true })
        .success,
    ).toBe(true);
    const remove = () =>
      request(ctx.app, "DELETE", `/platform-types/${retired.id}`, {
        key: ctx.managementKey,
      });
    if (rollback)
      await expect(
        ctx.storage.runInTransaction(async () => {
          expect((await remove()).status).toBe(200);
          expect(map.has(retired.id)).toBe(false);
          expect(set.has(retired.id)).toBe(false);
          throw new Error("platform rollback witness");
        }),
      ).rejects.toThrow("platform rollback witness");
    else expect((await remove()).status).toBe(200);
    const rows = (
      await observer.execute({
        sql: "SELECT id FROM types WHERE id = ?",
        args: [retired.id],
      })
    ).rows;
    expect(rows.length).toBe(rollback ? 1 : 0);
    expect(map.has(retired.id)).toBe(rollback);
    expect(set.has(retired.id)).toBe(rollback);
    expect(
      validateProperties(retired.id, { name: "before" }, { strict: true })
        .success,
    ).toBe(rollback);
  },
);

it.each(["before", "after"] as const)(
  "an uncertain structural %s-COMMIT preserves independent event settlement and the live reconnect remedy",
  async (mode) => {
    initEventLog(ctx.storage.eventLog);
    const created = await request(ctx.app, "POST", "/items", {
      key: ctx.workingKey,
      body: { type: "core.note", properties: { body: "original" } },
    });
    expect(created.status).toBe(201);
    const { item } = (await created.json()) as { item: { id: string } };
    const cursor = (await ctx.storage.eventLog.getMaxId())!;
    let announced = 0;
    const stream = await request(ctx.app, "GET", "/events", {
      key: ctx.workingKey,
      headers: { "Last-Event-ID": String(cursor) },
    });
    const live = await readSseWriting(
      stream,
      "event: stream_live",
      async () => {
        fault.mode = mode;
        await expect(
          ctx.storage.runInTransaction(async () => {
            await ctx.storage.types.update(schema.id, schema);
            afterCommit(() => {
              announced++;
            });
            const updated = await request(
              ctx.app,
              "PATCH",
              `/items/${item.id}`,
              {
                key: ctx.workingKey,
                body: { version: 1, properties: { body: "committed event" } },
              },
            );
            expect(updated.status).toBe(200);
          }),
        ).rejects.toThrow("structural acknowledgment witness");
      },
      { untilClosed: true },
    );
    expect(live.text).toContain("event: stream_live");
    expect(live.text).toContain("event: stream_incomplete");
    expect(live.text).toContain('"reason":"live_delivery_failed"');
    expect(live.text).not.toContain("event: item.updated");
    expect(announced).toBe(0);
    const events = await ctx.storage.eventLog.getAfter(cursor, 10);
    const independentRows = await observer.execute({
      sql: "SELECT version, json(properties) AS properties FROM items WHERE id = ?",
      args: [item.id],
    });
    const independentEvents = await observer.execute({
      sql: "SELECT count(*) AS count FROM event_log WHERE id > ?",
      args: [cursor],
    });
    expect(independentRows.rows[0]?.version).toBe(mode === "after" ? 2 : 1);
    expect(JSON.parse(independentRows.rows[0]?.properties as string)).toEqual({
      body: mode === "after" ? "committed event" : "original",
    });
    expect(independentEvents.rows[0]?.count).toBe(mode === "after" ? 1 : 0);
    expect(events).toHaveLength(mode === "after" ? 1 : 0);
    const current = await ctx.storage.items.get(item.id);
    expect(current?.version).toBe(mode === "after" ? 2 : 1);
    expect(current?.properties.body).toBe(
      mode === "after" ? "committed event" : "original",
    );
    expect(await durable()).toEqual(schema);
    expect(getTypeSchema(schema.id)).toEqual(await durable());
    const reconnect = await request(ctx.app, "GET", "/events", {
      key: ctx.workingKey,
      headers: { "Last-Event-ID": String(cursor) },
    });
    const replay = await readSse(reconnect, {
      until: (text) => text.includes("event: stream_live"),
    });
    if (mode === "after") {
      expect(replay.text).toContain(`id: ${String(events[0]!.id)}`);
      expect(replay.text.match(/event: item.updated/g)).toHaveLength(1);
      expect(replay.text).toContain("committed event");
    } else expect(replay.text).not.toContain("event: item.updated");
  },
);

it.each(["prepare", "publish"] as const)(
  "a structural %s failure keeps SQL and runtime authoritative and leaves the next writer usable",
  async (stage) => {
    const factory = registryContext.rootRegistryParticipant;
    vi.spyOn(registryContext, "rootRegistryParticipant").mockImplementationOnce(
      () => {
        const structural = factory();
        if (stage === "prepare")
          structural.participant.prepare = () => {
            throw new Error("structural preparation witness");
          };
        else
          structural.participant.committed = () => {
            throw new Error("structural publication witness");
          };
        return structural;
      },
    );
    await expect(
      ctx.storage.runInTransaction(() =>
        ctx.storage.types.update(schema.id, changed),
      ),
    ).rejects.toThrow(
      stage === "prepare"
        ? "structural preparation witness"
        : "structural publication witness",
    );
    const expected = stage === "prepare" ? schema : changed;
    expect(await durable()).toEqual(expected);
    expect(getTypeSchema(schema.id)).toEqual(expected);
    expect(
      await ctx.storage.runInTransaction(() => getTypeSchema(schema.id)),
    ).toEqual(expected);
  },
);
