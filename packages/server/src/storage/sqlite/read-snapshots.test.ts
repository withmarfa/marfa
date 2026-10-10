import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createClient, type InStatement } from "@libsql/client";
import { sql } from "drizzle-orm";
import {
  getTypeSchema,
  getEdgeTypeSchema,
  registryView,
  registerTypeSchema,
  validateProperties,
  EDGE_TYPE_REGISTRY,
  SYSTEM_TYPE_IDS,
  markStructuralReadChange,
  seedPlatformTypes,
  createRegistryFrame,
  TYPE_REGISTRY,
  registryMapFacet,
} from "@withmarfa/shared";
import { createSqliteStorage } from "./index.js";
import { sqliteRequestContext } from "./request-context.js";
import { itemWrites } from "../item-writes.js";
import { TrashPurger } from "../retention.js";
import { STRUCTURAL_GENERATION_KEY } from "./structural-generation.js";

const fault = vi.hoisted(() => ({
  gateSql: "",
  entered: undefined as (() => void) | undefined,
  released: undefined as Promise<void> | undefined,
  mode: "none",
  fired: false,
  reconstructionFails: false,
  reads: 0,
  failSql: "",
}));
vi.mock("@libsql/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@libsql/client")>();
  return {
    ...actual,
    createClient: (...args: Parameters<typeof actual.createClient>) => {
      const client = actual.createClient(...args),
        execute = client.execute.bind(client);
      let read = false;
      client.execute = async (
        statement: InStatement | string,
        ...rest: unknown[]
      ) => {
        const query = typeof statement === "string" ? statement : statement.sql;
        if (query === "BEGIN TRANSACTION READONLY") {
          read = true;
          fault.reads++;
        }
        if (query === "BEGIN IMMEDIATE") read = false;
        if (fault.failSql && query === fault.failSql) {
          fault.failSql = "";
          throw new Error("native reset witness");
        }
        if (fault.gateSql && query.startsWith(fault.gateSql)) {
          fault.entered?.();
          await fault.released;
        }
        if (
          read &&
          fault.reconstructionFails &&
          query.startsWith("SELECT id, schema, origin, family")
        )
          throw new Error("reconstruction witness");
        const target =
          !read && query === "COMMIT" && fault.mode !== "none" && !fault.fired;
        if (target && fault.mode === "before") {
          fault.fired = true;
          throw new Error("commit witness");
        }
        const result = await execute(statement, ...(rest as []));
        if (target && fault.mode === "after") {
          fault.fired = true;
          throw new Error("commit witness");
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
let storage: Awaited<ReturnType<typeof createSqliteStorage>>;

const sweepTrash = (cutoff: string): Promise<number> =>
  new TrashPurger(
    storage,
    1,
    () => new Date(Date.parse(cutoff) + 86_400_000),
  ).runOnce();
let path: string;
const schema = {
  id: "example.read",
  version: 1,
  fields: { title: { type: "string" as const } },
};
const destination = { ...schema, id: "example.destination" };
beforeEach(async () => {
  path = mkdtempSync(join(tmpdir(), "marfa-read-snapshots-"));
  storage = await createSqliteStorage(join(path, "test.db"));
  await storage.types.create(schema);
  await storage.types.create(destination);
});
afterEach(async () => {
  fault.gateSql = "";
  fault.entered = undefined;
  fault.released = undefined;
  fault.mode = "none";
  fault.fired = false;
  fault.reconstructionFails = false;
  fault.failSql = "";
  await storage.close();
  rmSync(path, { recursive: true, force: true });
});
const generation = () => storage.settings.get(STRUCTURAL_GENERATION_KEY);
const item = () =>
  itemWrites(storage).create({
    writer: null,
    type: schema.id,
    properties: { title: "before" },
  });

it("READONLY alone permits mutation, while query_only supplies the native write backstop", async () => {
  const native = createClient({ url: `file:${join(path, "test.db")}` });
  try {
    await native.execute("BEGIN IMMEDIATE");
    await native.execute(
      "INSERT INTO settings (key,value) VALUES ('native.witness','yes')",
    );
    await native.execute("COMMIT");
    await native.execute("BEGIN TRANSACTION READONLY");
    await native.execute(
      "UPDATE settings SET value='readonly-wrote' WHERE key='native.witness'",
    );
    expect(
      (
        await native.execute(
          "SELECT value FROM settings WHERE key='native.witness'",
        )
      ).rows[0]?.value,
    ).toBe("readonly-wrote");
    await native.execute("ROLLBACK");
    await native.execute("PRAGMA query_only = ON");
    await native.execute("BEGIN TRANSACTION READONLY");
    await expect(
      native.execute(
        "UPDATE settings SET value='no' WHERE key='native.witness'",
      ),
    ).rejects.toThrow();
    expect(
      (
        await native.execute(
          "SELECT value FROM settings WHERE key='native.witness'",
        )
      ).rows[0]?.value,
    ).toBe("yes");
    await native.execute("ROLLBACK");
  } finally {
    native.close();
  }
});

it("an ungated reader reproduces mixed SQL and runtime views without a generation change", async () => {
  const native = createClient({ url: `file:${join(path, "test.db")}` });
  const before = await generation();
  try {
    await native.execute("BEGIN TRANSACTION READONLY");
    await native.execute("SELECT value FROM settings");
    await storage.types.update(schema.id, {
      ...schema,
      fields: { required: { type: "string", required: true } },
    });
    const row = (
      await native.execute({
        sql: "SELECT schema FROM types WHERE id=?",
        args: [schema.id],
      })
    ).rows[0]!;
    expect(JSON.parse(row.schema as string)).toEqual(schema);
    expect(getTypeSchema(schema.id)?.fields).toHaveProperty("required");
    expect(await generation()).toBe(before);
    await native.execute("ROLLBACK");
  } finally {
    native.close();
  }
});

it("a captured reader stays old across a writer commit and a subsequent capture sees new SQL and registry", async () => {
  const created = await item(),
    entered = gate(),
    release = gate();
  const oldGeneration = await generation();
  const reading = storage.runInReadSnapshot(async (pin) => {
    expect(await storage.items.get(created.id)).toMatchObject({
      type: schema.id,
    });
    expect(validateProperties(schema.id, { title: "before" }).success).toBe(
      true,
    );
    expect(
      validateProperties(schema.id, { title: "before" }, { strict: true })
        .success,
    ).toBe(true);
    entered.resolve();
    await release.promise;
    expect(getTypeSchema(schema.id)).toEqual(schema);
    expect(
      (await storage.types.loadAll()).find((row) => row.schema.id === schema.id)
        ?.schema,
    ).toEqual(schema);
    expect(await storage.items.get(created.id)).toMatchObject({
      type: schema.id,
      properties: { title: "before" },
    });
    return pin;
  });
  await entered.promise;
  await storage.runInTransaction(async () => {
    await storage.types.update(schema.id, {
      ...schema,
      fields: { required: { type: "string", required: true } },
    });
    await itemWrites(storage).update(created.id, {
      writer: null,
      type: destination.id,
      properties: { title: "after" },
    });
  });
  release.resolve();
  expect((await reading).structuralGeneration).toBe(oldGeneration);
  await storage.runInReadSnapshot(async (pin) => {
    expect(pin.structuralGeneration).not.toBe(oldGeneration);
    expect(getTypeSchema(schema.id)?.fields).toHaveProperty("required");
    expect(await storage.items.get(created.id)).toMatchObject({
      type: destination.id,
      properties: { title: "after" },
    });
  });
});

it("retained store methods bind their original SQL and registry scopes in another async context", async () => {
  const entered = gate(),
    release = gate();
  let read!: typeof storage.settings.get;
  let write!: typeof storage.settings.set;
  let readType!: typeof storage.types.get;
  await storage.settings.set("capability.probe", "old");
  const reading = storage.runInReadSnapshot(async () => {
    read = storage.settings.get.bind(storage.settings);
    write = storage.settings.set.bind(storage.settings);
    readType = storage.types.get.bind(storage.types);
    entered.resolve();
    await release.promise;
    expect(await storage.settings.get("capability.probe")).toBe("old");
  });
  try {
    await entered.promise;
    await storage.settings.set("capability.probe", "new");
    await storage.types.update(schema.id, { ...schema, version: 2 });
    const detachedRead = await read("capability.probe");
    const detachedType = await readType(schema.id);
    const escapedWrite = await write("capability.escape", "wrote").then(
      () => "succeeded",
      () => "refused",
    );
    expect({ detachedRead, detachedType, escapedWrite }).toEqual({
      detachedRead: "old",
      detachedType: schema,
      escapedWrite: "refused",
    });
    expect(await storage.settings.get("capability.escape")).toBeNull();
    await storage.runInReadSnapshot(async () => {
      expect(await read("capability.probe")).toBe("old");
      expect(await readType(schema.id)).toEqual(schema);
      expect(await storage.settings.get("capability.probe")).toBe("new");
      expect(await storage.types.get(schema.id)).toMatchObject({ version: 2 });
    });
  } finally {
    release.resolve();
    await reading;
  }
  expect(() => read("capability.probe")).toThrow("unavailable");
  expect(() => write("capability.escape", "closed")).toThrow("unavailable");
  expect(() => readType(schema.id)).toThrow("unavailable");
});

it("retained registry forEach passes a captured map to callbacks in another async context", async () => {
  const entered = gate(),
    release = gate();
  const map = registryMapFacet("custom");
  let forEach!: typeof map.forEach;
  let retainedMap!: typeof map;
  const reading = storage.runInReadSnapshot(async () => {
    forEach = map.forEach.bind(map);
    entered.resolve();
    await release.promise;
  });
  try {
    await entered.promise;
    await storage.types.update(schema.id, { ...schema, version: 2 });
    forEach((value, key, selectedMap) => {
      if (key !== schema.id) return;
      retainedMap = selectedMap;
      expect(selectedMap.get(key)).toEqual(value);
      expect(value).toEqual(schema);
    });
    expect(retainedMap.get(schema.id)).toEqual(schema);
    expect(map.get(schema.id)).toMatchObject({ version: 2 });
  } finally {
    release.resolve();
    await reading;
  }
  expect(() => retainedMap.get(schema.id)).toThrow("unavailable");
});

it("retained system forEach passes a captured set to callbacks in another async context", async () => {
  const entered = gate(),
    release = gate();
  const platform = { ...schema, id: "system.snapshot-probe" };
  await storage.types.seedPlatformTypes([
    { schema: platform, family: "system" },
  ]);
  let forEach!: typeof SYSTEM_TYPE_IDS.forEach;
  let retainedSet!: typeof SYSTEM_TYPE_IDS;
  const reading = storage.runInReadSnapshot(async () => {
    forEach = SYSTEM_TYPE_IDS.forEach.bind(SYSTEM_TYPE_IDS);
    entered.resolve();
    await release.promise;
  });
  try {
    await entered.promise;
    expect(await storage.types.deletePlatformType(platform.id)).toBe(true);
    forEach((value, key, selectedSet) => {
      if (key !== platform.id) return;
      retainedSet = selectedSet;
      expect(selectedSet.has(value)).toBe(true);
    });
    expect(retainedSet.has(platform.id)).toBe(true);
    expect(SYSTEM_TYPE_IDS.has(platform.id)).toBe(false);
  } finally {
    release.resolve();
    await reading;
  }
  expect(() => retainedSet.has(platform.id)).toThrow("unavailable");
});

it("capture waits for an earlier writer and later writers cannot overtake its settings pin", async () => {
  const entered = gate(),
    release = gate(),
    pinEntered = gate(),
    pinRelease = gate();
  const writer = storage.runInTransaction(async () => {
    await storage.types.update(schema.id, {
      ...schema,
      parent: destination.id,
    });
    entered.resolve();
    await release.promise;
  });
  await entered.promise;
  fault.gateSql = "SELECT key, value FROM settings WHERE key IN";
  fault.entered = pinEntered.resolve;
  fault.released = pinRelease.promise;
  const reader = storage.runInReadSnapshot(() => getTypeSchema(schema.id));
  let later = false;
  const laterWriter = storage.runInTransaction(() => {
    later = true;
  });
  release.resolve();
  await writer;
  await pinEntered.promise;
  expect(later).toBe(false);
  pinRelease.resolve();
  expect(await reader).toMatchObject({ parent: destination.id });
  await laterWriter;
  expect(later).toBe(true);
});

it("read scopes reject mutations, writer nesting, retained queries, map methods and iterators", async () => {
  let query!: ReturnType<
    NonNullable<ReturnType<typeof sqliteRequestContext.getStore>>["tx"]["all"]
  >;
  let next!: () => unknown, lookup!: (id: string) => unknown;
  let systemLookup!: (id: string) => boolean,
    edgeLookup!: (id: string) => unknown;
  let validator!: () => unknown,
    derivedValidator!: () => unknown,
    fieldValidator!: () => unknown;
  let emptyReader!: () => unknown;
  await storage.runInReadSnapshot(async (pin) => {
    const tx = sqliteRequestContext.getStore()!.tx;
    expect(() => {
      registerTypeSchema(destination);
    }).toThrow("cannot mutate");
    expect(() => {
      seedPlatformTypes([]);
    }).toThrow("cannot mutate");
    expect(() => createRegistryFrame()).toThrow("cannot mutate");
    await expect(storage.runInTransaction(() => undefined)).rejects.toThrow(
      "cannot write",
    );
    await expect(tx.transaction(() => Promise.resolve())).rejects.toThrow(
      "cannot control",
    );
    await expect(
      tx.run(sql`UPDATE settings SET value='bad'`),
    ).rejects.toMatchObject({
      cause: { message: "A read snapshot only executes queries" },
    });
    validateProperties(schema.id, { title: "before" });
    validator = registryView()
      .permissive.get(schema.id)!
      .safeParse.bind(registryView().permissive.get(schema.id)!, {
        title: "before",
      });
    const cached = registryView().permissive.get(schema.id)!;
    const derived = cached.optional();
    derivedValidator = derived.safeParse.bind(derived, { title: "before" });
    const field = (
      cached as unknown as {
        shape: Record<string, { safeParse(value: unknown): unknown }>;
      }
    ).shape.title!;
    fieldValidator = field.safeParse.bind(field, "before");
    emptyReader = storage.items.getMany.bind(storage.items, []);
    expect(await emptyReader()).toEqual(new Map());
    systemLookup = SYSTEM_TYPE_IDS.has.bind(SYSTEM_TYPE_IDS);
    edgeLookup = EDGE_TYPE_REGISTRY.get.bind(EDGE_TYPE_REGISTRY);
    expect(getEdgeTypeSchema("about")).toBeTruthy();
    const map = registryView().custom;
    lookup = map.get.bind(map);
    const iterator = map.values();
    next = iterator.next.bind(iterator);
    expect(next()).toMatchObject({ done: false });
    query = tx.all(sql`SELECT value FROM settings`);
    expect(await storage.runInReadSnapshot((nested) => nested)).toBe(pin);
    expect(Object.isFrozen(getTypeSchema(schema.id)?.fields)).toBe(true);
  });
  await expect(query).rejects.toMatchObject({
    cause: { message: "The read snapshot is unavailable" },
  });
  expect(() => next()).toThrow("unavailable");
  expect(() => lookup(schema.id)).toThrow("unavailable");
  expect(() => validator()).toThrow("unavailable");
  expect(() => derivedValidator()).toThrow("unavailable");
  expect(() => fieldValidator()).toThrow("unavailable");
  expect(() => emptyReader()).toThrow("unavailable");
  expect(() => systemLookup("system.person")).toThrow("unavailable");
  expect(() => edgeLookup("about")).toThrow("unavailable");
  expect(TYPE_REGISTRY.size).toBeGreaterThan(0);
  await storage.runInTransaction(() => storage.settings.set("healthy", "yes"));
});

it("one root bumps once for retype, topology, registration and silent removal, while ordinary controls leave it alone", async () => {
  const created = await item(),
    old = await generation();
  await itemWrites(storage).update(created.id, {
    writer: null,
    properties: { title: "ordinary" },
    tier: "feed",
    source_id: "ordinary-source-id",
  });
  await itemWrites(storage).transition(created.id, "trashed");
  expect(await generation()).toBe(old);
  await itemWrites(storage).restore(created.id);
  expect(await generation()).toBe(old);
  await storage.metadata.set(created.id, ["ordinary"]);
  await storage.types.update(schema.id, { ...schema, version: 2 });
  expect(await generation()).toBe(old);
  await storage.runInTransaction(async () => {
    await itemWrites(storage).update(created.id, {
      writer: null,
      type: destination.id,
      properties: { title: "move" },
    });
    await storage.types.update(schema.id, {
      ...schema,
      parent: destination.id,
    });
    await storage.types.create({ ...schema, id: "example.third" });
  });
  expect(await generation()).toBe((BigInt(old!) + 1n).toString());
  const held = await generation();
  await expect(
    storage.runInTransaction(async () => {
      await storage.types.delete("example.third");
      throw new Error("rollback witness");
    }),
  ).rejects.toThrow("rollback witness");
  expect(await generation()).toBe(held);
  await storage.types.delete("example.missing");
  expect(await generation()).toBe(held);
  await itemWrites(storage).transition(created.id, "trashed");
  expect(await sweepTrash("9999-12-31T00:00:00.000Z")).toBe(1);
  expect(await generation()).toBe((BigInt(held!) + 1n).toString());
  expect(await sweepTrash("9999-12-31T00:00:00.000Z")).toBe(0);
  expect(await generation()).toBe((BigInt(held!) + 1n).toString());
});

it.each(["before", "after"])(
  "generation-only %s-COMMIT uncertainty reconstructs before queued capture",
  async (mode) => {
    const created = await item(),
      old = await generation();
    fault.mode = mode;
    await expect(
      itemWrites(storage).update(created.id, {
        writer: null,
        type: destination.id,
        properties: { title: "move" },
      }),
    ).rejects.toThrow("commit witness");
    await storage.runInReadSnapshot(async (pin) => {
      expect(pin.structuralGeneration).toBe(
        mode === "after" ? (BigInt(old!) + 1n).toString() : old,
      );
      expect((await storage.items.get(created.id))?.type).toBe(
        mode === "after" ? destination.id : schema.id,
      );
    });
  },
);

it("a failed precommit bump rolls back SQL and releases admission for a healthy writer", async () => {
  const created = await item();
  await storage.__sqliteRun("UPDATE settings SET value=? WHERE key=?", [
    "9223372036854775807",
    STRUCTURAL_GENERATION_KEY,
  ]);
  await expect(
    itemWrites(storage).update(created.id, {
      writer: null,
      type: destination.id,
      properties: { title: "move" },
    }),
  ).rejects.toThrow("exhausted");
  expect((await storage.items.get(created.id))?.type).toBe(schema.id);
  await storage.runInTransaction(() => storage.settings.set("healthy", "yes"));
  expect(await storage.settings.get("healthy")).toBe("yes");
});

it("cancellation before admission prevents late capture and preserves FIFO for a healthy writer", async () => {
  const entered = gate(),
    release = gate(),
    cancelled = new AbortController();
  const writer = storage.runInTransaction(async () => {
    entered.resolve();
    await release.promise;
  });
  await entered.promise;
  const reads = fault.reads;
  let callback = false;
  const reader = storage.runInReadSnapshot(
    () => {
      callback = true;
    },
    { signal: cancelled.signal },
  );
  cancelled.abort();
  await expect(reader).rejects.toThrow("unavailable");
  const healthy = storage.runInTransaction(() =>
    storage.settings.set("healthy", "yes"),
  );
  release.resolve();
  await writer;
  await healthy;
  expect(callback).toBe(false);
  expect(fault.reads).toBe(reads);
});

it("a shorter nested deadline abandons the entire read and cannot be extended by a later nested option", async () => {
  await expect(
    storage.runInReadSnapshot(async () => {
      await storage.runInReadSnapshot(() => undefined, {
        deadlineAt: Date.now() + 10,
      });
      await storage.runInReadSnapshot(() => new Promise(() => undefined), {
        deadlineAt: Date.now() + 10000,
      });
    }),
  ).rejects.toThrow("unavailable");
  await storage.runInReadSnapshot((pin) => {
    expect(pin.instanceId).toBeTruthy();
  });
});

it("source movement bumps, target-only movement and ordinary edge writes do not", async () => {
  const first = await item(),
    second = await item(),
    third = await item();
  const edgeSchema = {
    id: "example.read-edge",
    cardinality: "many-to-many" as const,
    cascade_on_delete: "orphan" as const,
    property_schema: {},
    written_at: "source" as const,
    source_type_constraints: ["*"],
    target_type_constraints: ["*"],
  };
  const beforeRegistration = await generation();
  await storage.edgeTypes.create(edgeSchema);
  expect(await generation()).toBe(
    (BigInt(beforeRegistration!) + 1n).toString(),
  );
  const edge = await storage.edges.createRaw({
    edge_type: edgeSchema.id,
    source_id: first.id,
    target_id: second.id,
    properties: {},
  });
  const held = await generation();
  await storage.edges.updateProperties(
    edge.id,
    {},
    undefined,
    {
      source_id: first.id,
      target_id: third.id,
    },
    null,
  );
  expect(await generation()).toBe(held);
  const refused = await storage.edges.updateProperties(
    edge.id,
    {},
    999,
    {
      source_id: second.id,
      target_id: third.id,
    },
    null,
  );
  expect(refused.ok).toBe(false);
  expect(await generation()).toBe(held);
  await storage.edges.updateProperties(
    edge.id,
    {},
    undefined,
    {
      source_id: second.id,
      target_id: third.id,
    },
    null,
  );
  expect(await generation()).toBe((BigInt(held!) + 1n).toString());
  const moved = await generation();
  await storage.edges.delete(edge.id);
  expect(await generation()).toBe(moved);
  await storage.edgeTypes.delete(edgeSchema.id);
  expect(await generation()).toBe((BigInt(moved!) + 1n).toString());
  const deleted = await generation();
  await storage.edgeTypes.delete(edgeSchema.id);
  expect(await generation()).toBe(deleted);
});

it("rolled-back child structural flags do not bump a healthy parent", async () => {
  const created = await item(),
    held = await generation();
  await storage.runInTransaction(async () => {
    await expect(
      storage.runInTransaction(async () => {
        await itemWrites(storage).update(created.id, {
          writer: null,
          type: destination.id,
          properties: { title: "move" },
        });
        throw new Error("child rollback witness");
      }),
    ).rejects.toThrow("child rollback witness");
    await storage.settings.set("healthy", "yes");
  });
  expect(await generation()).toBe(held);
  expect((await storage.items.get(created.id))?.type).toBe(schema.id);
});

it("canceling a pending pin releases admission, never enters the body and retains cleanup ownership", async () => {
  const entered = gate(),
    release = gate(),
    cancelled = new AbortController();
  fault.gateSql = "SELECT key, value FROM settings WHERE key IN";
  fault.entered = entered.resolve;
  fault.released = release.promise;
  let body = false;
  const reading = storage.runInReadSnapshot(
    () => {
      body = true;
    },
    { signal: cancelled.signal },
  );
  const rejected = expect(reading).rejects.toThrow("unavailable");
  await entered.promise;
  cancelled.abort();
  await rejected;
  await storage.runInTransaction(() => storage.settings.set("healthy", "yes"));
  expect(body).toBe(false);
  release.resolve();
  fault.gateSql = "";
  await storage.runInReadSnapshot((pin) => {
    expect(pin.instanceId).toBeTruthy();
  });
  expect(body).toBe(false);
});

it("canceling after the body or during rollback never returns the detached result", async () => {
  const cancelled = new AbortController();
  await expect(
    storage.runInReadSnapshot(
      () => {
        cancelled.abort();
        return "late";
      },
      { signal: cancelled.signal },
    ),
  ).rejects.toThrow("unavailable");
  const entered = gate(),
    release = gate(),
    rollbackCancelled = new AbortController();
  fault.gateSql = "ROLLBACK";
  fault.entered = entered.resolve;
  fault.released = release.promise;
  const reading = storage.runInReadSnapshot(() => "late", {
    signal: rollbackCancelled.signal,
  });
  const rejected = expect(reading).rejects.toThrow("unavailable");
  await entered.promise;
  rollbackCancelled.abort();
  await rejected;
  await storage.runInTransaction(() => storage.settings.set("healthy", "yes"));
  release.resolve();
  fault.gateSql = "";
  await storage.runInReadSnapshot(() => undefined);
});

it("abandoned executing reads occupy the eight leases until cleanup settles, with eight bounded slot waiters", async () => {
  const entered = gate(),
    release = gate();
  const before = fault.reads;
  let executions = 0;
  fault.gateSql = 'select "value" from "settings"';
  fault.entered = () => {
    if (++executions === 8) entered.resolve();
  };
  fault.released = release.promise;
  const controllers = Array.from({ length: 8 }, () => new AbortController());
  const busy = controllers.map((controller) =>
    storage
      .runInReadSnapshot(() => storage.settings.get("capacity.witness"), {
        signal: controller.signal,
      })
      .catch((error: unknown) => error),
  );
  await entered.promise;
  for (const controller of controllers) controller.abort();
  expect(
    (await Promise.all(busy)).every((error) => error instanceof Error),
  ).toBe(true);
  const waitControllers = Array.from(
    { length: 8 },
    () => new AbortController(),
  );
  const waiting = waitControllers.map((controller) =>
    storage
      .runInReadSnapshot(() => "late", { signal: controller.signal })
      .catch((error: unknown) => error),
  );
  await expect(storage.runInReadSnapshot(() => "overflow")).rejects.toThrow(
    "unavailable",
  );
  expect(fault.reads).toBe(before + 8);
  await storage.runInTransaction(() => storage.settings.set("healthy", "yes"));
  for (const controller of waitControllers) controller.abort();
  expect(
    (await Promise.all(waiting)).every((error) => error instanceof Error),
  ).toBe(true);
  release.resolve();
  fault.gateSql = "";
  await storage.runInReadSnapshot((pin) => {
    expect(pin.instanceId).toBeTruthy();
  });
});

it("storage close waits for executing native work before rollback and never returns late proof", async () => {
  const entered = gate(),
    release = gate();
  fault.gateSql = 'select "value" from "settings"';
  fault.entered = entered.resolve;
  fault.released = release.promise;
  const reading = storage.runInReadSnapshot(() =>
    storage.settings.get("close.witness"),
  );
  const rejected = expect(reading).rejects.toThrow("unavailable");
  await entered.promise;
  let closed = false;
  const closing = storage.close().then(() => {
    closed = true;
  });
  await rejected;
  expect(closed).toBe(false);
  release.resolve();
  fault.gateSql = "";
  await closing;
  expect(closed).toBe(true);
});

it("failed generation-only reconstruction stays unavailable until boot validates the durable state", async () => {
  const created = await item(),
    held = await generation();
  fault.mode = "after";
  fault.reconstructionFails = true;
  await expect(
    itemWrites(storage).update(created.id, {
      writer: null,
      type: destination.id,
      properties: { title: "move" },
    }),
  ).rejects.toThrow("commit witness");
  await expect(storage.runInReadSnapshot(() => undefined)).rejects.toThrow(
    "unavailable",
  );
  fault.mode = "none";
  fault.reconstructionFails = false;
  await storage.close();
  storage = await createSqliteStorage(join(path, "test.db"));
  await storage.runInReadSnapshot(async (pin) => {
    expect(pin.structuralGeneration).toBe((BigInt(held!) + 1n).toString());
    expect((await storage.items.get(created.id))?.type).toBe(destination.id);
  });
});

it.each(["before", "after"])(
  "generation-only %s-COMMIT holds queued capture until reconstruction finishes",
  async (mode) => {
    const created = await item(),
      held = await generation();
    const bodyEntered = gate(),
      bodyRelease = gate(),
      entered = gate(),
      release = gate();
    fault.mode = mode;
    fault.gateSql = "SELECT id, schema, origin, family FROM types";
    fault.entered = entered.resolve;
    fault.released = release.promise;
    const writer = storage.runInTransaction(async () => {
      await itemWrites(storage).update(created.id, {
        writer: null,
        type: destination.id,
        properties: { title: "move" },
      });
      bodyEntered.resolve();
      await bodyRelease.promise;
    });
    const rejected = expect(writer).rejects.toThrow("commit witness");
    await bodyEntered.promise;
    let captured = false;
    const reading = storage.runInReadSnapshot(async (pin) => {
      captured = true;
      expect(pin.structuralGeneration).toBe(
        mode === "after" ? (BigInt(held!) + 1n).toString() : held,
      );
      expect((await storage.items.get(created.id))?.type).toBe(
        mode === "after" ? destination.id : schema.id,
      );
    });
    bodyRelease.resolve();
    await entered.promise;
    expect(captured).toBe(false);
    await expect(storage.runInReadSnapshot(() => "late")).rejects.toThrow(
      "unavailable",
    );
    release.resolve();
    fault.gateSql = "";
    await rejected;
    await reading;
    expect(captured).toBe(true);
  },
);

it("precommit seals escaped writers before the generation flush can await", async () => {
  const entered = gate(),
    release = gate(),
    escapedRelease = gate();
  const created = await item();
  fault.gateSql = "SELECT value FROM settings WHERE key = ?";
  fault.entered = entered.resolve;
  fault.released = release.promise;
  let escaped!: Promise<void>;
  const writer = storage.runInTransaction(async () => {
    await itemWrites(storage).update(created.id, {
      writer: null,
      type: destination.id,
      properties: { title: "move" },
    });
    const tx = sqliteRequestContext.getStore()!.tx;
    escaped = (async () => {
      await escapedRelease.promise;
      expect(() => {
        markStructuralReadChange();
      }).toThrow("context is closed");
      expect(() => {
        registerTypeSchema({ ...schema, id: "example.escaped" });
      }).toThrow("context is closed");
      await expect(
        tx.run(sql`INSERT INTO settings (key,value) VALUES ('escaped','bad')`),
      ).rejects.toThrow();
      await expect(storage.runInTransaction(() => undefined)).rejects.toThrow(
        "context is closed",
      );
    })();
  });
  await entered.promise;
  escapedRelease.resolve();
  await escaped;
  release.resolve();
  fault.gateSql = "";
  await writer;
  expect(await storage.settings.get("escaped")).toBeNull();
  expect(getTypeSchema("example.escaped")).toBeUndefined();
});

it("native query_only reset failure discards the lease without certifying or poisoning the next writer", async () => {
  const entered = gate(),
    release = gate();
  const reading = storage.runInReadSnapshot(async () => {
    entered.resolve();
    await release.promise;
    return "late";
  });
  await entered.promise;
  fault.failSql = "PRAGMA query_only = OFF";
  const rejected = expect(reading).rejects.toThrow("native reset witness");
  release.resolve();
  await rejected;
  await storage.runInTransaction(() => storage.settings.set("healthy", "yes"));
  expect(await storage.settings.get("healthy")).toBe("yes");
  await storage.runInReadSnapshot(() => undefined);
});

it.each(["-1", "01", "9223372036854775808", "invalid"])(
  "invalid durable generation %s is never repaired by a read or accepted by boot",
  async (invalid) => {
    const previous = await generation();
    await storage.__sqliteRun("UPDATE settings SET value=? WHERE key=?", [
      invalid,
      STRUCTURAL_GENERATION_KEY,
    ]);
    await expect(storage.runInReadSnapshot(() => "late")).rejects.toThrow(
      "generation is unavailable",
    );
    expect(await generation()).toBe(invalid);
    await expect(createSqliteStorage(join(path, "test.db"))).rejects.toThrow(
      "generation is unavailable",
    );
    await storage.__sqliteRun("UPDATE settings SET value=? WHERE key=?", [
      previous,
      STRUCTURAL_GENERATION_KEY,
    ]);
    await storage.runInReadSnapshot((pin) => {
      expect(pin.structuralGeneration).toBe(previous);
    });
  },
);

it("missing generation and instance identity refuse capture without creating a row", async () => {
  const previous = await generation(),
    instance = await storage.settings.get("instance.id");
  await storage.__sqliteRun("DELETE FROM settings WHERE key=?", [
    STRUCTURAL_GENERATION_KEY,
  ]);
  await expect(storage.runInReadSnapshot(() => "late")).rejects.toThrow(
    "generation is unavailable",
  );
  expect(await generation()).toBeNull();
  await storage.__sqliteRun("INSERT INTO settings (key,value) VALUES (?,?)", [
    STRUCTURAL_GENERATION_KEY,
    previous,
  ]);
  await storage.__sqliteRun("DELETE FROM settings WHERE key='instance.id'", []);
  await expect(storage.runInReadSnapshot(() => "late")).rejects.toThrow(
    "identity is unavailable",
  );
  expect(await storage.settings.get("instance.id")).toBeNull();
  await storage.__sqliteRun(
    "INSERT INTO settings (key,value) VALUES ('instance.id',?)",
    [instance],
  );
});

it("storage close shares a pending rollback instead of releasing or recycling its lease early", async () => {
  const entered = gate(),
    release = gate();
  fault.gateSql = "ROLLBACK";
  fault.entered = entered.resolve;
  fault.released = release.promise;
  const reading = storage.runInReadSnapshot(() => "late");
  const rejected = expect(reading).rejects.toThrow("unavailable");
  await entered.promise;
  let closed = false;
  const closing = storage.close().then(() => {
    closed = true;
  });
  await rejected;
  expect(closed).toBe(false);
  release.resolve();
  fault.gateSql = "";
  await closing;
  expect(closed).toBe(true);
});
