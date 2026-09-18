import { describe, expect, it, beforeAll, afterAll } from "vitest";
import {
  createTestContext,
  request,
  runBulkActionAsync,
} from "../test-utils.js";
import type { TestContext } from "../test-utils.js";
import { registerTypeSchema, unregisterTypeSchema } from "@withmarfa/shared";

/**
 * The bulk-action door judges a property patch the way every other write door
 * does.
 *
 * It was the last of the six enumerated item-write doors writing properties
 * unvalidated, and the widest: it takes a filter rather than a list of rows,
 * so one patch reaches every row the filter matched. A single call could
 * leave thousands of rows invalid against their own schemas, and the
 * consequence surfaces far from the write that caused it.
 *
 * The payload below is the same one the single-item doors are held to, a
 * number in a required string, so a door that disagreed about it would be
 * disagreeing about the rule rather than about the request.
 */

let ctx: TestContext;

beforeAll(async () => {
  ctx = await createTestContext();
});

afterAll(async () => {
  await ctx.cleanup();
});

/** A required string given a number. No door may accept it. */
const REFUSED_BY_THE_TYPE = { body: 12345 };

async function seed(marker: string, type = "core.note"): Promise<string> {
  const res = await request(ctx.app, "POST", "/items", {
    key: ctx.spaceKey,
    body: {
      type,
      properties:
        type === "core.note" ? { body: `bap-${marker}` } : { note: "fine" },
      tags: [marker],
    },
  });
  expect(res.status).toBe(201);
  const { item } = (await res.json()) as { item: { id: string } };
  return item.id;
}

async function seedOfType(
  marker: string,
  type: string,
  properties: Record<string, unknown>,
): Promise<string> {
  const res = await request(ctx.app, "POST", "/items", {
    key: ctx.spaceKey,
    body: { type, properties, tags: [marker] },
  });
  expect(res.status).toBe(201);
  const { item } = (await res.json()) as { item: { id: string } };
  return item.id;
}

async function patchByTag(
  marker: string,
  patch: Record<string, unknown>,
): Promise<{
  matched: number;
  succeeded: number;
  errors: { id: string; code: string; message: string }[];
}> {
  const { initialStatus, result } = await runBulkActionAsync(
    ctx,
    { action: "update_properties", patch, filter: { tags: [marker] } },
    ctx.spaceKey,
  );
  // 202: this door queues a job and the helper waits for it. Only a dry run
  // answers synchronously.
  expect(initialStatus).toBe(202);
  return {
    matched: result?.matched ?? 0,
    succeeded: result?.succeeded ?? 0,
    errors: result?.errors ?? [],
  };
}

async function bodyOf(id: string): Promise<unknown> {
  const res = await request(ctx.app, "GET", `/items/${id}`, {
    key: ctx.spaceKey,
  });
  expect(res.status).toBe(200);
  const { item } = (await res.json()) as {
    item: { properties: { body?: unknown } };
  };
  return item.properties.body;
}

describe("the bulk-action door judges a property patch", () => {
  it("errors the row rather than writing a value its type refuses", async () => {
    const marker = `bap-${Math.random().toString(36).slice(2, 8)}`;
    const id = await seed(marker);

    const outcome = await patchByTag(marker, REFUSED_BY_THE_TYPE);

    expect(outcome.matched).toBe(1);
    expect(outcome.succeeded).toBe(0);
    expect(outcome.errors[0]?.code).toBe("invalid_properties");

    // The refusal is only worth anything if nothing was written. Asserting
    // the outcome alone would pass on a door that reported the error after
    // storing the row.
    expect(await bodyOf(id)).toBe(`bap-${marker}`);
  });

  it("errors one row and applies the rest, inside the same chunk", async () => {
    // A mixed chunk, which the earlier version of this case did not build:
    // both its rows were `core.note` and both took the refused patch, so
    // `succeeded: 0` was asserted and "the rest" was a second call. What
    // that could not see is the failure worth catching — the chunk runs
    // inside one transaction, so a refusal escaping the per-row `try` would
    // roll back the rows that had already succeeded, and with every row
    // failing that is indistinguishable from working correctly.
    //
    // The second row is of a type with no registered schema, so the same
    // patch is judged for the note and unjudged for it.
    const loose = "user.unjudged_in_a_mixed_chunk";
    registerTypeSchema({
      id: loose,
      version: 1,
      fields: { body: { type: "string" } },
    });
    try {
      const marker = `bapmix-${Math.random().toString(36).slice(2, 8)}`;
      const note = await seed(marker);
      const other = await seedOfType(marker, loose, { body: "before" });
      unregisterTypeSchema(loose);

      const outcome = await patchByTag(marker, REFUSED_BY_THE_TYPE);

      expect(outcome.matched).toBe(2);
      expect(outcome.succeeded).toBe(1);
      expect(outcome.errors).toHaveLength(1);
      expect(outcome.errors[0]?.id).toBe(note);
      expect(outcome.errors[0]?.code).toBe("invalid_properties");

      // The refused row is untouched and the judged-nothing row is written,
      // which is what says the transaction did not roll back around the
      // refusal.
      expect(await bodyOf(note)).toBe(`bap-${marker}`);
      expect(await bodyOf(other)).toBe(12345);
    } finally {
      unregisterTypeSchema(loose);
    }
  });

  it("accepts a patch to a type it has no schema to judge against", async () => {
    // The guard the single-item door carries. `validateProperties` reports an
    // absent schema as `Unknown type` rather than as no opinion, so judging
    // unguarded would refuse every row of a type this worker's registry does
    // not hold — a space's own type, or one deleted since the row was written.
    const orphan = "user.orphaned_by_the_bulk_action_test";
    registerTypeSchema({
      id: orphan,
      version: 1,
      fields: { note: { type: "string" } },
    });
    // Unregistered in a `finally` as well, so a throwing seed does not leave
    // the type in the process-global registry for every later test.
    const marker = `baporph-${Math.random().toString(36).slice(2, 8)}`;
    let id: string;
    try {
      id = await seed(marker, orphan);
    } finally {
      // The row outlives its type, which is the state the guard is for.
      unregisterTypeSchema(orphan);
    }

    const outcome = await patchByTag(marker, { note: "still fine" });
    expect(outcome.errors).toHaveLength(0);
    expect(outcome.succeeded).toBe(1);

    // Reporting success is not writing. A door that skipped the row and
    // counted it anyway would pass on the counts alone.
    const after = await request(ctx.app, "GET", `/items/${id}`, {
      key: ctx.spaceKey,
    });
    const { item } = (await after.json()) as {
      item: { properties: { note?: unknown } };
    };
    expect(item.properties.note).toBe("still fine");
  });
});
