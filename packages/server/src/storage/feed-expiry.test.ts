import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import {
  registerTypeSchema,
  unregisterTypeSchema,
  type TypeSchema,
} from "@withmarfa/shared";
import { __resetEventLogForTests, initEventLog } from "../pubsub.js";
import { createTestContext, request } from "../test-utils.js";
import type { TestContext } from "../test-utils.js";
import { FeedExpirer } from "./feed-expiry.js";

const DAY = 86_400_000;

let ctx: TestContext;
let t0: number;
let sequence = 0;

beforeEach(async () => {
  ctx = await createTestContext();
  initEventLog(ctx.storage.eventLog);
  t0 = Date.now();
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(t0);
});

afterEach(async () => {
  vi.useRealTimers();
  __resetEventLogForTests();
  await ctx.cleanup();
});

/** The instant `days` after the test began, and `ms` more. */
function at(days: number, ms = 0): void {
  vi.setSystemTime(t0 + days * DAY + ms);
}

function uniqueType(label: string): string {
  return `test.feed_${label}_${String(++sequence)}`;
}

async function declare(
  id: string,
  options: { parent?: string; retention_policy?: object } = {},
): Promise<void> {
  const res = await request(ctx.app, "POST", "/types", {
    key: ctx.workingKey,
    body: {
      id,
      version: 1,
      fields: { title: { type: "string" } },
      ...options,
    },
  });
  expect(res.status, await res.clone().text()).toBe(201);
}

async function replaceRetention(
  id: string,
  retention_policy: object,
): Promise<void> {
  const current = (await (
    await request(ctx.app, "GET", `/types/${id}`, { key: ctx.workingKey })
  ).json()) as TypeSchema;
  const res = await request(ctx.app, "PUT", `/types/${id}`, {
    key: ctx.workingKey,
    body: { ...current, retention_policy },
  });
  expect(res.status, await res.clone().text()).toBe(200);
}

async function add(
  type: string,
  body: Record<string, unknown> = {},
): Promise<string> {
  const res = await request(ctx.app, "POST", "/items", {
    key: ctx.workingKey,
    body: {
      type,
      tier: "feed",
      properties: { title: `item ${String(++sequence)}` },
      ...body,
    },
  });
  expect(res.status, await res.clone().text()).toBe(201);
  return ((await res.json()) as { item: { id: string } }).item.id;
}

async function stateOf(id: string): Promise<string | undefined> {
  return (await ctx.storage.items.getIncludingTrashed(id))?.state;
}

async function trashedAtOf(id: string): Promise<string | null> {
  const raw = ctx.storage as unknown as {
    __sqliteAll: (q: string) => Promise<{ trashed_at: string | null }[]>;
  };
  const rows = await raw.__sqliteAll(
    `SELECT trashed_at FROM items WHERE id = '${id}'`,
  );
  return rows[0]?.trashed_at ?? null;
}

async function link(source: string, target: string): Promise<void> {
  const res = await request(ctx.app, "POST", "/edges", {
    key: ctx.workingKey,
    body: { source_id: source, target_id: target, edge_type: "parent-of" },
  });
  expect(res.status, await res.clone().text()).toBe(201);
}

const run = () => new FeedExpirer(ctx.storage).runOnce();

describe("the window", () => {
  it("moves a feed item to the bin once the days have passed since it arrived", async () => {
    const type = uniqueType("basic");
    await declare(type, { retention_policy: { feed_days: 30 } });
    const feed = await add(type);

    at(29);
    expect((await run()).moved).toBe(0);
    expect(await stateOf(feed)).toBe("active");

    at(31);
    expect((await run()).moved).toBe(1);
    expect(await stateOf(feed)).toBe("trashed");
    expect(await trashedAtOf(feed)).toBe(new Date(t0 + 31 * DAY).toISOString());
  });

  it("keeps an item that has had exactly the days, and moves it a millisecond later", async () => {
    const type = uniqueType("edge");
    await declare(type, { retention_policy: { feed_days: 30 } });
    const feed = await add(type);

    at(30);
    expect((await run()).moved).toBe(0);
    expect(await stateOf(feed)).toBe("active");

    at(30, 1);
    expect((await run()).moved).toBe(1);
    expect(await stateOf(feed)).toBe("trashed");
  });

  it("keeps the items of a type that declares no window, and of one inheriting none", async () => {
    const bare = uniqueType("bare");
    const child = uniqueType("bare_child");
    await declare(bare);
    await declare(child, { parent: bare });
    const kept = [await add(bare), await add(child)];
    // The witness: the same items under a window go.
    const windowed = uniqueType("windowed");
    await declare(windowed, { retention_policy: { feed_days: 1 } });
    const goes = await add(windowed);

    at(1000);
    const report = await run();
    expect(report.moved).toBe(1);
    expect(await stateOf(goes)).toBe("trashed");
    for (const id of kept) expect(await stateOf(id)).toBe("active");
  });

  it("is a window of its own for each type", async () => {
    const short = uniqueType("short");
    const long = uniqueType("long");
    await declare(short, { retention_policy: { feed_days: 2 } });
    await declare(long, { retention_policy: { feed_days: 20 } });
    const a = await add(short);
    const b = await add(long);

    at(5);
    expect((await run()).moved).toBe(1);
    expect(await stateOf(a)).toBe("trashed");
    expect(await stateOf(b)).toBe("active");

    at(21);
    expect((await run()).moved).toBe(1);
    expect(await stateOf(b)).toBe("trashed");
  });

  it("counts from arrival, which a natural-key upsert keeps", async () => {
    const type = uniqueType("upsert");
    await declare(type, { retention_policy: { feed_days: 10 } });
    const first = await add(type, { source_id: "feed/entry-1" });

    at(8);
    const again = await request(ctx.app, "POST", "/items", {
      key: ctx.workingKey,
      body: {
        type,
        tier: "feed",
        source_id: "feed/entry-1",
        properties: { title: "refreshed" },
      },
    });
    expect(again.status, await again.clone().text()).toBeLessThan(300);
    const row = await ctx.storage.items.getIncludingTrashed(first);
    expect(row?.properties.title).toBe("refreshed");
    expect(row?.updated_at).toBe(new Date(t0 + 8 * DAY).toISOString());

    at(11);
    expect((await run()).moved).toBe(1);
    expect(await stateOf(first)).toBe("trashed");
  });
});

describe("inheritance", () => {
  it("passes a window to a child and a grandchild, and lets a child replace it", async () => {
    const root = uniqueType("root");
    const child = uniqueType("child");
    const grandchild = uniqueType("grandchild");
    const quick = uniqueType("quick");
    await declare(root, { retention_policy: { feed_days: 10 } });
    await declare(child, { parent: root });
    await declare(grandchild, { parent: child });
    await declare(quick, {
      parent: child,
      retention_policy: { feed_days: 3 },
    });
    const ids = {
      root: await add(root),
      child: await add(child),
      grandchild: await add(grandchild),
      quick: await add(quick),
    };

    at(5);
    expect((await run()).moved).toBe(1);
    expect(await stateOf(ids.quick)).toBe("trashed");
    for (const id of [ids.root, ids.child, ids.grandchild]) {
      expect(await stateOf(id)).toBe("active");
    }

    at(11);
    expect((await run()).moved).toBe(3);
    for (const id of [ids.root, ids.child, ids.grandchild]) {
      expect(await stateOf(id)).toBe("trashed");
    }
  });

  it("lets a child keep its items with null although the parent expires them", async () => {
    const parent = uniqueType("expiring");
    const keeper = uniqueType("keeper");
    const below = uniqueType("below_keeper");
    await declare(parent, { retention_policy: { feed_days: 5 } });
    await declare(keeper, { parent, retention_policy: { feed_days: null } });
    await declare(below, { parent: keeper });
    const expires = await add(parent);
    const kept = [await add(keeper), await add(below)];

    at(100);
    expect((await run()).moved).toBe(1);
    expect(await stateOf(expires)).toBe("trashed");
    for (const id of kept) expect(await stateOf(id)).toBe("active");
  });

  it("reads the resolved window on the type and the declared one on the list", async () => {
    const parent = uniqueType("read_parent");
    const child = uniqueType("read_child");
    const keeper = uniqueType("read_keeper");
    await declare(parent, { retention_policy: { feed_days: 7 } });
    await declare(child, { parent });
    await declare(keeper, { parent, retention_policy: { feed_days: null } });

    const read = async (id: string): Promise<TypeSchema> =>
      (await (
        await request(ctx.app, "GET", `/types/${id}`, { key: ctx.workingKey })
      ).json()) as TypeSchema;
    expect((await read(child)).retention_policy).toEqual({ feed_days: 7 });
    expect((await read(keeper)).retention_policy).toEqual({ feed_days: null });

    const list = (await (
      await request(ctx.app, "GET", "/types", { key: ctx.workingKey })
    ).json()) as { data?: TypeSchema[]; types?: TypeSchema[] };
    const rows = list.data ?? list.types ?? [];
    expect(rows.find((t) => t.id === child)).not.toHaveProperty(
      "retention_policy",
    );
    expect(rows.find((t) => t.id === parent)?.retention_policy).toEqual({
      feed_days: 7,
    });
    expect(rows.find((t) => t.id === keeper)?.retention_policy).toEqual({
      feed_days: null,
    });
  });

  it("judges an item by the window as it stands when the type changes", async () => {
    const type = uniqueType("changed");
    await declare(type, { retention_policy: { feed_days: 30 } });
    const feed = await add(type);

    at(5);
    expect((await run()).moved).toBe(0);
    await replaceRetention(type, { feed_days: 1 });
    expect((await run()).moved).toBe(1);
    expect(await stateOf(feed)).toBe("trashed");
  });
});

describe("what never expires", () => {
  it("leaves a library item, a feed item beside it going", async () => {
    const type = uniqueType("tiers");
    await declare(type, { retention_policy: { feed_days: 2 } });
    const library = await add(type, { tier: "library" });
    const feed = await add(type);

    at(10);
    expect((await run()).moved).toBe(1);
    expect(await stateOf(feed)).toBe("trashed");
    expect(await stateOf(library)).toBe("active");
  });

  it("leaves a feed item a person archived, an active one beside it going", async () => {
    const type = uniqueType("archived");
    await declare(type, { retention_policy: { feed_days: 2 } });
    const archived = await add(type);
    const active = await add(type);
    const res = await request(
      ctx.app,
      "POST",
      `/items/${archived}/transition`,
      {
        key: ctx.workingKey,
        body: { state: "archived" },
      },
    );
    expect(res.status, await res.clone().text()).toBe(200);

    at(10);
    expect((await run()).moved).toBe(1);
    expect(await stateOf(active)).toBe("trashed");
    expect(await stateOf(archived)).toBe("archived");
  });

  it("leaves a library item derived from a feed item untouched and active", async () => {
    const type = uniqueType("derived");
    await declare(type, { retention_policy: { feed_days: 2 } });
    const feed = await add(type);
    const copy = await add("core.note", {
      tier: "library",
      properties: { body: "a copy someone made" },
    });
    const edge = await request(ctx.app, "POST", "/edges", {
      key: ctx.workingKey,
      body: { source_id: copy, target_id: feed, edge_type: "derived-from" },
    });
    expect(edge.status, await edge.clone().text()).toBe(201);
    const before = await ctx.storage.items.get(copy);

    at(10);
    expect((await run()).moved).toBe(1);
    expect(await stateOf(feed)).toBe("trashed");
    expect(await ctx.storage.items.get(copy)).toEqual(before);
    expect(await stateOf(copy)).toBe("active");
  });

  it("leaves an item already in the bin as it is, without a second move", async () => {
    const type = uniqueType("binned");
    await declare(type, { retention_policy: { feed_days: 2 } });
    const binned = await add(type);
    const live = await add(type);
    expect(
      (
        await request(ctx.app, "DELETE", `/items/${binned}`, {
          key: ctx.workingKey,
        })
      ).status,
    ).toBe(200);
    const stamp = await trashedAtOf(binned);
    expect(stamp).toBe(new Date(t0).toISOString());
    const events = (await ctx.storage.eventLog.getAfter(0n, 1000)).length;

    at(10);
    expect((await run()).moved).toBe(1);
    expect(await stateOf(live)).toBe("trashed");
    expect(await trashedAtOf(binned)).toBe(stamp);
    // One event for the live item and none for the one already binned.
    expect((await ctx.storage.eventLog.getAfter(0n, 1000)).length).toBe(
      events + 1,
    );
  });

  it("does not move a restored item again, which is what an expiry cannot undo", async () => {
    const type = uniqueType("restored");
    await declare(type, { retention_policy: { feed_days: 2 } });
    const viaRestore = await add(type);
    const viaTransition = await add(type);

    at(10);
    expect((await run()).moved).toBe(2);
    expect(await stateOf(viaRestore)).toBe("trashed");

    const restore = await request(
      ctx.app,
      "POST",
      `/items/${viaRestore}/restore`,
      {
        key: ctx.workingKey,
      },
    );
    expect(restore.status, await restore.clone().text()).toBe(200);
    const transition = await request(
      ctx.app,
      "POST",
      `/items/${viaTransition}/transition`,
      { key: ctx.workingKey, body: { state: "active" } },
    );
    expect(transition.status, await transition.clone().text()).toBe(200);

    at(20);
    expect((await run()).moved).toBe(0);
    expect(await stateOf(viaRestore)).toBe("active");
    expect(await stateOf(viaTransition)).toBe("active");

    // Deleting it by hand again is still a delete, and the bin still holds it.
    await request(ctx.app, "DELETE", `/items/${viaRestore}`, {
      key: ctx.workingKey,
    });
    expect(await stateOf(viaRestore)).toBe("trashed");
  });

  it("does not move a parent and its child again after a restore brought both back", async () => {
    const type = uniqueType("restored_family");
    await declare(type, { retention_policy: { feed_days: 2 } });
    const parent = await add(type);
    const child = await add(type);
    await link(parent, child);

    at(10);
    expect((await run()).moved).toBe(2);
    expect(await stateOf(child)).toBe("trashed");
    const restore = await request(ctx.app, "POST", `/items/${parent}/restore`, {
      key: ctx.workingKey,
    });
    expect(restore.status, await restore.clone().text()).toBe(200);
    expect(await stateOf(child)).toBe("active");

    at(20);
    expect((await run()).moved).toBe(0);
    expect(await stateOf(parent)).toBe("active");
    expect(await stateOf(child)).toBe("active");
  });

  it("expires an item moved from the library to the feed long after it arrived, at the next run", async () => {
    const type = uniqueType("moved_tier");
    await declare(type, { retention_policy: { feed_days: 10 } });
    const id = await add(type, { tier: "library" });

    at(100);
    expect((await run()).moved).toBe(0);
    const patch = await request(ctx.app, "PATCH", `/items/${id}`, {
      key: ctx.workingKey,
      body: { tier: "feed", version: 1 },
    });
    expect(patch.status, await patch.clone().text()).toBe(200);
    expect((await run()).moved).toBe(1);
    expect(await stateOf(id)).toBe("trashed");
    const restore = await request(ctx.app, "POST", `/items/${id}/restore`, {
      key: ctx.workingKey,
    });
    expect(restore.status).toBe(200);
  });

  it("keeps the items of a type that was force-deleted, and judges them again once it is registered", async () => {
    const type = uniqueType("forgotten");
    await declare(type, { retention_policy: { feed_days: 2 } });
    const id = await add(type);
    const gone = await request(ctx.app, "DELETE", `/types/${type}?force=true`, {
      key: ctx.workingKey,
    });
    expect(gone.status, await gone.clone().text()).toBeLessThan(300);

    at(10);
    expect((await run()).moved).toBe(0);
    expect(await stateOf(id)).toBe("active");

    await declare(type, { retention_policy: { feed_days: 2 } });
    expect((await run()).moved).toBe(1);
    expect(await stateOf(id)).toBe("trashed");
  });
});

describe("through the delete path", () => {
  it("records an audit entry and the events a delete records", async () => {
    const type = uniqueType("announced");
    await declare(type, { retention_policy: { feed_days: 1 } });
    const id = await add(type);
    const before = (await ctx.storage.eventLog.getAfter(0n, 1000)).length;

    at(3);
    await run();
    const events = await ctx.storage.eventLog.getAfter(0n, 1000);
    const added = events.slice(before);
    expect(added).toHaveLength(1);
    expect(added[0]).toMatchObject({ event_type: "deleted", item_id: id });

    const audits = (
      await ctx.storage.audit.list({ action: "items.feed_expired" })
    ).data;
    expect(audits).toHaveLength(1);
    expect(audits[0]?.details).toMatchObject({
      type,
      moved: 1,
      item_ids: [id],
    });
  });

  it("moves a long run in bounded chunks, one audited transaction each", async () => {
    const type = uniqueType("many");
    await declare(type, { retention_policy: { feed_days: 1 } });
    const ids: string[] = [];
    for (let n = 0; n < 230; n++) ids.push(await add(type));

    at(3);
    const report = await run();
    expect(report.moved).toBe(230);
    for (const id of ids) expect(await stateOf(id)).toBe("trashed");
    const audits = (
      await ctx.storage.audit.list({ action: "items.feed_expired" })
    ).data;
    expect(
      audits.map((a) => a.details.moved).sort((a, b) => Number(b) - Number(a)),
    ).toEqual([100, 100, 30]);
    expect((await run()).moved).toBe(0);
  });

  it.each([
    ["the parent arrived first", true],
    ["the child arrived first", false],
  ])(
    "counts and audits a parent and its child once each when %s",
    async (_name, parentFirst) => {
      const type = uniqueType("cascade_ok");
      await declare(type, { retention_policy: { feed_days: 10 } });
      const first = await add(type);
      const second = await add(type);
      const [parent, child] = parentFirst ? [first, second] : [second, first];
      await link(parent, child);

      at(11);
      const report = await run();
      expect(report.moved).toBe(2);
      expect(report.held).toBe(0);
      expect(await stateOf(parent)).toBe("trashed");
      expect(await stateOf(child)).toBe("trashed");
      const audits = (
        await ctx.storage.audit.list({ action: "items.feed_expired" })
      ).data.filter((a) => a.details.type === type);
      const named = audits.flatMap((a) => a.details.item_ids as string[]);
      expect([...named].sort()).toEqual([parent, child].sort());
      expect(audits.reduce((n, a) => n + Number(a.details.moved), 0)).toBe(2);
    },
  );

  it("holds a parent whose cascade would take a child that has not expired, or a library item", async () => {
    const type = uniqueType("cascade_held");
    await declare(type, { retention_policy: { feed_days: 10 } });
    const parent = await add(type);
    const old = await add(type);
    await link(parent, old);

    at(6);
    const young = await add(type);
    const library = await add("core.note", {
      tier: "library",
      properties: { body: "someone's note" },
    });
    await link(parent, young);
    await link(parent, library);

    at(11);
    const first = await run();
    expect(first.moved).toBe(1);
    expect(first.held).toBe(1);
    expect(await stateOf(old)).toBe("trashed");
    expect(await stateOf(parent)).toBe("active");
    expect(await stateOf(young)).toBe("active");
    expect(await stateOf(library)).toBe("active");

    // The young child comes of age; the library item still holds the parent.
    at(17);
    const second = await run();
    expect(second.moved).toBe(1);
    expect(await stateOf(young)).toBe("trashed");
    expect(second.held).toBe(1);
    expect(await stateOf(parent)).toBe("active");
    expect(await stateOf(library)).toBe("active");
  });
});

describe("an edge that blocks a delete", () => {
  it("holds the item it would refuse a delete of, and moves the rest", async () => {
    const type = uniqueType("blocked");
    await declare(type, { retention_policy: { feed_days: 1 } });
    const edgeType = `blocks-${String(++sequence)}`;
    const created = await request(ctx.app, "POST", "/edge-types", {
      key: ctx.workingKey,
      body: {
        id: edgeType,
        cardinality: "many-to-many",
        source_type_constraints: ["*"],
        target_type_constraints: ["*"],
        cascade_on_delete: "block",
      },
    });
    expect(created.status, await created.clone().text()).toBe(201);
    const held = await add(type);
    const free = await add(type);
    const other = await add("core.note", {
      tier: "library",
      properties: { body: "refuses the delete" },
    });
    const edge = await request(ctx.app, "POST", "/edges", {
      key: ctx.workingKey,
      body: { source_id: other, target_id: held, edge_type: edgeType },
    });
    expect(edge.status, await edge.clone().text()).toBe(201);

    at(3);
    const report = await run();
    expect(report).toMatchObject({ moved: 1, held: 1 });
    expect(await stateOf(held)).toBe("active");
    expect(await stateOf(free)).toBe("trashed");
  });
});

describe("a type whose chain cannot be resolved", () => {
  const looped: string[] = [];
  afterAll(() => {
    for (const id of looped) unregisterTypeSchema(id);
  });

  it("is skipped, and the other types are still expired", async () => {
    const a = uniqueType("loop_a");
    const b = uniqueType("loop_b");
    const healthy = uniqueType("healthy");
    await declare(a, { retention_policy: { feed_days: 1 } });
    await declare(healthy, { retention_policy: { feed_days: 1 } });
    const stuck = await add(a);
    const fine = await add(healthy);
    const schema = (id: string, parent: string): TypeSchema => ({
      id,
      version: 1,
      parent,
      fields: {},
      retention_policy: { feed_days: 1 },
    });
    registerTypeSchema(schema(a, b));
    registerTypeSchema(schema(b, a));
    looped.push(a, b);

    at(5);
    const report = await run();
    expect(report.moved).toBe(1);
    expect(report.unresolvable).toBeGreaterThanOrEqual(2);
    expect(await stateOf(fine)).toBe("trashed");
    expect(await stateOf(stuck)).toBe("active");
  });
});
