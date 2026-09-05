import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { createTestContext, request } from "../test-utils.js";
import type { TestContext } from "../test-utils.js";
import { registerTypeSchema, unregisterTypeSchema } from "@withmarfa/shared";

/**
 * The two write doors judge a property payload the same way.
 *
 * `POST /items/bulk` used to validate only on a re-type, so a same-type
 * update went to the store unjudged: it stored the number 12345 into
 * `core.note.body`, a required string, and reported the entry as `updated`,
 * while `PATCH /items/{id}` refuses the identical payload. The row was then
 * invalid against its own type for every reader that trusts the declared
 * shape because the server enforced it, and the door that skipped the check
 * is the one built for volume.
 *
 * The payload below is deliberately the same object driven through both
 * doors: a test that constructed one for each could drift into two payloads
 * that each pass their own door.
 */

let ctx: TestContext;

beforeAll(async () => {
  ctx = await createTestContext();
});

afterAll(async () => {
  await ctx.cleanup();
});

/** A required string given a number. Neither door may accept it. */
const REFUSED_BY_THE_TYPE = { body: 12345 };

interface BulkResponse {
  counts: { created: number; updated: number; errored: number };
  results: {
    index: number;
    outcome: string;
    id?: string;
    error?: { code: string; message: string };
  }[];
}

async function seed(sourceId: string): Promise<string> {
  const res = await request(ctx.app, "POST", "/items/bulk", {
    key: ctx.adminKey,
    body: {
      items: [
        {
          type: "core.note",
          properties: { body: "valid to begin with" },
          source_id: sourceId,
        },
      ],
    },
  });
  expect(res.status).toBe(200);
  const data = (await res.json()) as BulkResponse;
  expect(data.counts.created).toBe(1);
  const id = data.results[0]?.id;
  // Thrown rather than asserted, so a seed that silently returns nothing
  // fails here and names itself instead of failing later as a 404 in the
  // test that was supposed to be about validation.
  if (id === undefined) throw new Error("the bulk seed returned no id");
  return id;
}

describe("a property payload one door refuses, the other refuses too", () => {
  it("is refused by PATCH", async () => {
    const id = await seed(
      `agree-patch-${Math.random().toString(36).slice(2, 8)}`,
    );

    const res = await request(ctx.app, "PATCH", `/items/${id}`, {
      key: ctx.adminKey,
      body: { properties: REFUSED_BY_THE_TYPE },
    });

    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("invalid_properties");
  });

  it("is refused by a same-type bulk update, under the same code", async () => {
    const sourceId = `agree-bulk-${Math.random().toString(36).slice(2, 8)}`;
    const id = await seed(sourceId);

    const res = await request(ctx.app, "POST", "/items/bulk", {
      key: ctx.adminKey,
      body: {
        atomic: false,
        items: [
          {
            type: "core.note",
            properties: REFUSED_BY_THE_TYPE,
            source_id: sourceId,
          },
        ],
      },
    });

    expect(res.status).toBe(200);
    const data = (await res.json()) as BulkResponse;
    expect(data.counts.updated).toBe(0);
    expect(data.counts.errored).toBe(1);
    expect(data.results[0]?.outcome).toBe("errored");
    expect(data.results[0]?.error?.code).toBe("invalid_properties");

    // The refusal is only worth anything if nothing was written. Asserting
    // the outcome alone would pass on a door that reported `errored` after
    // storing the row, which is the shape this defect had in reverse.
    const after = await request(ctx.app, "GET", `/items/${id}`, {
      key: ctx.adminKey,
    });
    expect(after.status).toBe(200);
    const item = (await after.json()) as {
      item: { properties: { body: unknown } };
    };
    expect(item.item.properties.body).toBe("valid to begin with");
  });

  it("rolls the whole page back when the batch is atomic", async () => {
    const bad = `agree-atomic-bad-${Math.random().toString(36).slice(2, 8)}`;
    const good = `agree-atomic-good-${Math.random().toString(36).slice(2, 8)}`;
    const badId = await seed(bad);
    const goodId = await seed(good);

    const res = await request(ctx.app, "POST", "/items/bulk", {
      key: ctx.adminKey,
      body: {
        items: [
          {
            type: "core.note",
            properties: { body: "this one is fine" },
            source_id: good,
          },
          {
            type: "core.note",
            properties: REFUSED_BY_THE_TYPE,
            source_id: bad,
          },
        ],
      },
    });

    expect(res.status).toBe(400);
    const body = (await res.json()) as {
      error: { code: string; details?: { code?: string } };
    };
    expect(body.error.code).toBe("bulk_atomic_rollback");
    expect(body.error.details?.code).toBe("invalid_properties");

    // The valid entry travelled with the refused one, so the rollback is
    // what has to be observed rather than the refusal.
    for (const id of [badId, goodId]) {
      const after = await request(ctx.app, "GET", `/items/${id}`, {
        key: ctx.adminKey,
      });
      const item = (await after.json()) as {
        item: { properties: { body: unknown } };
      };
      expect(item.item.properties.body).toBe("valid to begin with");
    }
  });

  it("still accepts a same-type update the type does allow", async () => {
    const sourceId = `agree-ok-${Math.random().toString(36).slice(2, 8)}`;
    const id = await seed(sourceId);

    const res = await request(ctx.app, "POST", "/items/bulk", {
      key: ctx.adminKey,
      body: {
        items: [
          {
            type: "core.note",
            properties: { body: "a string, which is what the type asks for" },
            source_id: sourceId,
          },
        ],
      },
    });

    expect(res.status).toBe(200);
    const data = (await res.json()) as BulkResponse;
    expect(data.counts.updated).toBe(1);
    expect(data.counts.errored).toBe(0);

    const after = await request(ctx.app, "GET", `/items/${id}`, {
      key: ctx.adminKey,
    });
    const item = (await after.json()) as {
      item: { properties: { body: unknown } };
    };
    expect(item.item.properties.body).toBe(
      "a string, which is what the type asks for",
    );
  });
  // The guard the same-type arm carries and the move arm does not, pinned.
  //
  // `validateProperties` reports an absent schema as `Unknown type` rather
  // than as no opinion, so an unguarded same-type update would refuse every
  // write to a type this request's registry does not carry — a custom type
  // registered in another space, or one deleted since the row was written.
  // Delete the guard and this case reddens with that refusal.
  it("accepts a same-type update to a type with no schema to judge it against", async () => {
    const orphan = "user.orphaned_by_this_test";
    registerTypeSchema(
      { id: orphan, version: 1, fields: { note: { type: "string" } } },
      undefined,
    );
    const sourceId = `agree-orphan-${Math.random().toString(36).slice(2, 8)}`;
    const seeded = await request(ctx.app, "POST", "/items/bulk", {
      key: ctx.adminKey,
      body: {
        items: [
          { type: orphan, properties: { note: "fine" }, source_id: sourceId },
        ],
      },
    });
    expect(seeded.status).toBe(200);

    // The row outlives its type, which is the state the guard is for.
    unregisterTypeSchema(orphan, undefined);

    const res = await request(ctx.app, "POST", "/items/bulk", {
      key: ctx.adminKey,
      body: {
        atomic: false,
        items: [
          {
            type: orphan,
            properties: { note: "still fine" },
            source_id: sourceId,
          },
        ],
      },
    });
    expect(res.status).toBe(200);
    const data = (await res.json()) as BulkResponse;
    expect(data.results[0]?.error?.message ?? "").not.toContain("Unknown type");
    expect(data.counts.errored).toBe(0);
    expect(data.counts.updated).toBe(1);
  });

  // The two refusals say different things, and nothing pinned that: inverting
  // the ternary that picks between them changed no assertion.
  it("names the destination when the entry was moving the row", async () => {
    const sourceId = `agree-move-${Math.random().toString(36).slice(2, 8)}`;
    await seed(sourceId);

    const res = await request(ctx.app, "POST", "/items/bulk", {
      key: ctx.adminKey,
      body: {
        atomic: false,
        retype: true,
        items: [{ type: "core.event", properties: {}, source_id: sourceId }],
      },
    });
    expect(res.status).toBe(200);
    const data = (await res.json()) as BulkResponse;
    expect(data.results[0]?.error?.code).toBe("invalid_properties");
    expect(data.results[0]?.error?.message).toContain("Cannot move item to");
    expect(data.results[0]?.error?.message).toContain("core.event");
  });

  // An entry carrying no properties at all reaches neither arm, and nothing
  // pinned that half of the outer guard either.
  it("accepts an entry that names no properties", async () => {
    const sourceId = `agree-noprops-${Math.random().toString(36).slice(2, 8)}`;
    await seed(sourceId);

    const res = await request(ctx.app, "POST", "/items/bulk", {
      key: ctx.adminKey,
      body: {
        items: [{ type: "core.note", tier: "library", source_id: sourceId }],
      },
    });
    expect(res.status).toBe(200);
    const data = (await res.json()) as BulkResponse;
    expect(data.counts.errored).toBe(0);
    expect(data.counts.updated).toBe(1);
  });
});
