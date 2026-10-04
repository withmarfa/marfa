import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import {
  getTypeSchema,
  registerTypeSchema,
  unregisterTypeSchema,
} from "@withmarfa/shared";
import type { TypeSchema } from "@withmarfa/shared";
import { createTestContext, request } from "../test-utils.js";
import type { TestContext } from "../test-utils.js";
import { VersionThinner } from "./version-thinner.js";
import type { ResolvedPolicy } from "./version-thinning.js";

const logged = vi.hoisted(() => ({
  calls: [] as { level: string; message: string }[],
}));
vi.mock("../middleware/logger.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../middleware/logger.js")>();
  return {
    ...actual,
    log: (level: string, message: string, ...rest: unknown[]) => {
      logged.calls.push({ level, message });
      (actual.log as (...a: unknown[]) => void)(level, message, ...rest);
    },
  };
});

const SHORT: ResolvedPolicy = {
  recentDays: 1,
  dailySnapshotDays: 2,
  weeklySnapshotDays: 3,
  maxVersions: 100,
};
const SHORT_POLICY = {
  recent_days: 1,
  daily_snapshot_days: 2,
  weekly_snapshot_days: 3,
  max_versions: 100,
};
const YEAR = {
  recent_days: 365,
  daily_snapshot_days: 365,
  weekly_snapshot_days: 365,
  max_versions: 100,
};

let ctx: TestContext;
let sequence = 0;

beforeAll(async () => {
  ctx = await createTestContext();
});

afterAll(async () => {
  await ctx.cleanup();
});

beforeEach(() => {
  logged.calls.length = 0;
});

function uniqueType(label: string): string {
  return `test.thin_${label}_${String(++sequence)}`;
}

async function register(
  id: string,
  options: { parent?: string; version_policy?: object } = {},
): Promise<void> {
  const res = await request(ctx.app, "POST", "/types", {
    key: ctx.workingKey,
    body: {
      id,
      version: 1,
      fields: { [`f_${id.replaceAll(".", "_")}`]: { type: "string" } },
      ...(options.parent !== undefined && { parent: options.parent }),
      ...(options.version_policy !== undefined && {
        version_policy: options.version_policy,
      }),
    },
  });
  expect(res.status, await res.clone().text()).toBe(201);
}

async function replacePolicy(
  id: string,
  version_policy: object,
): Promise<void> {
  const current = (await (
    await request(ctx.app, "GET", `/types/${id}`, { key: ctx.workingKey })
  ).json()) as TypeSchema;
  const res = await request(ctx.app, "PUT", `/types/${id}`, {
    key: ctx.workingKey,
    body: { ...current, version_policy },
  });
  expect(res.status, await res.clone().text()).toBe(200);
}

/** An item of `type` with `count` stored snapshots, oldest first. */
async function itemWithHistory(type: string, count = 3): Promise<string> {
  const field = `f_${type.replaceAll(".", "_")}`;
  const created = await request(ctx.app, "POST", "/items", {
    key: ctx.workingKey,
    body: { type, properties: { [field]: "v1" } },
  });
  expect(created.status, await created.clone().text()).toBe(201);
  const { item } = (await created.json()) as {
    item: { id: string; version: number };
  };
  for (let n = 2; n <= count + 1; n++) {
    const patched = await request(ctx.app, "PATCH", `/items/${item.id}`, {
      key: ctx.workingKey,
      body: { properties: { [field]: `v${String(n)}` }, version: n - 1 },
    });
    expect(patched.status, await patched.clone().text()).toBe(200);
  }
  expect(await ctx.storage.versions.all(item.id)).toHaveLength(count);
  return item.id;
}

async function ageVersion(
  itemId: string,
  version: number,
  days: number,
): Promise<void> {
  const raw = ctx.storage as unknown as {
    __sqliteRun: (sql: string, params: unknown[]) => Promise<unknown>;
  };
  const at = new Date(Date.now() - days * 86_400_000).toISOString();
  await raw.__sqliteRun(
    "UPDATE versions SET created_at = ?, occurred_at = ? WHERE item_id = ? AND version = ?",
    [at, at, itemId, version],
  );
}

async function versionNumbers(itemId: string): Promise<number[]> {
  return (await ctx.storage.versions.all(itemId)).map((v) => v.version);
}

/** Runs `change` before the first transaction the app opens after this is
 *  called. That is the thinner's first deleting transaction: it lists
 *  candidates and first judges each one outside any transaction, so `change`
 *  lands after that judgement and before the one that deletes. */
function raceTheNextTransaction(change: () => Promise<void>): {
  fired: () => boolean;
  restore: () => void;
} {
  const storage = ctx.storage;
  const original = storage.runInTransaction.bind(storage);
  let fired = false;
  storage.runInTransaction = async <T>(
    fn: () => T | Promise<T>,
  ): Promise<T> => {
    if (!fired) {
      fired = true;
      await change();
    }
    return await original(fn);
  };
  return {
    fired: () => fired,
    restore: () => {
      storage.runInTransaction = original;
    },
  };
}

describe("thinning applies the policy the type API returns", () => {
  it("keeps what a policy inherited from the parent retains", async () => {
    const parent = uniqueType("parent");
    const child = uniqueType("child");
    await register(parent, { version_policy: YEAR });
    await register(child, { parent });
    const advertised = (await (
      await request(ctx.app, "GET", `/types/${child}`, { key: ctx.workingKey })
    ).json()) as TypeSchema;
    expect(advertised.version_policy).toEqual(YEAR);

    const id = await itemWithHistory(child);
    await ageVersion(id, 1, 10);

    const result = await new VersionThinner(ctx.storage, SHORT).runOnce();
    expect(result.items).toBeGreaterThan(0);
    expect(await versionNumbers(id)).toEqual([1, 2, 3]);
  });

  it("still thins a type with no policy anywhere by the instance defaults", async () => {
    const parent = uniqueType("bare_parent");
    const child = uniqueType("bare_child");
    await register(parent);
    await register(child, { parent });
    const id = await itemWithHistory(child);
    await ageVersion(id, 1, 10);

    await new VersionThinner(ctx.storage, SHORT).runOnce();
    expect(await versionNumbers(id)).toEqual([2, 3]);
  });

  it("lets a child's own field override the parent's and inherits the rest", async () => {
    const parent = uniqueType("o_parent");
    const child = uniqueType("o_child");
    await register(parent, { version_policy: YEAR });
    await register(child, { parent, version_policy: { max_versions: 2 } });
    const id = await itemWithHistory(child);
    await ageVersion(id, 1, 10);
    await ageVersion(id, 2, 5);

    await new VersionThinner(ctx.storage, SHORT).runOnce();
    // The windows come from the parent, so only the child's cap removes one.
    expect(await versionNumbers(id)).toEqual([2, 3]);
  });

  it("thins by the instance defaults once the type is deleted with force", async () => {
    const type = uniqueType("forced");
    await register(type, { version_policy: YEAR });
    const id = await itemWithHistory(type);
    await ageVersion(id, 1, 10);

    const deleted = await request(
      ctx.app,
      "DELETE",
      `/types/${type}?force=true`,
      { key: ctx.workingKey },
    );
    expect(deleted.status).toBe(200);
    expect(getTypeSchema(type)).toBeUndefined();

    await new VersionThinner(ctx.storage, SHORT).runOnce();
    expect(await versionNumbers(id)).toEqual([2, 3]);
  });
});

describe("thinning honors a type changed after the run began", () => {
  it("keeps what a policy lengthened in the meantime retains", async () => {
    const parent = uniqueType("long_parent");
    const child = uniqueType("long_child");
    await register(parent, { version_policy: SHORT_POLICY });
    await register(child, { parent });
    const id = await itemWithHistory(child);
    await ageVersion(id, 1, 10);

    const race = raceTheNextTransaction(() => replacePolicy(parent, YEAR));
    try {
      await new VersionThinner(ctx.storage, SHORT).runOnce();
    } finally {
      race.restore();
    }
    expect(race.fired()).toBe(true);
    expect(await versionNumbers(id)).toEqual([1, 2, 3]);
  });

  it("removes on the next run what a policy shortened since no longer retains", async () => {
    const parent = uniqueType("cut_parent");
    const child = uniqueType("cut_child");
    await register(parent, { version_policy: YEAR });
    await register(child, { parent });
    const id = await itemWithHistory(child);
    await ageVersion(id, 1, 10);

    const thinner = new VersionThinner(ctx.storage, SHORT);
    await thinner.runOnce();
    expect(await versionNumbers(id)).toEqual([1, 2, 3]);

    await replacePolicy(parent, SHORT_POLICY);
    await thinner.runOnce();
    expect(await versionNumbers(id)).toEqual([2, 3]);
  });
});

describe("an item whose type chain cannot be resolved", () => {
  const looped: string[] = [];

  afterAll(() => {
    for (const id of looped) unregisterTypeSchema(id);
  });

  function loop(a: string, b: string): void {
    const schema = (id: string, parent: string): TypeSchema => ({
      id,
      version: 1,
      parent,
      fields: {},
    });
    registerTypeSchema(schema(a, b));
    registerTypeSchema(schema(b, a));
    looped.push(a, b);
  }

  it("is skipped and named once per run, while the others are still thinned", async () => {
    const a = uniqueType("keep_a");
    const b = uniqueType("keep_b");
    const c = uniqueType("keep_c");
    await register(a);
    await register(b);
    await register(c);
    const first = await itemWithHistory(a, 4);
    const second = await itemWithHistory(a, 3);
    const healthy = await itemWithHistory(c, 3);
    for (const id of [first, second, healthy]) await ageVersion(id, 1, 10);
    loop(a, b);

    logged.calls.length = 0;
    const thinner = new VersionThinner(ctx.storage, SHORT);
    const run = await thinner.runOnce();
    expect(run.pruned).toBeGreaterThan(0);
    expect(await versionNumbers(first)).toEqual([1, 2, 3, 4]);
    expect(await versionNumbers(second)).toEqual([1, 2, 3]);
    expect(await versionNumbers(healthy)).toEqual([2, 3]);
    const named = logged.calls.filter((c) => c.message.includes(a));
    expect(named).toHaveLength(1);

    // A second run does not fail and names it again, once.
    logged.calls.length = 0;
    await thinner.runOnce();
    expect(logged.calls.filter((c) => c.message.includes(a))).toHaveLength(1);
  });
});

describe("a sweep", () => {
  it("removes a long run of snapshots in bounded chunks, one audited transaction each", async () => {
    const type = uniqueType("long_history");
    await register(type);
    const id = await itemWithHistory(type);
    const raw = ctx.storage as unknown as {
      __sqliteRun: (sql: string, params: unknown[]) => Promise<unknown>;
    };
    const old = new Date(Date.now() - 400 * 86_400_000).toISOString();
    for (let n = 4; n <= 453; n++) {
      await raw.__sqliteRun(
        "INSERT INTO versions (id, item_id, version, properties, tier, occurred_at, source_id, type, created_at) SELECT ?, item_id, ?, properties, tier, occurred_at, source_id, type, ? FROM versions WHERE item_id = ? AND version = 1",
        [`${id}-filler-${String(n)}`, n, old, id],
      );
    }
    expect(await ctx.storage.versions.all(id)).toHaveLength(453);

    await new VersionThinner(ctx.storage, SHORT).runOnce();

    // The newest snapshot is never removed, whatever its age.
    expect(await versionNumbers(id)).toEqual([1, 2, 3, 453]);
    const audited = (
      await ctx.storage.audit.list({ action: "item.versions_thinned" })
    ).data.filter((row) => row.resource_id === id);
    expect(
      audited
        .map((row) => row.details.pruned)
        .sort((a, b) => Number(a) - Number(b)),
    ).toEqual([49, 200, 200]);
  });

  it("reaches an item behind more than a page of items that keep their history", async () => {
    const type = uniqueType("many");
    await register(type);
    const ids: string[] = [];
    for (let i = 0; i < 101; i++) ids.push(await itemWithHistory(type));
    const last = ids.at(-1)!;
    await ageVersion(last, 1, 400);

    await new VersionThinner(ctx.storage, SHORT).runOnce();
    expect(await versionNumbers(last)).toEqual([2, 3]);
  });
});
