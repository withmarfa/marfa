import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { v7 as uuidv7 } from "uuid";
import { MarfaClient } from "../../client/api.js";
import { itemsArchive } from "../../utils/archive.js";
import { HOLD, queue, seed } from "../../utils/bulk-jobs.js";
import {
  bootFreshServer,
  FRESH_SERVER_TIMEOUT_MS,
  type FreshServer,
} from "../../utils/fresh-server.js";
import {
  connect,
  issuerOrigin,
  registerApp,
  signIn,
} from "../../utils/signed-in.js";
import {
  DAY_MS,
  operatorOf,
  QUIET_SCHEDULE,
  quiet,
  runJob,
  writerOf,
} from "../../utils/moved-clock.js";
import { DISK_ONLY } from "../../utils/own-blob-server.js";
import { TEST_OWNER } from "../../utils/target.js";

/**
 * `GET /health` answered while each long job runs, between two of its steps,
 * with nothing holding the job (`instance/long-job-health`).
 *
 * **The witness is an order the target records.** Each case holds the job at
 * an early point and arms a second hold at a later step, dozens of the job's
 * turns further on. A `release` fault clears the first hold as the target
 * admits `GET /health`, so the request is already in the server when the job
 * resumes, and the fault records which holds had a caller waiting when that
 * request answered. The server runs each database statement synchronously,
 * so a job that does not hand the process to other requests between its
 * steps runs from the first hold to the second before `/health` can finish
 * the disk and store reads it waits on. A job that yields lets `/health`
 * answer while it is still short of the second hold. The case reads that
 * order from the target, never from when this process sends or receives.
 *
 * `/health` is asked once while the job is held too, so the write probe has
 * committed before the job writes: its outcome answers the calls of the next
 * ten seconds, and a restore holds the write lock until it commits.
 */
let server: FreshServer;

/** Notes enough that each job has dozens of steps between its two holds. */
const ROWS = 4_000;
const TAG = "long-job-health";
/**
 * Grants enough that their retirement takes many steps, in one run: a run
 * retires at most 500.
 */
const GRANTS = 60;
const NEVER_MS = "3153600000000";
const NOTES = "core.note:read";

const working = (): MarfaClient => writerOf(server);

function owner(): MarfaClient {
  return new MarfaClient({
    baseUrl: server.apiUrl,
    ownerCookie: server.ownerCookie,
    ownerCredentials: TEST_OWNER,
    ownerSessionFile: `${server.stateDir}/owner-session.json`,
  });
}

async function health(): Promise<void> {
  const answer = await fetch(`${server.apiUrl}/health`);
  await answer.arrayBuffer();
  expect(answer.status).toBe(200);
}

/** The name of a fault spec, without its argument. */
function nameOf(spec: string): string {
  const at = spec.indexOf("=");
  return at < 0 ? spec : spec.slice(0, at);
}

/**
 * Runs the job once and answers the holds the target recorded as waiting
 * when the `GET /health` that released the job answered. Once that is read,
 * it waits for the job to reach the later hold, which shows the later step
 * is on the job's path, and lets it finish.
 */
async function heldWhenHealthAnswered(job: {
  /** The hold the job waits at before its steps. */
  start: string;
  /** The hold at the later step, armed before the job starts. */
  later: string;
  /** Starts the job, and answers what checks its outcome once it may finish. */
  begin: () => Promise<() => Promise<void>>;
}): Promise<string[]> {
  const release = `release:${job.start.slice("hold:".length)}`;
  await server.setFault(job.start);
  await server.setFault(job.later);
  const finish = await job.begin();
  await server.waitForHold(job.start);
  await health();
  await server.setFault(release);
  await health();
  const recorded = (await server.faults()).find(
    (fault) => fault.name === release,
  );
  expect(recorded?.fired, `${release} released the job`).toBe(1);
  expect(recorded?.held_when_answered, "/health answered").toBeDefined();
  await server.waitForHold(nameOf(job.later));
  await server.clearFault();
  await finish();
  return recorded?.held_when_answered ?? [];
}

/** Every audit entry recorded for `action`. */
async function audited(action: string): Promise<number> {
  let count = 0;
  let cursor: string | undefined;
  do {
    const page = await operatorOf(server).listAudit({
      action,
      limit: 200,
      cursor,
    });
    expect(page.status).toBe(200);
    count += page.data.data.length;
    cursor = page.data.next_cursor ?? undefined;
  } while (cursor !== undefined);
  return count;
}

beforeAll(async () => {
  server = await bootFreshServer("long-job-health", {
    ...DISK_ONLY,
    ...QUIET_SCHEDULE,
    MARFA_BLOB_CLEANUP_INTERVAL_MS: NEVER_MS,
  });
  await quiet(server, ["version-thinning", "blob-orphans"]);
  await seed(working(), TAG, ROWS);
  // Three updates each leave three earlier versions, so every note is a
  // candidate for version thinning that its policy keeps whole.
  for (const pass of [1, 2, 3]) {
    const done = await working().pollBulkActionToTerminal(
      await queue(working(), {
        action: "update_properties",
        patch: { pass },
        filter: { tags: [TAG] },
        max_items: ROWS,
      }),
      { timeoutMs: 600_000 },
    );
    expect(done).toMatchObject({ status: "completed", processed: ROWS });
  }
}, 900_000);

afterAll(async () => {
  await server.stop();
}, FRESH_SERVER_TIMEOUT_MS);

describe("GET /health while a long job runs", () => {
  it("is answered between two pages of an NDJSON export", async () => {
    // One item on the first page and sixteen on each after it.
    const held = await heldWhenHealthAnswered({
      start: "hold:read-hydration",
      later: "hold:export-page=100",
      begin: async () => {
        const exporting = fetch(`${server.apiUrl}/export`, {
          headers: { authorization: `Bearer ${server.workingKey}` },
        }).then(async (answer) => ({
          status: answer.status,
          text: await answer.text(),
        }));
        return async () => {
          const exported = await exporting;
          expect(exported.status, exported.text.slice(0, 200)).toBe(200);
          expect(
            exported.text.split("\n").filter((line) => line.includes('"item"'))
              .length,
          ).toBeGreaterThanOrEqual(ROWS);
        };
      },
    });
    expect(held).toEqual([]);
  }, 600_000);

  it("is answered between two pages of an archive export", async () => {
    // Twenty-five items a page.
    const held = await heldWhenHealthAnswered({
      start: "hold:read-hydration",
      later: "hold:export-page=100",
      begin: async () => {
        const exporting = working().exportArchive();
        return async () => {
          expect((await exporting).status).toBe(200);
        };
      },
    });
    expect(held).toEqual([]);
  }, 600_000);

  it("is answered between placing an archive restore's blobs and committing its rows", async () => {
    // The restore places the archive's blob before it writes a row, and
    // waits with every row written before it commits.
    const held = await heldWhenHealthAnswered({
      start: "hold:blob-write",
      later: "hold:restore:before-commit",
      begin: async () => {
        const source = `${TAG}-restore-${uuidv7()}`;
        const archive = itemsArchive(
          Array.from({ length: ROWS }, (_, index) => ({
            id: uuidv7(),
            type: "core.note",
            source,
            properties: { body: `restored ${String(index)}` },
          })),
          [{ data: randomBytes(64), mime_type: "application/octet-stream" }],
        );
        const restoring = owner().restoreArchive(archive);
        return async () => {
          const restored = await restoring;
          expect(restored.status, JSON.stringify(restored.error)).toBe(200);
          expect(restored.data.imported).toBe(ROWS);
        };
      },
    });
    expect(held).toEqual([]);
  }, 600_000);

  it("is answered between two chunks of a bulk action", async () => {
    // A hundred items a chunk.
    const held = await heldWhenHealthAnswered({
      start: HOLD.claimed,
      later: `${HOLD.betweenChunks}=10`,
      begin: async () => {
        const id = await queue(working(), {
          action: "update_properties",
          patch: { pass: 4 },
          filter: { tags: [TAG] },
          max_items: ROWS,
        });
        return async () => {
          const done = await working().pollBulkActionToTerminal(id, {
            timeoutMs: 600_000,
          });
          expect(done).toMatchObject({ status: "completed", processed: ROWS });
        };
      },
    });
    expect(held).toEqual([]);
  }, 900_000);

  it("is answered between two pages of the blob orphan sweep", async () => {
    // The sweep reads every item, edge, version and pending patch, two
    // hundred a page, before it purges a blob an earlier run reported.
    const uploaded = await working().uploadBlob(
      randomBytes(64),
      "application/octet-stream",
    );
    expect(uploaded.status, JSON.stringify(uploaded.error)).toBe(201);
    await runJob(server, "blob-orphans");
    const held = await heldWhenHealthAnswered({
      start: "hold:housekeeping:blob-orphans",
      later: "hold:blob-orphans:purge",
      begin: async () => {
        const sweeping = operatorOf(server).runHousekeeping("blob-orphans");
        return async () => {
          const run = await sweeping;
          expect(run.status, JSON.stringify(run.error)).toBe(200);
          const report = await operatorOf(server).listBlobOrphans();
          expect(report.status, JSON.stringify(report.error)).toBe(200);
          expect(
            report.data.data.some((row) => row.hash === uploaded.data.hash),
            "the sweep purged the orphan",
          ).toBe(false);
        };
      },
    });
    expect(held).toEqual([]);
  }, 600_000);

  it("is answered between two pages of version thinning", async () => {
    // Every note is a candidate its policy keeps whole. The one item the
    // job thins is the last it reaches, by id: created after them, of a
    // type that keeps one version.
    const type = `user.longjobhealth${String(Date.now())}`;
    const registered = await working().registerType({
      id: type,
      fields: { title: { type: "string" } },
      version_policy: { max_versions: 1 },
    } as Parameters<MarfaClient["registerType"]>[0]);
    expect(registered.status, JSON.stringify(registered.error)).toBe(201);
    const created = await working().createItem({
      type,
      properties: { title: "v1" },
    });
    expect(created.status, JSON.stringify(created.error)).toBe(201);
    const last = created.data.item;
    for (let earlier = 0; earlier < 3; earlier++) {
      const updated = await working().updateItem(last.id, {
        properties: { title: `v${String(last.version + 1)}` },
        version: last.version,
      });
      expect(updated.status, JSON.stringify(updated.error)).toBe(200);
      last.version = updated.data.item.version;
    }

    const held = await heldWhenHealthAnswered({
      start: "hold:housekeeping:version-thinning",
      later: "hold:version-thinning:item",
      begin: async () => {
        const thinning = operatorOf(server).runHousekeeping("version-thinning");
        return async () => {
          const run = await thinning;
          expect(run.status, JSON.stringify(run.error)).toBe(200);
          expect(run.data.result).toMatchObject({ pruned: 2 });
        };
      },
    });
    expect(held).toEqual([]);
  }, 600_000);

  /**
   * Last in the file, because it moves the server's clock a year, which
   * ends every session and sign-in made before it.
   */
  it("is answered between two grants of the retirement of inactive grants", async () => {
    const job = "grant-inactivity-retirement";
    const action = "auth.grant.retired";
    // One sign-in for every grant: the owner's address may make ten
    // password attempts in fifteen minutes.
    const origin = await issuerOrigin(server);
    const cookie = await signIn(server, origin);
    for (let made = 0; made < GRANTS; made += 10) {
      await Promise.all(
        Array.from({ length: 10 }, async () =>
          connect(
            server,
            origin,
            cookie,
            await registerApp(server, NOTES),
            NOTES,
          ),
        ),
      );
    }
    const before = await audited(action);

    const held = await heldWhenHealthAnswered({
      start: `hold:housekeeping:${job}`,
      // Each grant's retirement is a write of its own, after a turn.
      later: `hold:write=${action}@30`,
      begin: async () => {
        // The move makes the job due, and the scheduler may start it before
        // this request does: either run waits at the hold.
        await server.advanceClock(366 * DAY_MS);
        const retiring = operatorOf(server).runHousekeeping(job);
        return async () => {
          const asked = await retiring;
          if (asked.status !== 200) {
            expect(asked.error?.error.code).toBe("housekeeping_job_running");
            await runJob(server, job);
          }
          expect((await audited(action)) - before).toBe(GRANTS);
        };
      },
    });
    expect(held).toEqual([]);
  }, 900_000);
});
