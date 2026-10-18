import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { MarfaClient } from "../../client/api.js";
import type { TestContext } from "../../client/types.js";
import { createTestContext, cleanup } from "../../utils/setup.js";

let client: MarfaClient;
let ctx: TestContext;
let sequence = 0;

beforeAll(async () => {
  ({ ctx, client } = await createTestContext("compliance", "retention-policy"));
});

afterAll(async () => {
  await cleanup(ctx);
});

type Registration = Parameters<MarfaClient["registerType"]>[0];

/** A `user.*` type naming `retention_policy`, as the suite's credentials may
 *  register one. */
function declared(retention_policy: unknown, parent?: string): Registration {
  sequence += 1;
  return {
    id: `user.retention-${ctx.runId}-${String(sequence)}`,
    fields: parent === undefined ? { title: { type: "string" } } : {},
    ...(parent !== undefined && { parent }),
    ...(retention_policy !== undefined && { retention_policy }),
  } as Registration;
}

describe("a type's retention policy", () => {
  it("accepts a window of 1 day, of 36500 days and null", async () => {
    for (const policy of [
      { feed_days: 1 },
      { feed_days: 36500 },
      { feed_days: null },
      {},
    ]) {
      const r = await client.registerType(declared(policy));
      expect(r.status, JSON.stringify(policy)).toBe(201);
      expect(r.data.type.retention_policy).toEqual(policy);
    }
  });

  it("refuses a feed_days that is not a whole number of days from 1 to 36500 or null, naming the field", async () => {
    for (const value of [
      0,
      -1,
      1.5,
      36501,
      1e300,
      "30",
      true,
      [],
      {},
    ] as unknown[]) {
      const r = await client.registerType(declared({ feed_days: value }));
      expect(r.status, JSON.stringify(value)).toBe(400);
      expect(r.error?.error.code).toBe("invalid_schema");
      expect(JSON.stringify(r.error?.error.details)).toContain(
        "retention_policy.feed_days",
      );
    }
    for (const policy of [30, "30", null, [], true] as unknown[]) {
      const r = await client.registerType(declared(policy));
      // `null` is a policy left out only when the member is absent, and
      // here it is present.
      expect(r.status, JSON.stringify(policy)).toBe(400);
      expect(r.error?.error.code).toBe("invalid_schema");
      expect(JSON.stringify(r.error?.error.details)).toContain(
        "retention_policy",
      );
    }
    // The witness: a refusal registers nothing, and the same body mended does.
    const mended = declared({ feed_days: 0 });
    expect((await client.registerType(mended)).status).toBe(400);
    expect((await client.getType(mended.id)).status).toBe(404);
    expect(
      (
        await client.registerType({
          ...mended,
          retention_policy: { feed_days: 7 },
        })
      ).status,
    ).toBe(201);
  });

  it("registers a policy on a child and answers it on a replacement", async () => {
    const parent = declared({ feed_days: 30 });
    expect((await client.registerType(parent)).status).toBe(201);
    const child = declared({ feed_days: 7 }, parent.id);
    expect((await client.registerType(child)).status).toBe(201);

    const read = await client.getType(child.id);
    expect(read.data.retention_policy).toEqual({ feed_days: 7 });

    const replaced = await client.replaceType(child.id, {
      ...read.data,
      retention_policy: { feed_days: null },
    });
    expect(replaced.status, JSON.stringify(replaced.error)).toBe(200);
    expect((await client.getType(child.id)).data.retention_policy).toEqual({
      feed_days: null,
    });

    const refused = await client.replaceType(child.id, {
      ...read.data,
      retention_policy: { feed_days: 0 },
    });
    expect(refused.status).toBe(400);
    expect(JSON.stringify(refused.error?.error.details)).toContain(
      "retention_policy.feed_days",
    );
    // The type is as it was.
    expect((await client.getType(child.id)).data.retention_policy).toEqual({
      feed_days: null,
    });
  });

  it("reads back the window a parent declares, a child's own or null replacing it", async () => {
    const parent = declared({ feed_days: 30 });
    const inheriting = declared(undefined, parent.id);
    const shorter = declared({ feed_days: 3 }, parent.id);
    const keeping = declared({ feed_days: null }, parent.id);
    const grandchild = declared(undefined, keeping.id);
    const regrandchild = declared({ feed_days: 9 }, keeping.id);
    const bare = declared(undefined);
    for (const schema of [
      parent,
      inheriting,
      shorter,
      keeping,
      grandchild,
      regrandchild,
      bare,
    ]) {
      const r = await client.registerType(schema);
      expect(r.status, JSON.stringify(r.error)).toBe(201);
    }

    const window = async (id: string) =>
      (await client.getType(id)).data.retention_policy;
    expect(await window(parent.id)).toEqual({ feed_days: 30 });
    expect(await window(inheriting.id)).toEqual({ feed_days: 30 });
    expect(await window(shorter.id)).toEqual({ feed_days: 3 });
    expect(await window(keeping.id)).toEqual({ feed_days: null });
    expect(await window(grandchild.id)).toEqual({ feed_days: null });
    expect(await window(regrandchild.id)).toEqual({ feed_days: 9 });
    // A type with no policy anywhere in its chain carries none.
    expect(await window(bare.id)).toBeUndefined();
  });

  it("lists the window a type declares and none it only inherits", async () => {
    const parent = declared({ feed_days: 30 });
    const inheriting = declared(undefined, parent.id);
    const keeping = declared({ feed_days: null }, parent.id);
    for (const schema of [parent, inheriting, keeping]) {
      expect((await client.registerType(schema)).status).toBe(201);
    }

    const listed = await client.listTypes();
    expect(listed.status).toBe(200);
    type Declared = { id: string; retention_policy?: unknown };
    const find = (id: string) =>
      (listed.data.data as unknown as Declared[]).find((t) => t.id === id);
    expect(find(parent.id)?.retention_policy).toEqual({ feed_days: 30 });
    expect(find(keeping.id)?.retention_policy).toEqual({ feed_days: null });
    // The type itself answers 30; the listing shows what it declares.
    expect(find(inheriting.id)).toBeDefined();
    expect(find(inheriting.id)).not.toHaveProperty("retention_policy");
    expect((await client.getType(inheriting.id)).data.retention_policy).toEqual(
      { feed_days: 30 },
    );
  });
});
