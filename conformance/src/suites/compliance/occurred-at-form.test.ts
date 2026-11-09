/**
 * An `occurred_at` is an RFC 3339 date-time: the zone is required, a fraction
 * is optional, and a reduced form is refused.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { MarfaClient } from "../../client/api.js";
import type { TestContext } from "../../client/types.js";
import { createTestContext, trackItem, cleanup } from "../../utils/setup.js";
import { createNote } from "../../generators/items.js";

let client: MarfaClient;
let ctx: TestContext;

beforeAll(async () => {
  ({ ctx, client } = await createTestContext("compliance", "occurred-at-form"));
});

afterAll(async () => {
  await cleanup(ctx);
});

describe("the form of an occurred_at", () => {
  it.each([
    ["has a time and no zone", "2026-11-08T10:00:00"],
    ["has no seconds", "2026-11-08T10:00Z"],
    ["has no time", "2026-11-08"],
    ["has hour 24", "2026-11-08T24:00:00Z"],
    ["has an offset with no colon", "2026-11-08T10:00:00+0100"],
    ["has a leap second", "2026-11-08T23:59:60Z"],
  ])(
    "refuses an occurred_at that %s, as it is not an RFC 3339 date-time",
    async (_name, bad) => {
      const refused = await client.createItem(
        createNote({ source: ctx.source, occurred_at: bad }),
      );
      expect(refused.status, bad).toBe(400);
      expect(refused.error?.error.code).toBe("validation_error");
      expect(refused.error?.error.details).toMatchObject({
        field: "occurred_at",
      });
    },
  );

  it("takes an occurred_at with a zone, however it is spelled, as the instant it names", async () => {
    for (const [written, stored] of [
      ["2026-04-01T07:00:00Z", "2026-04-01T07:00:00.000Z"],
      ["2026-04-01T07:00:00z", "2026-04-01T07:00:00.000Z"],
      ["2026-04-01t09:00:00.5+02:00", "2026-04-01T07:00:00.500Z"],
      ["2026-04-01T07:00:00.123456Z", "2026-04-01T07:00:00.123Z"],
    ]) {
      const created = await client.createItem(
        createNote({ source: ctx.source, occurred_at: written }),
      );
      expect(created.status, JSON.stringify(created.error)).toBe(201);
      trackItem(ctx, created.data.item.id);
      expect(created.data.item.occurred_at, written).toBe(stored);
    }
  });
});
