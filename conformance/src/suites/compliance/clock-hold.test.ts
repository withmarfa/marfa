import { afterAll, describe, expect, it } from "vitest";
import { MarfaClient } from "../../client/api.js";
import { createNote } from "../../generators/items.js";
import { controlRequest } from "../../utils/control-request.js";
import {
  approvedApp,
  bootFreshServer,
  FRESH_SERVER_TIMEOUT_MS,
  stopFreshServers,
  type FreshServer,
} from "../../utils/fresh-server.js";
import {
  DAY_MS,
  HOUR_MS,
  operatorOf,
  QUIET_SCHEDULE,
  runJob,
  writerOf,
} from "../../utils/moved-clock.js";
import type { SseEvent } from "../../utils/sse.js";
import { collectUntil, withStream } from "../../utils/stream.js";
import { QUIET_TUNING, tuning } from "../../utils/tuning.js";
import { beatReceiver } from "../../utils/beat-receiver.js";

/**
 * A server's clock set far ahead of the trusted time holds every job that
 * deletes, and the server stamps by its clock either way. The clock is set,
 * without time passing, through the test hook's `jump_ms`; `advanceClock` is
 * time passing, which the server follows.
 */

afterAll(stopFreshServers, 2 * FRESH_SERVER_TIMEOUT_MS);

const HELD_JOBS = [
  "audit-cleanup",
  "trash-purge",
  "version-thinning",
  "feed-expiry",
  "event-log-cleanup",
  "inbound-delivery-cleanup",
  "bulk-action-gc",
  "table-row-cleanup",
  "credential-cleanup",
  "blob-orphans",
] as const;

const RUNNING_JOBS = ["blob-integrity", "enrichment-sweep"] as const;

/** Sets the server's wall clock by `ms`, as an owner or a host would. */
async function jump(server: FreshServer, ms: number): Promise<void> {
  const moved = await controlRequest(
    server.controlSocket,
    "/_control/test/clock",
    { method: "POST", body: { jump_ms: ms } },
  );
  expect(moved.status, JSON.stringify(moved.body)).toBe(200);
}

async function confirm(server: FreshServer): Promise<string> {
  const confirmed = await controlRequest(
    server.controlSocket,
    "/_control/clock/confirm",
    { method: "POST" },
  );
  expect(confirmed.status, JSON.stringify(confirmed.body)).toBe(200);
  return confirmed.body.confirmed_at as string;
}

interface Health {
  status: string;
  housekeeping: {
    held: {
      reason: string;
      clock_at: string;
      trusted_at: string;
      ends_at: string;
    } | null;
  };
}

async function health(server: FreshServer): Promise<Health> {
  const answer = await fetch(`${server.apiUrl}/health`, {
    headers: { authorization: `Bearer ${server.managementKey}` },
  });
  return (await answer.json()) as Health;
}

interface Concern {
  kind: string;
  reference: string;
  title: string;
  description: string;
}

async function clockConcerns(server: FreshServer): Promise<Concern[]> {
  const answer = await controlRequest(server.controlSocket, "/attention");
  expect(answer.status).toBe(200);
  return (answer.body.data as Concern[]).filter(
    (concern) => concern.kind === "clock",
  );
}

/** How many items the bin holds, read as the owner. */
async function binnedOn(server: FreshServer): Promise<number> {
  const trash = await controlRequest(server.controlSocket, "/trash?limit=100");
  expect(trash.status, JSON.stringify(trash.body)).toBe(200);
  return (trash.body.data as unknown[]).length;
}

async function created(client: MarfaClient, title: string): Promise<string> {
  const made = await client.createItem(
    createNote({ properties: { title, body: title } }),
  );
  expect(made.status, JSON.stringify(made.error)).toBe(201);
  return made.data.item.created_at;
}

/** What RUN-1 read after each jump: the things a clean-up would remove. */
interface Kept {
  binned: number;
  history: number;
  eventLogWhole: boolean;
  audited: number;
  grants: number;
  keyWorks: boolean;
  ownerSignedIn: boolean;
}

describe("the clean-up jobs while the clock is far ahead", () => {
  it(
    "deletes nothing at 2, 31, 61, 91 and 400 days ahead, and cleans up by its rules once the owner confirms the clock",
    async () => {
      const server = await bootFreshServer("clock-hold-run", QUIET_SCHEDULE);
      const writer = writerOf(server);
      const operator = operatorOf(server);

      // RUN-1's seed: a bin, a history, a grant, a key expiring in ten days
      // and the owner's sign-in.
      const binned: string[] = [];
      for (let n = 0; n < 5; n += 1) {
        const made = await writer.createItem(
          createNote({ properties: { title: `binned ${String(n)}` } }),
        );
        expect(made.status).toBe(201);
        binned.push(made.data.item.id);
      }
      expect((await writer.trashItems(binned)).status).toBe(200);
      const made = await writer.createItem(
        createNote({ properties: { title: "edited", body: "0" } }),
      );
      expect(made.status).toBe(201);
      const edited = made.data.item.id;
      for (let version = 1; version <= 5; version += 1) {
        const changed = await writer.updateItem(edited, {
          properties: { body: String(version) },
          version,
        });
        expect(changed.status, JSON.stringify(changed.error)).toBe(200);
      }
      await approvedApp(server, ["core.note:read"]);
      const minted = await writer.createKey({
        label: "expiring",
        source: "clock-hold-expiring",
        type_permissions: { "core.note": "read" },
        expires_at: new Date(Date.now() + 10 * DAY_MS).toISOString(),
      });
      expect(minted.status, JSON.stringify(minted.error)).toBe(201);
      const expiring = minted.data.key!;
      const seededBy = new Date(Date.now() + 1).toISOString();

      const read = async (): Promise<Kept> => {
        const versions = await writer.getVersions(edited, { limit: 100 });
        const frames = await withStream(
          server.apiUrl,
          server.workingKey,
          { lastEventId: "0" },
          async (stream) =>
            (
              await collectUntil(
                stream,
                (events: SseEvent[]) =>
                  events.some(
                    (e) =>
                      e.event === "stream_live" ||
                      e.event === "catchup_too_old",
                  ),
                "the log replayed from its start, or refused as too old",
              )
            ).events,
        );
        const audit = await operator.listAudit({
          created_before: seededBy,
          limit: 100,
        });
        const grants = await fetch(`${server.apiUrl}/grants`, {
          headers: { authorization: `Bearer ${server.managementKey}` },
        });
        const keyed = await fetch(`${server.apiUrl}/items?type=core.note`, {
          headers: { authorization: `Bearer ${expiring}` },
        });
        await keyed.body?.cancel();
        const owner = await fetch(`${server.apiUrl}/owner/passkeys`, {
          headers: { cookie: server.ownerCookie },
        });
        await owner.body?.cancel();
        expect(audit.status).toBe(200);
        return {
          binned: await binnedOn(server),
          history: versions.data.data.length,
          eventLogWhole: !frames.some((e) => e.event === "catchup_too_old"),
          audited: audit.data.data.length,
          grants: ((await grants.json()) as { data: unknown[] }).data.length,
          keyWorks: keyed.status === 200,
          ownerSignedIn: owner.status === 200,
        };
      };

      const seeded = await read();
      expect(seeded).toEqual({
        binned: 5,
        history: seeded.history,
        eventLogWhole: true,
        audited: seeded.audited,
        grants: 1,
        keyWorks: true,
        ownerSignedIn: true,
      });
      expect(seeded.history).toBeGreaterThan(1);
      expect(seeded.audited).toBeGreaterThan(0);
      expect((await health(server)).housekeeping.held).toBeNull();
      expect(await clockConcerns(server)).toEqual([]);

      let set = 0;
      for (const days of [2, 31, 61, 91, 400]) {
        await jump(server, days * DAY_MS - set);
        set = days * DAY_MS;
        const held = days > 7;
        for (const name of HELD_JOBS) {
          const run = await runJob(server, name);
          expect(run.outcome, `${name} at ${String(days)} days`).toBe(
            held ? "held" : "ok",
          );
          if (held) expect(run.result).toEqual({ held: "clock_ahead" });
        }
        if (held) {
          for (const name of RUNNING_JOBS) {
            expect((await runJob(server, name)).outcome, name).toBe("ok");
          }
          const listed = (await operator.listHousekeeping()).data.data;
          for (const name of HELD_JOBS) {
            expect(
              listed.find((row) => row.name === name)?.last_outcome,
              name,
            ).toBe("held");
          }
          const report = await health(server);
          expect(report.status).toBe("degraded");
          expect(report.housekeeping.held?.reason).toBe("clock_ahead");
          const at = report.housekeeping.held!;
          expect(
            Date.parse(at.clock_at) - Date.parse(at.trusted_at),
          ).toBeGreaterThan(7 * DAY_MS);
          expect(Date.parse(at.ends_at)).toBeGreaterThan(
            Date.parse(at.clock_at),
          );
          const concerns = await clockConcerns(server);
          expect(concerns.map((c) => c.reference)).toEqual(["clock_ahead"]);
          expect(concerns[0]!.description).toContain(
            "marfa housekeeping confirm-clock",
          );
        }
        // Set right again, as RUN-1 did before reading what was left.
        await jump(server, -set);
        set = 0;
        expect(await read(), `${String(days)} days ahead`).toEqual(seeded);
      }

      // The witness: the same jobs, once the owner confirms a clock 400 days
      // on, remove what RUN-1 saw removed.
      await jump(server, 400 * DAY_MS);
      const confirmedAt = await confirm(server);
      expect(Date.parse(confirmedAt)).toBeGreaterThan(
        Date.now() + 399 * DAY_MS,
      );
      expect((await health(server)).housekeeping.held).toBeNull();
      expect(await clockConcerns(server)).toEqual([]);
      for (const name of HELD_JOBS) {
        expect((await runJob(server, name)).outcome, name).toBe("ok");
      }
      expect(await read()).toEqual({
        binned: 0,
        history: 1,
        eventLogWhole: false,
        audited: 0,
        grants: 0,
        keyWorks: false,
        ownerSignedIn: false,
      });
    },
    FRESH_SERVER_TIMEOUT_MS + 600_000,
  );

  it(
    "holds an instance whose trusted time is six months old for a day after it starts, then cleans up by its rules",
    async () => {
      const server = await bootFreshServer("clock-hold-asleep", QUIET_SCHEDULE);
      const writer = writerOf(server);
      const made = await writer.createItem(
        createNote({ properties: { title: "binned" } }),
      );
      expect(made.status).toBe(201);
      expect((await writer.trashItems([made.data.item.id])).status).toBe(200);
      const binned = () => binnedOn(server);

      // Started again six months on, with a clock that is right for then.
      await server.restart({
        env: { MARFA_TEST_CLOCK_OFFSET_MS: String(182 * DAY_MS) },
      });
      server.clockOffsetMs = 182 * DAY_MS;
      expect((await runJob(server, "trash-purge")).outcome).toBe("held");
      expect((await health(server)).housekeeping.held?.reason).toBe(
        "clock_ahead",
      );
      await server.advanceClock(23 * HOUR_MS);
      expect((await runJob(server, "trash-purge")).outcome).toBe("held");
      expect(await binned()).toBe(1);

      await server.advanceClock(HOUR_MS);
      expect((await runJob(server, "trash-purge")).outcome).toBe("ok");
      expect((await health(server)).housekeeping.held).toBeNull();
      expect(await binned()).toBe(0);
    },
    FRESH_SERVER_TIMEOUT_MS * 2 + 120_000,
  );

  it(
    "counts the day it holds clean-up across a restart, and ends the hold a day after it began",
    async () => {
      const server = await bootFreshServer(
        "clock-hold-restarted",
        QUIET_SCHEDULE,
      );
      const writer = writerOf(server);
      const made = await writer.createItem(
        createNote({ properties: { title: "binned" } }),
      );
      expect(made.status).toBe(201);
      expect((await writer.trashItems([made.data.item.id])).status).toBe(200);

      await server.restart({
        env: { MARFA_TEST_CLOCK_OFFSET_MS: String(182 * DAY_MS) },
      });
      server.clockOffsetMs = 182 * DAY_MS;
      expect((await runJob(server, "trash-purge")).outcome).toBe("held");
      await server.advanceClock(12 * HOUR_MS);

      // A restart halfway through the day, as a supervisor or a release makes.
      await server.restart();
      expect((await runJob(server, "trash-purge")).outcome).toBe("held");
      expect(await binnedOn(server)).toBe(1);

      await server.advanceClock(12 * HOUR_MS);
      expect((await runJob(server, "trash-purge")).outcome).toBe("ok");
      expect((await health(server)).housekeeping.held).toBeNull();
      expect(await binnedOn(server)).toBe(0);
    },
    FRESH_SERVER_TIMEOUT_MS * 3 + 120_000,
  );

  it(
    "keeps clean-up held after a restart with the clock moved further ahead while it was stopped",
    async () => {
      const server = await bootFreshServer("clock-hold-moved", QUIET_SCHEDULE);
      const writer = writerOf(server);
      const made = await writer.createItem(
        createNote({ properties: { title: "binned" } }),
      );
      expect(made.status).toBe(201);
      expect((await writer.trashItems([made.data.item.id])).status).toBe(200);

      await jump(server, 30 * DAY_MS);
      expect((await runJob(server, "trash-purge")).outcome).toBe("held");

      // Stopped, and started again with the clock two days further on.
      await server.restart({
        env: { MARFA_TEST_CLOCK_OFFSET_MS: String(32 * DAY_MS) },
      });
      server.clockOffsetMs = 32 * DAY_MS;
      expect((await runJob(server, "trash-purge")).outcome).toBe("held");
      const held = (await health(server)).housekeeping.held;
      expect(held?.reason).toBe("clock_ahead");
      expect(
        Date.parse(held!.ends_at) - Date.parse(held!.clock_at),
      ).toBeGreaterThan(23 * HOUR_MS);
      expect(await binnedOn(server)).toBe(1);
    },
    FRESH_SERVER_TIMEOUT_MS * 2 + 120_000,
  );
});

describe("the server's time while the clock is behind", () => {
  it(
    "runs its jobs on schedule while the clock is a day behind",
    async () => {
      const beats = await beatReceiver();
      try {
        const server = await bootFreshServer("clock-hold-behind-jobs", {
          ...tuning(...QUIET_TUNING, "interval.heartbeat=1000"),
          MARFA_HEARTBEAT_URL: beats.url,
        });
        // The witness: the heartbeat runs every second with the clock right.
        await beats.more(2, "two heartbeats with the clock right");

        await jump(server, -DAY_MS);
        expect((await clockConcerns(server)).map((c) => c.reference)).toEqual([
          "clock_behind",
        ]);
        await beats.more(3, "three heartbeats with the clock a day behind");
      } finally {
        await beats.close();
      }
    },
    FRESH_SERVER_TIMEOUT_MS + 120_000,
  );

  it(
    "ends a rate-limit window while the clock is a day behind",
    async () => {
      const server = await bootFreshServer("clock-hold-behind-limit", {
        ...QUIET_SCHEDULE,
        MARFA_RATE_LIMIT_ENABLED: "true",
        MARFA_RATE_LIMIT_REQUESTS: "3",
        MARFA_RATE_LIMIT_WINDOW_SECONDS: "5",
      });
      const listed = () =>
        fetch(`${server.apiUrl}/items?type=core.note&limit=1`, {
          headers: { authorization: `Bearer ${server.workingKey}` },
        });
      /** Spends the window and answers how long the refusal says to wait. */
      const refusedFor = async (): Promise<number> => {
        let refused: Response | undefined;
        for (let sent = 0; sent < 5 && refused === undefined; sent += 1) {
          const answer = await listed();
          await answer.body?.cancel();
          if (answer.status === 429) refused = answer;
          else expect(answer.status).toBe(200);
        }
        expect(
          refused,
          "the fourth request in a window was not refused",
        ).toBeDefined();
        const wait = Number(refused!.headers.get("retry-after"));
        expect(wait).toBeGreaterThan(0);
        expect(wait).toBeLessThanOrEqual(5);
        return wait;
      };
      const admittedAfter = async (seconds: number): Promise<void> => {
        await new Promise((resolve) => setTimeout(resolve, seconds * 1000));
        const after = await listed();
        await after.body?.cancel();
        expect(after.status).toBe(200);
      };

      // A window opened before the step back.
      await refusedFor();
      await jump(server, -DAY_MS);
      await admittedAfter(6);

      // A window opened after it.
      await admittedAfter((await refusedFor()) + 1);
    },
    FRESH_SERVER_TIMEOUT_MS + 120_000,
  );
});

describe("the times the server stamps", () => {
  it(
    "stamps by the clock when it is set back, and keeps the trusted time through a crash",
    async () => {
      const server = await bootFreshServer("clock-hold-stamps", QUIET_SCHEDULE);

      const first = await created(writerOf(server), "before the step back");
      await jump(server, -DAY_MS);
      expect((await clockConcerns(server)).map((c) => c.reference)).toEqual([
        "clock_behind",
      ]);
      const after = await created(writerOf(server), "after the step back");
      expect(Date.parse(after)).toBeLessThan(Date.parse(first) - 23 * HOUR_MS);
      await jump(server, DAY_MS);
      expect(await clockConcerns(server)).toEqual([]);

      // A write two days ahead, and the server killed right after it.
      await jump(server, 2 * DAY_MS);
      const ahead = await created(writerOf(server), "two days ahead");
      expect(Date.parse(ahead)).toBeGreaterThan(Date.now() + DAY_MS);
      await server.restart({ signal: "SIGKILL" });
      // The clock reads right again, and the trusted time is still two days on.
      expect((await clockConcerns(server)).map((c) => c.reference)).toEqual([
        "clock_behind",
      ]);
      const restarted = await created(writerOf(server), "after the crash");
      expect(Math.abs(Date.parse(restarted) - Date.now())).toBeLessThan(
        HOUR_MS,
      );
      // A held job is not held by a clock behind.
      expect((await runJob(server, "trash-purge")).outcome).toBe("ok");

      // Once the owner confirms the clock, it is no longer behind.
      await confirm(server);
      expect(await clockConcerns(server)).toEqual([]);
    },
    FRESH_SERVER_TIMEOUT_MS * 2 + 120_000,
  );

  it(
    "stamps by the clock again once a clock set far ahead is set right",
    async () => {
      const server = await bootFreshServer(
        "clock-hold-set-right",
        QUIET_SCHEDULE,
      );
      const writer = writerOf(server);
      await created(writer, "before the jump");

      await jump(server, 30 * DAY_MS);
      const wrong = await created(writer, "while the clock is wrong");
      expect(Date.parse(wrong)).toBeGreaterThan(Date.now() + 29 * DAY_MS);

      await jump(server, -30 * DAY_MS);
      const right = await created(writer, "after it is set right");
      expect(Math.abs(Date.parse(right) - Date.now())).toBeLessThan(HOUR_MS);
      expect(await clockConcerns(server)).toEqual([]);
    },
    FRESH_SERVER_TIMEOUT_MS + 120_000,
  );
});
