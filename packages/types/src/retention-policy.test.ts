import { describe, expect, it } from "vitest";
import { MAX_FEED_DAYS, validateTypeSchema } from "./schema-validation.js";

const declare = (retention_policy: unknown, id = "acme.feed") =>
  validateTypeSchema(
    { id, fields: { title: { type: "string" } }, retention_policy },
    { resolveSchema: () => undefined },
  );

function refusedAt(retention_policy: unknown, id?: string): string[] {
  const result = declare(retention_policy, id);
  expect(result.success).toBe(false);
  return result.success ? [] : result.errors.map((e) => e.field);
}

describe("a type's retention policy", () => {
  it("takes whole days from 1 to the maximum, null, or nothing", () => {
    for (const policy of [
      { feed_days: 1 },
      { feed_days: 30 },
      { feed_days: MAX_FEED_DAYS },
      { feed_days: null },
      {},
    ]) {
      const result = declare(policy);
      expect(result.success, JSON.stringify(policy)).toBe(true);
      if (result.success) expect(result.data.retention_policy).toEqual(policy);
    }
  });

  it("is absent from a type that declares none", () => {
    const result = validateTypeSchema(
      { id: "acme.feed", fields: { title: { type: "string" } } },
      { resolveSchema: () => undefined },
    );
    expect(result.success).toBe(true);
    if (result.success)
      expect(result.data).not.toHaveProperty("retention_policy");
  });

  it.each([
    0,
    -1,
    1.5,
    "30",
    true,
    [],
    {},
    MAX_FEED_DAYS + 1,
    Number.MAX_SAFE_INTEGER,
    Infinity,
  ])("refuses %j for feed_days, naming the field", (value) => {
    expect(refusedAt({ feed_days: value })).toEqual([
      "retention_policy.feed_days",
    ]);
  });

  it.each([30, "30", null, [], true])(
    "refuses %j in place of the policy object",
    (value) => {
      expect(refusedAt(value)).toEqual(["retention_policy"]);
    },
  );

  it("refuses a policy on a system type, which has no feed tier", () => {
    expect(refusedAt({ feed_days: 30 }, "system.thing")).toEqual([
      "retention_policy",
    ]);
    expect(refusedAt({}, "system.thing")).toEqual(["retention_policy"]);
    // The witness: the same policy on a type outside the namespace passes.
    expect(declare({ feed_days: 30 }, "acme.thing").success).toBe(true);
  });
});
