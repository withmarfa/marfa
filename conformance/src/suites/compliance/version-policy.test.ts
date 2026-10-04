import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { MarfaClient } from "../../client/api.js";
import type { TestContext } from "../../client/types.js";
import { createTestContext, cleanup } from "../../utils/setup.js";

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

    const refused = await client.updateType(
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
