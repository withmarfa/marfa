import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MarfaClient } from "../../client/api.js";
import {
  bootFreshServer,
  FRESH_SERVER_TIMEOUT_MS,
  stopFreshServers,
  type FreshServer,
} from "../../utils/fresh-server.js";
import {
  DAY_MS,
  HOUR_MS,
  movedClock,
  QUIET_SCHEDULE,
  quiet,
  runJob,
  writerOf,
} from "../../utils/moved-clock.js";

/**
 * How long the server keeps the answer to a write sent with an
 * `Idempotency-Key`: as long as the event log, which `event_log_retention_hours`
 * sets. The age of an answer is a clock a fixture cannot wait out, so the case
 * moves the server's clock through the target interface and runs
 * `event-log-cleanup` by hand.
 */

afterAll(stopFreshServers, 2 * FRESH_SERVER_TIMEOUT_MS);

describe("housekeeping and the answers kept under an Idempotency-Key", () => {
  let server: FreshServer;
  let writer: MarfaClient;
  let clock: ReturnType<typeof movedClock>;

  beforeAll(async () => {
    server = await bootFreshServer("housekeeping-idempotency", {
      ...QUIET_SCHEDULE,
    });
    writer = writerOf(server);
    clock = movedClock(server);
    await quiet(server, ["event-log-cleanup"]);
  }, 2 * FRESH_SERVER_TIMEOUT_MS);

  async function retention(hours: number): Promise<void> {
    const set = await writer.patchConfig({ event_log_retention_hours: hours });
    expect(set.status, JSON.stringify(set.error)).toBe(200);
  }

  /** A note created under a key, with the item's id and whether the answer was a replay. */
  async function create(
    key: string,
  ): Promise<{ status: number; id: string; replayed: boolean }> {
    const response = await fetch(`${server.apiUrl}/items`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${server.workingKey}`,
        "Content-Type": "application/json",
        "Idempotency-Key": key,
      },
      body: JSON.stringify({
        type: "core.note",
        properties: { title: "kept under a key", body: key },
      }),
    });
    const body = (await response.json()) as { item?: { id: string } };
    return {
      status: response.status,
      id: body.item?.id ?? "",
      replayed: response.headers.get("Idempotency-Replayed") === "true",
    };
  }

  async function cleanUp(): Promise<void> {
    const run = await runJob(server, "event-log-cleanup");
    expect(run.outcome, String(run.error)).toBe("ok");
  }

  it(
    "replays an answer until event_log_retention_hours has passed, and runs the key as a first attempt after",
    async () => {
      await retention(48);
      const key = `idempotency-window-${randomUUID()}`;
      const first = await create(key);
      expect(first.status).toBe(201);
      expect(first.replayed).toBe(false);

      // Inside the window, after a clean-up has run: the first answer again.
      await clock.advance(47 * HOUR_MS);
      await cleanUp();
      const inside = await create(key);
      expect(inside).toEqual({ status: 201, id: first.id, replayed: true });

      // Past the window: the answer is gone, and the key makes a second item.
      await clock.advance(2 * HOUR_MS);
      await cleanUp();
      const past = await create(key);
      expect(past.status).toBe(201);
      expect(past.replayed).toBe(false);
      expect(past.id).not.toBe(first.id);
    },
    2 * FRESH_SERVER_TIMEOUT_MS,
  );

  it(
    "replays an answer for as long as the event log is kept when event_log_retention_hours is 0",
    async () => {
      await retention(0);
      const key = `idempotency-for-ever-${randomUUID()}`;
      const first = await create(key);
      expect(first.status).toBe(201);

      await clock.advance(400 * DAY_MS);
      await cleanUp();
      const later = await create(key);
      expect(later).toEqual({ status: 201, id: first.id, replayed: true });
    },
    2 * FRESH_SERVER_TIMEOUT_MS,
  );
});
