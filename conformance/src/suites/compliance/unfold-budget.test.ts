import { describe, it, expect, beforeAll } from "vitest";
import { MarfaClient } from "../../client/api.js";
import {
  bootFreshServer,
  FRESH_SERVER_TIMEOUT_MS,
} from "../../utils/fresh-server.js";

/**
 * The work one `GET /occurrences` request may spend on series that unfold to
 * nothing. A rule that repeats every second from 1990 walks to the iteration
 * cap of one series before it reaches any window decades later, so each one
 * costs a whole series' walk and puts nothing in the window.
 *
 * The server is the file's own: the series pass reads every rule on the
 * instance, so the count of series a read reached is only exact where this
 * file's rules are the whole calendar.
 */

/** The cost of one rule's walk is the series cap, and the request budget is
 *  twenty of them. */
const SERIES_BEFORE_THE_BUDGET = 20;
const BUDGET = 2_000_000;

let client: MarfaClient;

beforeAll(async () => {
  const server = await bootFreshServer("unfold-budget");
  client = new MarfaClient({
    baseUrl: server.apiUrl,
    apiKey: server.workingKey,
  });
}, FRESH_SERVER_TIMEOUT_MS);

interface Answer {
  data: unknown[];
  expansion_incomplete?: boolean;
  series_errors?: { item_id: string }[];
  scan: Record<string, number>;
}

async function costly(): Promise<string> {
  const r = await client.createItem({
    type: "core.event",
    properties: {
      title: "a rule too costly to unfold",
      starts_at: "1990-01-15T09:00:00.000Z",
      recurrence: ["RRULE:FREQ=SECONDLY"],
    },
  });
  expect(r.status, JSON.stringify(r.error)).toBe(201);
  return r.data.item.id;
}

async function read(): Promise<Answer> {
  const r = await client.listOccurrences({
    from: "2041-09-01T00:00:00Z",
    to: "2041-09-08T00:00:00Z",
  });
  expect(r.status, JSON.stringify(r.error)).toBe(200);
  return r.data as unknown as Answer;
}

describe("the request budget for unfolding series", () => {
  it("answers expansion_incomplete and counts the series it never reached, naming none of them", async () => {
    const ids: string[] = [];
    for (let i = 0; i < SERIES_BEFORE_THE_BUDGET; i += 1) {
      ids.push(await costly());
    }

    // The witness: up to the budget every series is reached, stopped by its
    // own bound and named, so nothing is counted that the list does not name.
    const within = await read();
    expect(within.scan.max_unproductive_iterations).toBe(BUDGET);
    expect(within.expansion_incomplete).toBe(true);
    expect(within.scan.series_unexpanded).toBe(SERIES_BEFORE_THE_BUDGET);
    expect(within.series_errors?.map((e) => e.item_id).sort()).toEqual(
      [...ids].sort(),
    );
    expect(within.scan.unproductive_iterations).toBeGreaterThanOrEqual(BUDGET);

    // One series past it is never walked: counted, not named.
    ids.push(await costly());
    const past = await read();
    expect(past.expansion_incomplete).toBe(true);
    expect(past.scan.series_unexpanded).toBe(SERIES_BEFORE_THE_BUDGET + 1);
    const named = (past.series_errors ?? []).map((e) => e.item_id);
    expect(named).toHaveLength(SERIES_BEFORE_THE_BUDGET);
    expect(past.scan.series_errors).toBe(SERIES_BEFORE_THE_BUDGET);
    expect(ids.filter((id) => !named.includes(id))).toHaveLength(1);
  }, 300_000);
});
