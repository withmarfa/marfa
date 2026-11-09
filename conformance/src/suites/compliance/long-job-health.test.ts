import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MarfaClient } from "../../client/api.js";
import { HOLD, queue, seed } from "../../utils/bulk-jobs.js";
import {
  bootFreshServer,
  FRESH_SERVER_TIMEOUT_MS,
  type FreshServer,
} from "../../utils/fresh-server.js";
import {
  operatorOf,
  QUIET_SCHEDULE,
  quiet,
  runJob,
  writerOf,
} from "../../utils/moved-clock.js";
import { DISK_ONLY } from "../../utils/own-blob-server.js";
import { heldWhenHealthAnswered } from "../../utils/held-when-answered.js";

/**
 * `GET /health` answered while each long job runs, between two of its steps
 * (`instance/long-job-health`); `heldWhenHealthAnswered` says how the order
 * is witnessed. The credential clean-up's case is in
 * `long-job-health-credentials.test.ts`, and the archive restore's, which
 * holds the writer throughout, in `long-job-health-restore.test.ts`.
 */
let server: FreshServer;

/** Notes enough that each job has dozens of steps between its two holds. */
const ROWS = 4_000;
const TAG = "long-job-health";
const NEVER_MS = "31536000000";

const working = (): MarfaClient => writerOf(server);

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
    const held = await heldWhenHealthAnswered(server, {
      start: "hold:read-hydration",
      later: "hold:export-page=240",
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
    const held = await heldWhenHealthAnswered(server, {
      start: "hold:read-hydration",
      later: "hold:export-page=150",
      begin: async () => {
        const exporting = working().exportArchive();
        return async () => {
          expect((await exporting).status).toBe(200);
        };
      },
    });
    expect(held).toEqual([]);
  }, 600_000);

  it("is answered between two chunks of a bulk action", async () => {
    // A hundred items a chunk.
    const held = await heldWhenHealthAnswered(server, {
      start: HOLD.claimed,
      later: `${HOLD.betweenChunks}=38`,
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
    const held = await heldWhenHealthAnswered(server, {
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

    const held = await heldWhenHealthAnswered(server, {
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
});
