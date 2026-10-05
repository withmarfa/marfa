import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { MarfaClient } from "../../client/api.js";
import type { TestContext } from "../../client/types.js";
import {
  createTestContext,
  cleanup,
  getOperatorClient,
  trackItem,
} from "../../utils/setup.js";

let client: MarfaClient;
let ctx: TestContext;
let sequence = 0;

beforeAll(async () => {
  ({ ctx, client } = await createTestContext("compliance", "version-policy"));
});

afterAll(async () => {
  await cleanup(ctx);
});

/** A `user.*` type naming `version_policy`, as the suite's credentials may
 *  register one. */
function declared(
  version_policy: object,
  id?: string,
): Parameters<MarfaClient["registerType"]>[0] {
  return {
    id: id ?? `user.policy-${ctx.runId}-${String(++sequence)}`,
    fields: { title: { type: "string" } },
    version_policy,
  } as Parameters<MarfaClient["registerType"]>[0];
}

describe("a type's version policy", () => {
  it("registers a policy of whole positive numbers in order", async () => {
    for (const policy of [
      { max_versions: 1 },
      { recent_days: 7, daily_snapshot_days: 30, weekly_snapshot_days: 365 },
      { recent_days: 30, daily_snapshot_days: 30, weekly_snapshot_days: 30 },
      { daily_snapshot_days: 30 },
      { recent_days: 100000 },
    ]) {
      const r = await client.registerType(declared(policy));
      expect(r.status, JSON.stringify(policy)).toBe(201);
    }
  });

  it.each([0, -1, 1.5])(
    "refuses a number that is not a whole positive one, naming the field: %s",
    async (value) => {
      for (const key of [
        "max_versions",
        "recent_days",
        "daily_snapshot_days",
        "weekly_snapshot_days",
      ]) {
        const r = await client.registerType(declared({ [key]: value }));
        expect(r.status, `${key}: ${String(value)}`).toBe(400);
        expect(r.error?.error.code).toBe("invalid_schema");
        expect(JSON.stringify(r.error?.error.details)).toContain(
          `version_policy.${key}`,
        );
      }
    },
  );

  it("refuses windows out of order, naming the one that ends too soon", async () => {
    const cases: [object, string][] = [
      [{ recent_days: 30, daily_snapshot_days: 7 }, "daily_snapshot_days"],
      [
        { daily_snapshot_days: 90, weekly_snapshot_days: 30 },
        "weekly_snapshot_days",
      ],
      [{ recent_days: 400, weekly_snapshot_days: 365 }, "weekly_snapshot_days"],
    ];
    for (const [policy, field] of cases) {
      const r = await client.registerType(declared(policy));
      expect(r.status, JSON.stringify(policy)).toBe(400);
      expect(r.error?.error.code).toBe("invalid_schema");
      expect(JSON.stringify(r.error?.error.details)).toContain(
        `version_policy.${field}`,
      );
    }
  });

  it("refuses the same on a replacement and keeps the type as it was", async () => {
    const id = `user.policy-keep-${ctx.runId}`;
    const made = await client.registerType(declared({ max_versions: 5 }, id));
    expect(made.status).toBe(201);

    const refused = await client.replaceType(
      id,
      declared({ recent_days: 30, daily_snapshot_days: 7 }, id),
    );
    expect(refused.status).toBe(400);
    expect(refused.error?.error.code).toBe("invalid_schema");

    const kept = await client.getType(id);
    expect(kept.ok).toBe(true);
    expect((kept.data as { version_policy?: object }).version_policy).toEqual({
      max_versions: 5,
    });
  });
});

describe("the version policy a type inherits", () => {
  /** An item of `type` holding three snapshots, the newest read. */
  async function itemWithSnapshots(type: string): Promise<string> {
    const created = await client.createItem({
      type,
      properties: { title: "v1" },
    });
    expect(created.status).toBe(201);
    const id = created.data.item.id;
    trackItem(ctx, id);
    for (let n = 1; n <= 3; n++) {
      const updated = await client.updateItem(id, {
        properties: { title: `v${String(n + 1)}` },
        version: n,
      });
      expect(updated.status).toBe(200);
    }
    const history = await client.getVersions(id);
    expect(history.data.data).toHaveLength(3);
    return id;
  }

  async function register(
    parent: string | undefined,
    version_policy?: object,
  ): Promise<string> {
    const id = `user.policy-chain-${ctx.runId}-${String(++sequence)}`;
    const r = await client.registerType({
      id,
      fields: { title: { type: "string" } },
      ...(parent !== undefined && { parent }),
      ...(version_policy !== undefined && { version_policy }),
    } as Parameters<MarfaClient["registerType"]>[0]);
    expect(r.status, JSON.stringify(r.error)).toBe(201);
    return id;
  }

  it("reads back field by field from the parent, a field the child declares overriding", async () => {
    const parent = await register(undefined, {
      recent_days: 7,
      max_versions: 100,
    });
    const bare = await register(parent);
    const overriding = await register(parent, { max_versions: 5 });
    const grandchild = await register(overriding);

    const read = async (id: string) =>
      ((await client.getType(id)).data as { version_policy?: object })
        .version_policy;
    expect(await read(bare)).toEqual({ recent_days: 7, max_versions: 100 });
    expect(await read(overriding)).toEqual({ recent_days: 7, max_versions: 5 });
    expect(await read(grandchild)).toEqual({
      recent_days: 7,
      max_versions: 5,
    });
  });

  it("thins an item's history by the policy its type inherits", async () => {
    const parent = await register(undefined, { max_versions: 1 });
    const inheriting = await register(parent);
    const overriding = await register(parent, { max_versions: 2 });
    const unconstrained = await register(undefined);

    const items = {
      inheriting: await itemWithSnapshots(inheriting),
      overriding: await itemWithSnapshots(overriding),
      unconstrained: await itemWithSnapshots(unconstrained),
    };

    const run = await getOperatorClient().runBackgroundJob("version-thinning");
    expect(run.status, JSON.stringify(run.error)).toBe(200);
    expect(run.data.outcome).toBe("ok");

    const kept = async (id: string) =>
      (await client.getVersions(id)).data.data.length;
    // A type with no policy anywhere keeps its recent history, which shows the
    // run removes nothing the policy keeps.
    expect(await kept(items.unconstrained)).toBe(3);
    expect(await kept(items.inheriting)).toBe(1);
    expect(await kept(items.overriding)).toBe(2);
  });
});
