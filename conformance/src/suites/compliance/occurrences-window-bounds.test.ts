import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MarfaClient } from "../../client/api.js";
import {
  bootFreshServer,
  FRESH_SERVER_TIMEOUT_MS,
  type FreshServer,
} from "../../utils/fresh-server.js";

/**
 * A window bound is read by the timestamp rules every write follows, and
 * the host's time zone has no say. The server here runs in a zone ahead of
 * UTC, so a bound read as local time lands on another instant than the same
 * bound read as UTC, and the event below falls in one window and out of the
 * other.
 */

let server: FreshServer;
let client: MarfaClient;

beforeAll(async () => {
  server = await bootFreshServer("occurrences-window-bounds", {
    TZ: "Pacific/Auckland",
  });
  client = new MarfaClient({
    baseUrl: server.apiUrl,
    apiKey: server.workingKey,
  });
}, FRESH_SERVER_TIMEOUT_MS);

afterAll(async () => {
  await server?.stop();
}, FRESH_SERVER_TIMEOUT_MS);

async function seedEvent(startsAt: string, endsAt: string): Promise<string> {
  const r = await client.createItem({
    type: "core.event",
    source: "occurrences-window-bounds",
    properties: { title: "window bound", starts_at: startsAt, ends_at: endsAt },
  });
  expect(r.ok, JSON.stringify(r.error)).toBe(true);
  return r.data.item.id;
}

describe("occurrence window bounds", () => {
  it("reads a zone-less bound as UTC under a host zone that is not UTC", async () => {
    // The event runs 10:00Z to 11:00Z. Auckland is 12 hours ahead of UTC
    // in August, and each window below is chosen so the two readings
    // disagree about whether it holds the event.
    const id = await seedEvent("2031-08-10T10:00:00Z", "2031-08-10T11:00:00Z");

    // Under UTC: 09:00Z to 12:00Z holds the event. Under Auckland time the
    // same text is 21:00Z the day before to 00:00Z, which does not.
    const holds = await client.listOccurrences({
      from: "2031-08-10T09:00:00",
      to: "2031-08-10T12:00:00",
    });
    expect(holds.status, JSON.stringify(holds.error)).toBe(200);
    expect(holds.data.window).toEqual({
      from: "2031-08-10T09:00:00.000Z",
      to: "2031-08-10T12:00:00.000Z",
    });
    expect(holds.data.data.map((o) => o.item.id)).toContain(id);

    // Under UTC: 11:00Z to 13:00Z starts as the event ends and holds
    // nothing. Under Auckland time the same text is 23:00Z the day before to
    // 01:00Z, which holds it.
    const misses = await client.listOccurrences({
      from: "2031-08-10T11:00:00",
      to: "2031-08-10T13:00:00",
    });
    expect(misses.status, JSON.stringify(misses.error)).toBe(200);
    expect(misses.data.window.from).toBe("2031-08-10T11:00:00.000Z");
    expect(misses.data.data.map((o) => o.item.id)).not.toContain(id);
  });

  it("refuses an impossible date and a string that is not ISO 8601, naming the bound", async () => {
    // The witness: a readable window is answered.
    const ok = await client.listOccurrences({
      from: "2031-02-28",
      to: "2031-03-02",
    });
    expect(ok.status).toBe(200);

    for (const [from, to, named] of [
      ["2031-02-30", "2031-03-05", "from"],
      ["2031-02-01", "2031-02-30", "to"],
      ["2031-02-30T10:00:00", "2031-03-05T00:00:00Z", "from"],
      ["Aug 10 2031", "2031-08-11T00:00:00Z", "from"],
      ["2031-08-10T00:00:00Z", "Aug 11 2031", "to"],
    ] as const) {
      const r = await client.listOccurrences({ from, to });
      expect(r.status, `${from} ${to}`).toBe(400);
      expect(r.error?.error.code, `${from} ${to}`).toBe("validation_error");
      expect(r.error?.error.details, `${from} ${to}`).toMatchObject({
        field: named,
      });
    }
  });
});
