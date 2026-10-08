import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MarfaClient } from "../../client/api.js";
import {
  bootFreshServer,
  FRESH_SERVER_TIMEOUT_MS,
  stopFreshServers,
  type FreshServer,
} from "../../utils/fresh-server.js";
import { withInstanceDatabase } from "../../utils/instance-database.js";
import { waitFor } from "../../utils/wait.js";
import type { DatabaseSync } from "node:sqlite";

/**
 * The job that fans the event log out to webhook subscriptions keeps its
 * place in the log, and a place the log cannot account for is one it must say
 * so about, rather than skip what lies between.
 *
 * A server of its own: the place is a row of the stored database, which no
 * door moves, so the file moves it while the server is stopped and asks the
 * job over HTTP.
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

const head = (db: DatabaseSync): number =>
  (db.prepare("SELECT MAX(id) AS id FROM event_log").get() as { id: number })
    .id;

/** A place the log accounts for: the head, with nothing half done. */
function accountedFor(db: DatabaseSync): void {
  db.prepare(
    "UPDATE outbound_webhook_checkpoint SET last_event_id = ?, event_id = NULL, after_subscription_id = NULL",
  ).run(String(head(db)));
}

const gaps: readonly {
  name: string;
  arrange: (db: DatabaseSync) => void;
}[] = [
  {
    name: "ahead of the log",
    arrange: (db) => {
      db.prepare(
        "UPDATE outbound_webhook_checkpoint SET last_event_id = ?, event_id = NULL, after_subscription_id = NULL",
      ).run(String(head(db) + 1000));
    },
  },
  {
    name: "behind the oldest event the log retains",
    arrange: (db) => {
      expect(head(db)).toBeGreaterThan(1);
      db.prepare(
        "UPDATE outbound_webhook_checkpoint SET last_event_id = '0', event_id = NULL, after_subscription_id = NULL",
      ).run();
      db.prepare("DELETE FROM event_log WHERE id < ?").run(head(db));
    },
  },
  {
    name: "missing from a log that holds events",
    arrange: (db) => {
      db.prepare("DELETE FROM outbound_webhook_checkpoint").run();
    },
  },
];

describe("the place the webhook-schedule job keeps in the event log", () => {
  it("ends a webhook-schedule run with error when its log position cannot be accounted for", async () => {
    for (const gap of gaps) {
      // The witness, before each gap: the job ends a run well on a place the
      // log accounts for, so the error that follows is the gap's.
      await server!.restart({
        whileStopped: () => {
          withInstanceDatabase(server!.sqlitePath, (db) => {
            const row = db
              .prepare("SELECT 1 AS present FROM outbound_webhook_checkpoint")
              .get();
            if (row === undefined) {
              db.prepare(
                "INSERT INTO outbound_webhook_checkpoint (id, last_event_id) VALUES (1, '0')",
              ).run();
            }
            accountedFor(db);
          });
        },
      });
      expect(await scheduled(), `before the position was ${gap.name}`).toEqual({
        run: "ok",
        listed: "ok",
      });

      await server!.restart({
        whileStopped: () => {
          withInstanceDatabase(server!.sqlitePath, gap.arrange);
        },
      });
      expect(await scheduled(), `with the position ${gap.name}`).toEqual({
        run: "error",
        listed: "error",
      });
    }
  });
});
