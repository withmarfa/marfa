import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestContext, mintSpaceKey, request } from "../test-utils.js";
import type { TestContext } from "../test-utils.js";

/**
 * The bulk door's opt-in re-type: the operation
 * `requireDeclaredTypeMatches` says a caller meaning to move a corpus
 * between types has, reached by the door most of a corpus arrives
 * through.
 */
let ctx: TestContext;

const suffix = (): string => Math.random().toString(36).slice(2, 10);

async function registerTypes(): Promise<void> {
  for (const [id, fields] of [
    ["user.origin_log", { title: { type: "string", required: true } }],
    ["user.dest_log", { title: { type: "string", required: true } }],
    [
      "user.demanding_log",
      {
        title: { type: "string", required: true },
        shelf: { type: "string", required: true },
      },
    ],
  ] as const) {
    const res = await request(ctx.app, "POST", "/types", {
      key: ctx.spaceKey,
      body: { id, version: 1, fields },
    });
    expect([201, 409]).toContain(res.status);
  }
}

async function seed(
  sourceId: string,
  type = "user.origin_log",
): Promise<string> {
  const res = await request(ctx.app, "POST", "/items/bulk", {
    key: ctx.spaceKey,
    body: {
      items: [{ type, properties: { title: "a thing" }, source_id: sourceId }],
    },
  });
  expect(res.status).toBe(200);
  const body = (await res.json()) as { results: { id: string }[] };
  return body.results[0]!.id;
}

async function upsert(
  sourceId: string,
  type: string,
  opts: { retype?: boolean; properties?: Record<string, unknown> } = {},
): Promise<{
  status: number;
  results: {
    outcome: string;
    id?: string;
    error?: { code: string; message: string };
  }[];
}> {
  const res = await request(ctx.app, "POST", "/items/bulk", {
    key: ctx.spaceKey,
    body: {
      atomic: false,
      ...(opts.retype === undefined ? {} : { retype: opts.retype }),
      items: [
        {
          type,
          properties: opts.properties ?? { title: "a thing, moved" },
          source_id: sourceId,
        },
      ],
    },
  });
  const body = (await res.json()) as {
    results: {
      outcome: string;
      id?: string;
      error?: { code: string; message: string };
    }[];
  };
  return { status: res.status, results: body.results };
}

beforeAll(async () => {
  ctx = await createTestContext();
  await registerTypes();
});

afterAll(async () => {
  await ctx.cleanup();
});

describe("moving a corpus through the bulk door", () => {
  it("refuses a differing type by default, so the flag is what moves a row", async () => {
    const sid = `retype-${suffix()}`;
    const id = await seed(sid);

    const { results } = await upsert(sid, "user.dest_log");
    expect(results[0]?.outcome).toBe("errored");
    expect(results[0]?.error?.code).toBe("type_mismatch");

    // Not inferred from the differing type: the row stayed put.
    expect((await ctx.storage.items.get(id))?.type).toBe("user.origin_log");
  });

  it("moves the row when the batch asks for it", async () => {
    const sid = `retype-${suffix()}`;
    const id = await seed(sid);

    const { results } = await upsert(sid, "user.dest_log", { retype: true });
    expect(results[0]?.outcome).toBe("updated");
    expect(results[0]?.id).toBe(id);

    const after = await ctx.storage.items.get(id);
    expect(after?.type).toBe("user.dest_log");
    expect(after?.properties.title).toBe("a thing, moved");
    // Same row, not a second one: the corpus moved rather than doubling.
    expect(after?.source_id).toBe(sid);
  });

  it("names the item the destination cannot accept, and moves the rest", async () => {
    const movable = `retype-${suffix()}`;
    const stuck = `retype-${suffix()}`;
    await seed(movable);
    const stuckId = await seed(stuck);

    const res = await request(ctx.app, "POST", "/items/bulk", {
      key: ctx.spaceKey,
      body: {
        atomic: false,
        retype: true,
        items: [
          {
            type: "user.demanding_log",
            properties: { title: "has a shelf", shelf: "hallway" },
            source_id: movable,
          },
          {
            // The destination requires `shelf` and this entry supplies
            // none, so the merged result is invalid there.
            type: "user.demanding_log",
            properties: { title: "has no shelf" },
            source_id: stuck,
          },
        ],
      },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      counts: { updated: number; errored: number };
      results: { outcome: string; error?: { code: string; message: string } }[];
    };

    // One moves, one cannot, and the one that cannot is named rather than
    // counted — and does not abandon the rest.
    expect(body.counts.updated).toBe(1);
    expect(body.counts.errored).toBe(1);
    expect(body.results[1]?.error?.code).toBe("invalid_properties");
    expect(body.results[1]?.error?.message).toContain("shelf");
    expect((await ctx.storage.items.get(stuckId))?.type).toBe(
      "user.origin_log",
    );
  });

  it("leaves a row alone when the entry names the type it already has", async () => {
    const sid = `retype-${suffix()}`;
    const id = await seed(sid);

    const { results } = await upsert(sid, "user.origin_log", { retype: true });
    expect(results[0]?.outcome).toBe("updated");
    const after = await ctx.storage.items.get(id);
    expect(after?.type).toBe("user.origin_log");
    expect(after?.properties.title).toBe("a thing, moved");
  });

  it("refuses a move into a type the caller could not have created the row under", async () => {
    // Write on the type being left is not write on the type being
    // entered, and a re-type is an entry into one. Non-atomic on purpose:
    // atomic mode's own pre-check authorizes every declared type up
    // front, so it would answer this whether or not the re-type arm did.
    //
    // An ordinary working key in the context's space, narrowed to write on
    // the type being left and nothing else. It has to be bound to that space
    // to see the types registered there at all, and the type map is then the
    // only thing left that can refuse the move.
    const rawKey = await mintSpaceKey(ctx, {
      label: "retype-scoped",
      type_permissions: { "user.origin_log": "write" },
    });
    const sid = `retype-${suffix()}`;

    // Seeded through that credential itself: `source` is stamped
    // from it, and the natural key resolves within one source.
    const seeded = await request(ctx.app, "POST", "/items/bulk", {
      key: rawKey,
      body: {
        atomic: false,
        items: [
          {
            type: "user.origin_log",
            properties: { title: "its own" },
            source_id: sid,
          },
        ],
      },
    });
    const seededBody = (await seeded.json()) as {
      results: { outcome: string; id: string }[];
    };
    expect(seededBody.results[0]?.outcome).toBe("created");
    const id = seededBody.results[0]!.id;

    const res = await request(ctx.app, "POST", "/items/bulk", {
      key: rawKey,
      body: {
        atomic: false,
        retype: true,
        items: [
          {
            type: "user.dest_log",
            properties: { title: "its own" },
            source_id: sid,
          },
        ],
      },
    });
    const body = (await res.json()) as {
      results: { outcome: string; error?: { code: string } }[];
    };
    expect(body.results[0]?.outcome).toBe("errored");
    expect(body.results[0]?.error?.code).toBe("type_not_permitted");
    expect((await ctx.storage.items.get(id))?.type).toBe("user.origin_log");
  });

  it("is reversible, so either answer to the mapping question stays correct", async () => {
    const sid = `retype-${suffix()}`;
    const id = await seed(sid);

    await upsert(sid, "user.dest_log", { retype: true });
    expect((await ctx.storage.items.get(id))?.type).toBe("user.dest_log");

    await upsert(sid, "user.origin_log", { retype: true });
    const back = await ctx.storage.items.get(id);
    expect(back?.type).toBe("user.origin_log");
    expect(back?.id).toBe(id);
  });
});
