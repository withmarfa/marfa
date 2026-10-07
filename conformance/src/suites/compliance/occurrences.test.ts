import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { MarfaClient } from "../../client/api.js";
import type { TestContext } from "../../client/types.js";
import { createTestContext, trackItem, cleanup } from "../../utils/setup.js";
import { expectMatchesSchema } from "../../utils/openapi.js";

let client: MarfaClient;
let ctx: TestContext;
let apiUrl: string;

beforeAll(async () => {
  ({ ctx, client, apiUrl } = await createTestContext(
    "compliance",
    "occurrences",
  ));
});

afterAll(async () => {
  await cleanup(ctx);
});

async function seedEvent(title: string, startsAt: string, endsAt: string) {
  const r = await client.createItem({
    type: "core.event",
    source: ctx.source,
    properties: { title, starts_at: startsAt, ends_at: endsAt },
  });
  expect(r.ok).toBe(true);
  trackItem(ctx, r.data.item.id);
  return r.data.item.id;
}

describe("occurrences", () => {
  it("expands events inside the window and excludes those outside it", async () => {
    const inside = await seedEvent(
      `occ-in-${ctx.runId}`,
      "2031-03-10T10:00:00.000Z",
      "2031-03-10T11:00:00.000Z",
    );
    const outside = await seedEvent(
      `occ-out-${ctx.runId}`,
      "2031-03-20T10:00:00.000Z",
      "2031-03-20T11:00:00.000Z",
    );

    const r = await client.listOccurrences({
      from: "2031-03-10T00:00:00.000Z",
      to: "2031-03-11T00:00:00.000Z",
    });
    expect(r.ok).toBe(true);
    await expectMatchesSchema("GET", "/occurrences", 200, r.data);
    const ids = r.data.data.map((o) => o.item.id);
    expect(ids).toContain(inside);
    expect(ids).not.toContain(outside);
    const hit = r.data.data.find((o) => o.item.id === inside);
    expect(hit?.starts_at).toBe("2031-03-10T10:00:00.000Z");
    expect(hit?.ends_at).toBe("2031-03-10T11:00:00.000Z");
    expect(r.data.window.from).toBe("2031-03-10T00:00:00.000Z");
    expect(r.data.scan.events_read).toBeGreaterThanOrEqual(1);
  });

  it("orders the window by starts_at ascending, not by write order", async () => {
    const later = await seedEvent(
      `occ-later-${ctx.runId}`,
      "2031-06-05T15:00:00.000Z",
      "2031-06-05T16:00:00.000Z",
    );
    const earlier = await seedEvent(
      `occ-earlier-${ctx.runId}`,
      "2031-06-05T09:00:00.000Z",
      "2031-06-05T10:00:00.000Z",
    );

    const r = await client.listOccurrences({
      from: "2031-06-05T00:00:00.000Z",
      to: "2031-06-06T00:00:00.000Z",
    });
    expect(r.ok).toBe(true);
    const ids = r.data.data.map((o) => o.item.id);
    expect(ids).toContain(earlier);
    expect(ids).toContain(later);
    // Positions rather than a sorted comparison: the later row was written
    // first, so write order and start order disagree and only one of them can
    // produce this.
    expect(ids.indexOf(earlier)).toBeLessThan(ids.indexOf(later));
    expect(r.data.data[ids.indexOf(earlier)].starts_at).toBe(
      "2031-06-05T09:00:00.000Z",
    );
    expect(r.data.data[ids.indexOf(later)].starts_at).toBe(
      "2031-06-05T15:00:00.000Z",
    );
  });

  it("refuses a missing or inverted window", async () => {
    const missing = await client.listOccurrences({});
    expect(missing.status).toBe(400);
    expect(missing.error?.error.code).toBe("missing_required_field");

    // Each bound on its own, because a request omitting both cannot tell
    // one required bound from two: a door requiring only `from` refuses
    // the empty request the same way.
    const noTo = await client.listOccurrences({
      from: "2031-03-10T00:00:00.000Z",
    });
    expect(noTo.status).toBe(400);
    expect(noTo.error?.error.code).toBe("missing_required_field");

    const noFrom = await client.listOccurrences({
      to: "2031-03-11T00:00:00.000Z",
    });
    expect(noFrom.status).toBe(400);
    expect(noFrom.error?.error.code).toBe("missing_required_field");

    const inverted = await client.listOccurrences({
      from: "2031-03-11T00:00:00.000Z",
      to: "2031-03-10T00:00:00.000Z",
    });
    expect(inverted.status).toBe(400);
    expect(inverted.error?.error.code).toBe("validation_error");
  });

  it("reads each bound of the window in any ISO 8601 spelling and answers the window in UTC", async () => {
    const id = await seedEvent(
      `occ-spelling-${ctx.runId}`,
      "2031-08-10T10:00:00.000Z",
      "2031-08-10T11:00:00.000Z",
    );
    // Every pair names the same window, 10:00Z to 12:00Z on 10 August 2031.
    for (const [from, to] of [
      ["2031-08-10T10:00:00Z", "2031-08-10T12:00:00Z"],
      ["2031-08-10T10:00:00.000Z", "2031-08-10T12:00:00.000Z"],
      ["2031-08-10T12:00:00+02:00", "2031-08-10T14:00:00+02:00"],
      ["2031-08-10T05:00:00-05:00", "2031-08-10T07:00:00-05:00"],
      ["2031-08-10T10:00Z", "2031-08-10T12:00Z"],
    ]) {
      const r = await client.listOccurrences({ from, to });
      expect(r.status, `${from} ${to}: ${JSON.stringify(r.error)}`).toBe(200);
      expect(r.data.window).toEqual({
        from: "2031-08-10T10:00:00.000Z",
        to: "2031-08-10T12:00:00.000Z",
      });
      expect(r.data.data.map((o) => o.item.id)).toContain(id);
    }

    // A date with no time is its midnight in UTC.
    const dates = await client.listOccurrences({
      from: "2031-08-10",
      to: "2031-08-11",
    });
    expect(dates.status, JSON.stringify(dates.error)).toBe(200);
    expect(dates.data.window).toEqual({
      from: "2031-08-10T00:00:00.000Z",
      to: "2031-08-11T00:00:00.000Z",
    });
    expect(dates.data.data.map((o) => o.item.id)).toContain(id);
  });

  it("refuses a bound that is no timestamp, naming which", async () => {
    // The witness: the same request with readable bounds is answered.
    const ok = await client.listOccurrences({
      from: "2031-08-10T00:00:00Z",
      to: "2031-08-11T00:00:00Z",
    });
    expect(ok.status).toBe(200);

    for (const [from, to, named] of [
      ["banana", "2031-08-11T00:00:00Z", "from"],
      ["2031-08-10T00:00:00Z", "banana", "to"],
    ] as const) {
      const r = await client.listOccurrences({ from, to });
      expect(r.status, named).toBe(400);
      expect(r.error?.error.code, named).toBe("validation_error");
      expect(r.error?.error.details, named).toHaveProperty(named);
    }
  });

  it("refuses a window whose end is its start", async () => {
    const r = await client.listOccurrences({
      from: "2031-08-10T00:00:00Z",
      to: "2031-08-10T00:00:00Z",
    });
    expect(r.status).toBe(400);
    expect(r.error?.error.code).toBe("validation_error");
  });

  it("refuses a request with no credential", async () => {
    const anonymous = new MarfaClient({ baseUrl: apiUrl, apiKey: "" });
    const r = await anonymous.listOccurrences({
      from: "2031-03-10T00:00:00.000Z",
      to: "2031-03-11T00:00:00.000Z",
    });
    expect(r.status).toBe(401);
  });
});
