import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { v7 as uuidv7 } from "uuid";
import { MarfaClient } from "../../client/api.js";
import type { MarfaItem } from "../../client/types.js";
import { itemsArchive } from "../../utils/archive.js";
import { HOLD, jobOf, queue, seed } from "../../utils/bulk-jobs.js";
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
 * **The witness is an order, not a time.** The server runs each database
 * statement synchronously, so a job that does not hand the process to other
 * requests between its steps answers nothing from the moment it resumes
 * until it ends or reaches a point that holds it. Each case holds the job at
 * an early point, releases it, asks `GET /health`, and only once that is
 * answered looks for a later step of the job the client can see: a second
 * hold it has not reached, a report it has not yet written, a progress count
 * below its total, or a change made after `/health` answered that the job
 * then read. A job that does not yield is past that step, or held at it,
 * before `/health` is answered, every time.
 *
 * A held job yields on purpose, so `/health` is asked only after the first
 * hold is released, and nothing holds the job between the two steps. It is
 * asked once while the job is held too, so the write probe has committed
 * before the job writes: the probe's outcome answers the calls of the next
 * ten seconds, and a restore holds the write lock until it commits.
 *
 * **A slow client sees nothing either way.** If this process is slow to send
 * the request, a job that yields can reach the later step before `/health`
 * arrives. That attempt proves nothing, so the case runs the job again, up
 * to `ATTEMPTS` times. A job that does not yield fails every attempt.
 */
let server: FreshServer;

const ATTEMPTS = 3;
/** Notes enough that each job has dozens of steps between its two points. */
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

/**
 * The lines of a whole NDJSON export, read as fast as they arrive, so the
 * export never waits on this process to take what it has sent.
 */
async function exportLines(): Promise<{ item?: MarfaItem }[]> {
  const answer = await fetch(`${server.apiUrl}/export`, {
    headers: { authorization: `Bearer ${server.workingKey}` },
  });
  const text = await answer.text();
  expect(answer.status, text.slice(0, 200)).toBe(200);
  return text
    .split("\n")
    .filter((line) => line !== "")
    .map((line) => JSON.parse(line) as { item?: MarfaItem });
}

async function fault(
  name: string,
): Promise<{ waiting: number; fired: number }> {
  const armed = (await server.faults()).find((entry) => entry.name === name);
  expect(armed, `${name} is armed`).toBeDefined();
  return { waiting: armed?.waiting ?? 0, fired: armed?.fired ?? 0 };
}

/** One run of a job, started while `start` holds it. */
interface Run {
  /** Called as soon as `/health` has answered: whether the job is short of its later step. */
  short(): Promise<boolean>;
  /**
   * Lets the job run to its end. Answers false when what the job did shows
   * it was past its later step when `short` was called after all.
   */
  finish(): Promise<boolean | void>;
}

/**
 * Runs the job until `/health` is seen answered between its two steps, and
 * answers the attempt that saw it, or 0 when none did.
 */
async function answeredBetween(job: {
  /** Makes the next run's work, before anything holds the job. */
  prepare?: () => Promise<void>;
  /** The hold the job waits at before its steps. */
  start: string;
  /** Arms the later step and starts the job. */
  begin: () => Promise<Run>;
}): Promise<number> {
  for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
    await job.prepare?.();
    await server.setFault(job.start);
    const run = await job.begin();
    await server.waitForHold(job.start);
    await health();
    await server.clearFault(job.start);
    await health();
    const short = await run.short();
    const confirmed = (await run.finish()) !== false;
    await server.clearFault();
    if (short && confirmed) return attempt;
  }
  return 0;
}

const NOT_SEEN = `no attempt of ${String(ATTEMPTS)} saw /health answered while the job ran unheld between two steps`;

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
    // The item the export reaches last, which a change made once `/health`
    // has answered shows in the export only while it is still reading pages.
    const items = (await exportLines()).flatMap((line) =>
      line.item === undefined ? [] : [line.item],
    );
    const last = items.at(-1);
    expect(last, "the export holds items").toBeDefined();
    if (last === undefined) return;
    const attempt = await answeredBetween({
      start: "hold:read-hydration",
      begin: async () => {
        const marker = uuidv7();
        const exporting = exportLines();
        return {
          short: async () => {
            const changed = await working().updateItem(last.id, {
              properties: { ...last.properties, marker },
              version: last.version,
            });
            expect(changed.status, JSON.stringify(changed.error)).toBe(200);
            last.version = changed.data.item.version;
            last.properties = changed.data.item.properties;
            return true;
          },
          finish: async () => {
            const read = (await exporting).find(
              (line) => line.item?.id === last.id,
            );
            expect(read, "the export carries the item").toBeDefined();
            return read?.item?.properties.marker === marker;
          },
        };
      },
    });
    expect(attempt, NOT_SEEN).toBeGreaterThan(0);
  }, 600_000);

  it("is answered between two pages of an archive export", async () => {
    // Twenty-five items a page.
    const later = "hold:export-page";
    const attempt = await answeredBetween({
      start: "hold:read-hydration",
      begin: async () => {
        await server.setFault(`${later}=100`);
        const exporting = working().exportArchive();
        return {
          short: async () => (await fault(later)).waiting === 0,
          finish: async () => {
            await server.waitForHold(later);
            await server.clearFault(later);
            expect((await exporting).status).toBe(200);
          },
        };
      },
    });
    expect(attempt, NOT_SEEN).toBeGreaterThan(0);
  }, 600_000);

  it("is answered between placing an archive restore's blobs and committing its rows", async () => {
    // The restore places the archive's blob before it writes a row, and
    // waits with every row written before it commits.
    const later = "hold:restore:before-commit";
    const attempt = await answeredBetween({
      start: "hold:blob-write",
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
        await server.setFault(later);
        const restoring = owner().restoreArchive(archive);
        return {
          short: async () => (await fault(later)).waiting === 0,
          finish: async () => {
            await server.waitForHold(later);
            await server.clearFault(later);
            const restored = await restoring;
            expect(restored.status, JSON.stringify(restored.error)).toBe(200);
            expect(restored.data.imported).toBe(ROWS);
          },
        };
      },
    });
    expect(attempt, NOT_SEEN).toBeGreaterThan(0);
  }, 600_000);

  it("is answered between two chunks of a bulk action", async () => {
    let pass = 3;
    const attempt = await answeredBetween({
      start: HOLD.claimed,
      begin: async () => {
        pass += 1;
        const id = await queue(working(), {
          action: "update_properties",
          patch: { pass },
          filter: { tags: [TAG] },
          max_items: ROWS,
        });
        return {
          short: async () => {
            const job = await jobOf(working(), id);
            return job.status === "in_progress" && job.processed < job.matched;
          },
          finish: async () => {
            const done = await working().pollBulkActionToTerminal(id, {
              timeoutMs: 600_000,
            });
            expect(done).toMatchObject({
              status: "completed",
              processed: ROWS,
            });
          },
        };
      },
    });
    expect(attempt, NOT_SEEN).toBeGreaterThan(0);
  }, 900_000);

  it("is answered between two pages of the blob orphan sweep", async () => {
    // The sweep reads every item, edge, version and pending patch for the
    // blobs they name, and only then reports the blobs nothing names.
    let orphan = "";
    const reported = async (): Promise<boolean> => {
      const report = await operatorOf(server).listBlobOrphans();
      expect(report.status, JSON.stringify(report.error)).toBe(200);
      return report.data.data.some((row) => row.hash === orphan);
    };
    const attempt = await answeredBetween({
      prepare: async () => {
        const uploaded = await working().uploadBlob(
          randomBytes(64),
          "application/octet-stream",
        );
        expect(uploaded.status, JSON.stringify(uploaded.error)).toBe(201);
        orphan = uploaded.data.hash;
      },
      start: "hold:housekeeping:blob-orphans",
      begin: async () => {
        const sweeping = operatorOf(server).runHousekeeping("blob-orphans");
        return {
          short: async () => !(await reported()),
          finish: async () => {
            const run = await sweeping;
            expect(run.status, JSON.stringify(run.error)).toBe(200);
            expect(await reported(), "the sweep reports the orphan").toBe(true);
          },
        };
      },
    });
    expect(attempt, NOT_SEEN).toBeGreaterThan(0);
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

    // Each run leaves the item one earlier version, so each attempt brings
    // it to three, of which the run prunes two.
    let earlier = 0;
    const later = "hold:version-thinning:item";
    const attempt = await answeredBetween({
      prepare: async () => {
        for (; earlier < 3; earlier++) {
          const updated = await working().updateItem(last.id, {
            properties: { title: `v${String(last.version + 1)}` },
            version: last.version,
          });
          expect(updated.status, JSON.stringify(updated.error)).toBe(200);
          last.version = updated.data.item.version;
        }
      },
      start: "hold:housekeeping:version-thinning",
      begin: async () => {
        await server.setFault(later);
        const thinning = operatorOf(server).runHousekeeping("version-thinning");
        return {
          short: async () => (await fault(later)).waiting === 0,
          finish: async () => {
            await server.waitForHold(later);
            await server.clearFault(later);
            const run = await thinning;
            expect(run.status, JSON.stringify(run.error)).toBe(200);
            expect(run.data.result).toMatchObject({ pruned: 2 });
            earlier = 1;
          },
        };
      },
    });
    expect(attempt, NOT_SEEN).toBeGreaterThan(0);
  }, 600_000);

  /**
   * Last in the file, because each attempt moves the server's clock a year,
   * which ends every session and sign-in made before it.
   */
  it("is answered between two grants of the retirement of inactive grants", async () => {
    const job = "grant-inactivity-retirement";
    const action = "auth.grant.retired";
    let before = 0;
    const attempt = await answeredBetween({
      prepare: async () => {
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
        before = await audited(action);
      },
      start: `hold:housekeeping:${job}`,
      begin: async () => {
        // The move makes the job due, and the scheduler may start it before
        // this request does: either run waits at the hold.
        await server.advanceClock(366 * DAY_MS);
        const retiring = operatorOf(server).runHousekeeping(job);
        return {
          short: async () => (await audited(action)) - before < GRANTS,
          finish: async () => {
            const asked = await retiring;
            if (asked.status !== 200) {
              expect(asked.error?.error.code).toBe("housekeeping_job_running");
              await runJob(server, job);
            }
            expect((await audited(action)) - before).toBe(GRANTS);
          },
        };
      },
    });
    expect(attempt, NOT_SEEN).toBeGreaterThan(0);
  }, 900_000);
});
