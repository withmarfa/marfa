/**
 * A request still carrying a renamed time filter is refused, on every door
 * that took one.
 *
 * `since` and `until` read the item's own time and are now named for it:
 * `timestamp_after` and `timestamp_before`. The rename is only half the
 * change. Query parameters are parsed by a schema that strips unknown keys
 * rather than rejecting them, so without an explicit refusal a request
 * carrying the old name parses cleanly with the filter dropped, and the
 * caller gets `200`, a well-formed page and no time filter at all.
 *
 * **So every test here asserts on the rows, not only on the status.** A
 * test that checked `400` alone would still pass against a server that had
 * quietly turned the refusal into a warning and returned the whole corpus,
 * which is the exact failure being guarded.
 *
 * The bulk-action door is the one that matters most and reads as the least
 * likely: its filter *is* the match set, so a dropped bound turns "act on
 * the items before this date" into "act on everything", and the match cap
 * is high enough that a modest space does not even error.
 */
import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { createTestContext, request } from "../test-utils.js";
import type { TestContext } from "../test-utils.js";

let ctx: TestContext;

beforeAll(async () => {
  ctx = await createTestContext();
});

afterAll(async () => {
  await ctx.cleanup();
});

interface ErrorBody {
  error: { code: string; message: string };
}

async function seedNote(body: string, timestamp?: string): Promise<string> {
  const res = await request(ctx.app, "POST", "/items", {
    key: ctx.spaceKey,
    body: {
      type: "core.note",
      properties: { body },
      ...(timestamp ? { timestamp } : {}),
    },
  });
  expect(res.status).toBe(201);
  return ((await res.json()) as { item: { id: string } }).item.id;
}

const OLD = "2010-01-01T00:00:00.000Z";
const NEW = "2030-01-01T00:00:00.000Z";
const CUTOFF = "2020-01-01T00:00:00.000Z";

describe("the renamed filters are refused rather than dropped", () => {
  it("refuses `since` on GET /items and names its replacement", async () => {
    // Two rows either side of the cutoff, so the refusal has something to
    // have returned had it silently dropped the parameter instead.
    await seedNote("refusal-old", OLD);
    await seedNote("refusal-new", NEW);

    const res = await request(
      ctx.app,
      "GET",
      `/items?since=${encodeURIComponent(CUTOFF)}&limit=200`,
      { key: ctx.spaceKey },
    );

    expect(res.status).toBe(400);
    // The assertion the status code cannot make. A stripped parameter
    // produces a body with a `data` array; a refusal produces one with an
    // `error`. Reading the shape is what tells a refusal apart from a
    // silently unfiltered success.
    const raw = (await res.json()) as Record<string, unknown>;
    expect(raw).not.toHaveProperty("data");
    expect(raw).toHaveProperty("error");

    const body = raw as unknown as ErrorBody;
    expect(body.error.code).toBe("validation_error");
    expect(body.error.message).toContain("timestamp_after");
    // The other new name is in the message too, because a caller who used
    // `since` for a catch-up wanted this one and would otherwise rename
    // their way to a filter that reads the wrong column.
    expect(body.error.message).toContain("updated_after");
  });

  it("refuses `until` on GET /items and names its replacement", async () => {
    const res = await request(
      ctx.app,
      "GET",
      `/items?until=${encodeURIComponent(CUTOFF)}`,
      { key: ctx.spaceKey },
    );
    expect(res.status).toBe(400);
    expect(((await res.json()) as ErrorBody).error.message).toContain(
      "timestamp_before",
    );
  });

  it("refuses `since` on GET /export", async () => {
    const res = await request(
      ctx.app,
      "GET",
      `/export?since=${encodeURIComponent(CUTOFF)}`,
      { key: ctx.spaceKey },
    );
    expect(res.status).toBe(400);
    const message = ((await res.json()) as ErrorBody).error.message;
    expect(message).toContain("timestamp_after");
    // And it does not send the caller to `updated_after`, which this door
    // does not accept: the query schema strips an unknown key, so a
    // caller following that advice would get a 200 and an unfiltered
    // export — the silence this refusal exists to prevent, reached
    // through the refusal.
    expect(message).not.toContain("updated_after");
  });

  it("refuses `since` on GET /edges and names `updated_after`, the one time filter the door has", async () => {
    // An edge has no item time, so `timestamp_after` does not exist here
    // either: a refusal naming it would send the caller to a parameter this
    // door strips in silence, which is the failure being refused.
    const res = await request(
      ctx.app,
      "GET",
      `/edges?since=${encodeURIComponent(CUTOFF)}`,
      { key: ctx.spaceKey },
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as {
      error: { code: string; message: string; details?: { use?: unknown } };
    };
    expect(body.error.code).toBe("validation_error");
    expect(body.error.message).toContain("updated_after");
    expect(body.error.message).not.toContain("timestamp_after");
    expect(body.error.details?.use).toBe("updated_after");
  });

  for (const [oldName, newName] of [
    ["since", "timestamp_after"],
    ["until", "timestamp_before"],
  ] as const) {
    it(`refuses \`${oldName}\` in a bulk-action filter and acts on nothing`, async () => {
      const survivor = await seedNote(`bulk-survivor-${oldName}`, NEW);

      const res = await request(ctx.app, "POST", "/items/bulk-actions", {
        key: ctx.spaceKey,
        body: {
          action: "transition",
          state: "archived",
          filter: { [oldName]: CUTOFF },
        },
      });

      expect(res.status).toBe(400);
      const message = ((await res.json()) as ErrorBody).error.message;
      expect(message).toContain(newName);
      // Same reason as the export door: the bulk filter has no
      // `updated_after` either, and the schema drops what it does not
      // know.
      expect(message).not.toContain("updated_after");

      // The half that matters, and it is asserted for both names rather
      // than for the one that happened to be written first. Had the key
      // been stripped, the filter would have been `{}` — every item in
      // the space — and this row would have been archived by a call that
      // asked for a dated slice.
      const after = await request(ctx.app, "GET", `/items/${survivor}`, {
        key: ctx.spaceKey,
      });
      expect(after.status).toBe(200);
      expect(
        ((await after.json()) as { item: { state: string } }).item.state,
      ).toBe("active");
    });
  }

  it("leaves the audit log's own `since` alone", async () => {
    // Scoped per door rather than installed as middleware, because this
    // one reads the audit table's own timestamp column and is correctly
    // named. A blanket refusal would break it, and nothing else here
    // would notice.
    const res = await request(
      ctx.app,
      "GET",
      `/audit?since=${encodeURIComponent(CUTOFF)}`,
      { key: ctx.spaceKey },
    );
    expect(res.status).toBe(200);
  });
});

describe("the new names do what the old ones did", () => {
  it("bounds a listing by the item's own time, inclusively at both ends", async () => {
    const old = await seedNote("named-old", OLD);
    const recent = await seedNote("named-new", NEW);

    const lower = await request(
      ctx.app,
      "GET",
      `/items?timestamp_after=${encodeURIComponent(CUTOFF)}&limit=200`,
      { key: ctx.spaceKey },
    );
    expect(lower.status).toBe(200);
    const lowerIds = (
      (await lower.json()) as { data: { id: string }[] }
    ).data.map((i) => i.id);
    expect(lowerIds).toContain(recent);
    expect(lowerIds).not.toContain(old);

    const upper = await request(
      ctx.app,
      "GET",
      `/items?timestamp_before=${encodeURIComponent(CUTOFF)}&limit=200`,
      { key: ctx.spaceKey },
    );
    expect(upper.status).toBe(200);
    const upperIds = (
      (await upper.json()) as { data: { id: string }[] }
    ).data.map((i) => i.id);
    expect(upperIds).toContain(old);
    expect(upperIds).not.toContain(recent);
  });

  it("includes a row sitting exactly on either bound", async () => {
    const onBound = await seedNote("named-boundary", CUTOFF);

    for (const param of ["timestamp_after", "timestamp_before"]) {
      const res = await request(
        ctx.app,
        "GET",
        `/items?${param}=${encodeURIComponent(CUTOFF)}&limit=200`,
        { key: ctx.spaceKey },
      );
      expect(res.status).toBe(200);
      const ids = ((await res.json()) as { data: { id: string }[] }).data.map(
        (i) => i.id,
      );
      // Both bounds are inclusive, and they are inclusive together. A
      // window closed at one end and open at the other loses a row on the
      // boundary in one direction only, which is the harder half to spot.
      expect(ids).toContain(onBound);
    }
  });
});

describe("updated_after owns the ordering", () => {
  it("refuses a request that also asks for a different sort", async () => {
    const res = await request(
      ctx.app,
      "GET",
      `/items?updated_after=${encodeURIComponent(CUTOFF)}&sort=created_at`,
      { key: ctx.spaceKey },
    );
    expect(res.status).toBe(400);
    expect(((await res.json()) as ErrorBody).error.message).toContain(
      "updated_after",
    );
  });

  it("refuses a request that also asks for descending order", async () => {
    const res = await request(
      ctx.app,
      "GET",
      `/items?updated_after=${encodeURIComponent(CUTOFF)}&direction=desc`,
      { key: ctx.spaceKey },
    );
    expect(res.status).toBe(400);
  });

  it("accepts the sort it would have chosen anyway", async () => {
    // Agreement is not contradiction. Refusing this too would make a
    // client that spells out what it wants worse off than one that does
    // not, for naming the same thing the server picked.
    const res = await request(
      ctx.app,
      "GET",
      `/items?updated_after=${encodeURIComponent(CUTOFF)}&sort=updated_at&direction=asc`,
      { key: ctx.spaceKey },
    );
    expect(res.status).toBe(200);
  });
});

describe("an edges cursor knows which ordering issued it", () => {
  it("refuses a cursor from the default ordering under updated_after", async () => {
    const a = await seedNote("cursor-a");
    const b = await seedNote("cursor-b");
    const c = await seedNote("cursor-c");
    for (const [s, t] of [
      [a, b],
      [b, c],
      [a, c],
    ]) {
      const res = await request(ctx.app, "POST", "/edges", {
        key: ctx.spaceKey,
        body: { source_id: s, target_id: t, edge_type: "references" },
      });
      expect(res.status).toBe(201);
    }

    const first = await request(ctx.app, "GET", "/edges?limit=1", {
      key: ctx.spaceKey,
    });
    expect(first.status).toBe(200);
    const cursor = ((await first.json()) as { cursor: string | null }).cursor;
    expect(cursor).toBeTruthy();

    const replayed = await request(
      ctx.app,
      "GET",
      `/edges?updated_after=${encodeURIComponent("2000-01-01T00:00:00.000Z")}&limit=1&cursor=${encodeURIComponent(cursor ?? "")}`,
      { key: ctx.spaceKey },
    );

    // Both orderings key on an ISO timestamp, so the wrong one compares
    // perfectly well and returns a page that is simply not the next page.
    // Nothing errors, rows are skipped or repeated, and no signal reaches
    // anyone — which is why the cursor has to carry its own ordering.
    expect(replayed.status).toBe(400);
    expect(((await replayed.json()) as ErrorBody).error.message).toContain(
      "ordering",
    );
  });
});
