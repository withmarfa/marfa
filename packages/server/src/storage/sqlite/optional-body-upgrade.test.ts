import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { join } from "node:path";
import {
  shippedPlatformTypes,
  validateProperties,
  type SeededPlatformType,
  type TypeSchema,
} from "@withmarfa/shared";
import { createTestContext, type TestContext } from "../../test-utils.js";
import { createSqliteStorage } from "./index.js";

/**
 * An instance holds its built-in types as rows, written when the build that
 * created it first started, and each boot writes the shipped set over them.
 * So an instance made when a note, an article and a message each required
 * `body` stops requiring it the next time it opens under this build, with no
 * version change and no migration.
 */

const BODY_TYPES = ["core.note", "core.media.article", "core.message"];

let ctx: TestContext;

beforeEach(async () => {
  ctx = await createTestContext();
});

afterEach(async () => {
  await ctx.cleanup();
});

/** The shipped set as an earlier build wrote it: `body` required where it has one. */
function earlierBuild(): SeededPlatformType[] {
  return shippedPlatformTypes().map((entry) => {
    if (!BODY_TYPES.includes(entry.schema.id)) return entry;
    const body = entry.schema.fields.body;
    if (!body) throw new Error(`${entry.schema.id} has no body`);
    const schema: TypeSchema = {
      ...entry.schema,
      fields: { ...entry.schema.fields, body: { ...body, required: true } },
    };
    return { ...entry, schema };
  });
}

const refusedFields = (type: string, properties: Record<string, unknown>) => {
  const result = validateProperties(type, properties);
  return result.success ? [] : result.errors.map((e) => e.field);
};

describe("an instance made when a note, an article and a message required a body", () => {
  it("stops requiring it the next time it opens", async () => {
    await ctx.storage.types.seedPlatformTypes(earlierBuild());

    // The witness: the earlier definitions do refuse a write without a body.
    expect(refusedFields("core.note", {})).toEqual(["body"]);
    expect(refusedFields("core.media.article", { title: "T" })).toEqual([
      "body",
    ]);
    expect(refusedFields("core.message", { from: "a" })).toEqual(["body"]);

    await ctx.storage.close();
    const reopened = await createSqliteStorage(join(ctx.tmpDir, "test.db"));
    try {
      const stored = await reopened.types.loadAll();
      for (const id of BODY_TYPES) {
        const row = stored.find((r) => r.schema.id === id);
        expect(row?.origin, id).toBe("platform");
        expect(row?.schema.fields.body?.required, id).toBeUndefined();
      }

      expect(refusedFields("core.note", {})).toEqual([]);
      expect(refusedFields("core.media.article", { title: "T" })).toEqual([]);
      expect(refusedFields("core.message", { from: "a" })).toEqual([]);

      // What each type means nothing without is still required.
      expect(refusedFields("core.media.article", {})).toEqual(["title"]);
      expect(refusedFields("core.message", {})).toEqual(["from"]);
    } finally {
      await reopened.close();
    }
  });
});
