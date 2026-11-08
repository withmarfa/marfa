import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MarfaClient } from "../../client/api.js";
import {
  bootFreshServer,
  FRESH_SERVER_TIMEOUT_MS,
  stopFreshServers,
  type FreshServer,
} from "../../utils/fresh-server.js";
import { streamHead } from "../../utils/stream-tap.js";
import { waitFor } from "../../utils/wait.js";

/**
 * The job that fans the event log out to webhook subscriptions keeps its
 * place in the log, and a place the log cannot account for is one it must say
 * so about, rather than skip what lies between.
 *
 * A server of its own: no door moves the place or removes an event, so a
 * fault makes the job read an event, or the place, as absent and the fixture
 * asks the job over HTTP.
 */
let server: FreshServer | undefined;

beforeAll(async () => {
  server = await bootFreshServer("webhook-schedule-gap");
  for (let n = 1; n <= 3; n += 1) {
    const created = await client(server.workingKey).createItem({
      type: "core.note",
      properties: { body: `schedule-gap-${String(n)}` },
    });
    expect(created.ok, JSON.stringify(created.error)).toBe(true);
  }
}, FRESH_SERVER_TIMEOUT_MS);

afterAll(stopFreshServers, 2 * FRESH_SERVER_TIMEOUT_MS);

function client(key: string): MarfaClient {
  return new MarfaClient({ baseUrl: server!.apiUrl, apiKey: key });
}

/** One run of `webhook-schedule`, again while the server's own run holds its
 *  name, and what the job's listing then says of its last outcome. */
async function scheduled(): Promise<{
  run: "ok" | "error";
  listed: "ok" | "error" | null;
}> {
  const operator = client(server!.managementKey);
  const ran = await waitFor(
    "webhook-schedule to run",
    async () => {
      const answer = await operator.runHousekeeping("webhook-schedule");
      if (answer.status === 409) return undefined;
      expect(answer.status, JSON.stringify(answer.error)).toBe(200);
      return answer.data;
    },
    30_000,
  );
  const jobs = await operator.listHousekeeping();
  const job = jobs.data.data.find((row) => row.name === "webhook-schedule");
  return { run: ran.outcome, listed: job?.last_outcome ?? null };
}

const hidden = (first: bigint, last: bigint = first) =>
  `hide:event=${first === last ? String(first) : `${String(first)}-${String(last)}`}`;

async function head(): Promise<bigint> {
  return BigInt(await streamHead(server!.apiUrl, server!.workingKey));
}

/** Writes `count` notes and checks each added one event to the log. */
async function write(count: number): Promise<void> {
  const before = await head();
  for (let n = 0; n < count; n += 1) {
    const created = await client(server!.workingKey).createItem({
      type: "core.note",
      properties: { body: `schedule-gap-more-${String(n)}` },
    });
    expect(created.ok, JSON.stringify(created.error)).toBe(true);
  }
  expect(await head()).toBe(before + BigInt(count));
}

/**
 * Each gap is a fault armed from the log's head, `h`, once the job has caught
 * up with it, so the job's place is `h`, and the events written after it.
 */
const gaps: readonly {
  name: string;
  fault: (h: bigint) => string;
  writes: number;
}[] = [
  { name: "ahead of the log", fault: (h) => hidden(h), writes: 0 },
  {
    name: "at a hole in the retained events",
    fault: (h) => hidden(h + 1n),
    writes: 2,
  },
  {
    name: "behind the oldest event the log retains",
    fault: (h) => hidden(1n, h + 1n),
    writes: 2,
  },
  {
    name: "missing from a log that holds events",
    fault: () => "hide:webhook-position",
    writes: 0,
  },
];

describe("the place the webhook-schedule job keeps in the event log", () => {
  it("ends a webhook-schedule run with error when its log position cannot be accounted for", async () => {
    for (const gap of gaps) {
      // The witness, before each gap: the job ends a run well on a place the
      // log accounts for, so the error that follows is the gap's.
      expect(await scheduled(), `before the position was ${gap.name}`).toEqual({
        run: "ok",
        listed: "ok",
      });

      const fault = gap.fault(await head());
      await server!.setFault(fault);
      await write(gap.writes);
      expect(await scheduled(), `with the position ${gap.name}`).toEqual({
        run: "error",
        listed: "error",
      });
      await server!.clearFault(fault.split("=")[0]);
    }
    // The witness for the last gap, and for the events written under the others.
    expect(await scheduled(), "after the last gap").toEqual({
      run: "ok",
      listed: "ok",
    });
  });
});
