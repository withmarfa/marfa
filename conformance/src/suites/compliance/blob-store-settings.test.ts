import { afterAll, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { MarfaClient } from "../../client/api.js";
import {
  approvedAppToken,
  bootFreshServer,
  FRESH_SERVER_TIMEOUT_MS,
  type FreshServer,
} from "../../utils/fresh-server.js";
import { expectMatchesSchema } from "../../utils/openapi.js";
import {
  bytesOf,
  clientsFor,
  DISK_ONLY,
  ownObjectStore,
  pastInstant,
  runJob,
  whenCopied,
} from "../../utils/own-blob-server.js";

/**
 * The settings that change what the copy rules answer, each on a server of
 * the fixture's own, because the run's server has the defaults: the minimum
 * of live copies, the grace an orphan report waits, and the credentials that
 * may reach the operator's operations.
 */
const servers: FreshServer[] = [];

async function boot(label: string, settings: Record<string, string>) {
  const server = await bootFreshServer(label, settings);
  servers.push(server);
  return { server, ...clientsFor(server) };
}

function hashOf(bytes: Uint8Array): string {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

afterAll(async () => {
  await Promise.all(servers.map((server) => server.stop()));
}, FRESH_SERVER_TIMEOUT_MS);

describe("a minimum of copies above the default", () => {
  it(
    "reports the minimum beside the stores and refuses a drop that would leave fewer copies",
    async () => {
      const { operator, working } = await boot("blob-store-min-copies", {
        ...ownObjectStore(),
        MARFA_BLOB_MIN_COPIES: "2",
      });
      const stores = await operator.listBlobStores();
      expect(stores.status).toBe(200);
      await expectMatchesSchema("GET", "/blobs/stores", 200, stores.data);
      expect(stores.data.min_copies).toBe(2);

      const upload = await working.uploadBlob(
        bytesOf("held by two stores at a minimum of two", 100),
        "text/plain",
      );
      expect(upload.status).toBe(201);
      await whenCopied(operator, [upload.data.hash]);

      // Two live copies: dropping either would leave one, below two. At the
      // default minimum of one, the same drop answers 200
      // (`blob-rules.test.ts`).
      for (const store of stores.data.data) {
        const refused = await operator.deleteBlobLocation(
          upload.data.hash,
          store.id,
        );
        expect(refused.status, store.kind).toBe(409);
        expect(refused.error?.error.code).toBe("copies_below_minimum");
        expect(refused.error?.error.details).toMatchObject({
          live: 2,
          min_copies: 2,
        });
      }
      const kept = await operator.listBlobLocations(upload.data.hash);
      expect(kept.data.data.map((row) => row.kind).sort()).toEqual([
        "disk",
        "s3",
      ]);
      expect((await operator.downloadBlob(upload.data.hash)).status).toBe(200);
    },
    FRESH_SERVER_TIMEOUT_MS,
  );
});

describe("a positive grace on the orphan sweep", () => {
  const graceMs = 3000;

  it(
    "leaves a report's first time alone and purges only once the report is older than the grace",
    async () => {
      const { operator, working } = await boot("blob-store-grace", {
        ...DISK_ONLY,
        MARFA_BLOB_CLEANUP_GRACE_MS: String(graceMs),
      });
      const upload = await working.uploadBlob(
        bytesOf("nothing names these bytes", 100),
        "text/plain",
      );
      expect(upload.status).toBe(201);
      const hash = upload.data.hash;

      const first = await runJob<{ reported: number; purged: number }>(
        operator,
        "blob-orphans",
      );
      expect(first.result).toEqual({ reported: 1, purged: 0 });
      const reportedAt = (await operator.listBlobOrphans()).data.data[0]!
        .reported_at;

      // A second run inside the grace: the report is neither purged nor
      // renewed.
      const second = await runJob<{ reported: number; purged: number }>(
        operator,
        "blob-orphans",
      );
      expect(
        Date.parse(second.started_at) - Date.parse(reportedAt),
        "the second run must start inside the grace",
      ).toBeLessThan(graceMs);
      expect(second.result).toEqual({ reported: 1, purged: 0 });
      expect((await operator.listBlobOrphans()).data.data).toEqual([
        expect.objectContaining({ hash, reported_at: reportedAt }),
      ]);
      expect((await operator.downloadBlob(hash)).status).toBe(200);

      // Past the grace, the next run purges it.
      const due = Date.parse(reportedAt) + graceMs + 250;
      while (Date.now() < due) {
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      const third = await runJob<{ reported: number; purged: number }>(
        operator,
        "blob-orphans",
      );
      expect(third.result).toEqual({ reported: 0, purged: 1 });
      expect((await operator.listBlobOrphans()).data.data).toEqual([]);
      expect((await operator.downloadBlob(hash)).status).toBe(404);
    },
    FRESH_SERVER_TIMEOUT_MS,
  );
});

describe("an orphan report that holds blobs from more than one run", () => {
  it(
    "lists the orphan report oldest first",
    async () => {
      // A grace no run in this test comes near, so every run reports and
      // none purges.
      const { operator, working } = await boot("blob-store-orphan-order", {
        ...DISK_ONLY,
        MARFA_BLOB_CLEANUP_GRACE_MS: "600000",
      });
      // The three blobs with the highest hashes are reported first, so an
      // order by hash alone would list the later ones ahead of them.
      const contents = Array.from({ length: 6 }, (_, i) =>
        bytesOf(`unreferenced blob ${String(i)}`, 100),
      ).sort((a, b) => hashOf(a).localeCompare(hashOf(b)));
      const later = contents.slice(0, 3);
      const earlier = contents.slice(3);

      const reportBatch = async (batch: readonly Uint8Array[]) => {
        for (const content of batch) {
          const upload = await working.uploadBlob(content, "text/plain");
          expect(upload.status, JSON.stringify(upload.error)).toBe(201);
        }
        return runJob(operator, "blob-orphans");
      };
      const first = await reportBatch(earlier);
      await pastInstant(first.finished_at);
      await reportBatch(later);

      const report = (await operator.listBlobOrphans()).data.data;
      expect(report.map((row) => row.hash).sort()).toEqual(
        contents.map(hashOf).sort(),
      );
      // The earlier run's reports come first and keep their first time, and
      // the times never go back.
      expect(
        report
          .slice(0, 3)
          .map((row) => row.hash)
          .sort(),
      ).toEqual(earlier.map(hashOf).sort());
      expect(
        report
          .slice(3)
          .map((row) => row.hash)
          .sort(),
      ).toEqual(later.map(hashOf).sort());
      expect(report[2]!.reported_at < report[3]!.reported_at).toBe(true);
      const times = report.map((row) => row.reported_at);
      expect(times).toEqual([...times].sort());
    },
    FRESH_SERVER_TIMEOUT_MS,
  );
});

describe("an app's access token", () => {
  it(
    "is refused the management operations on the stores, the report and the jobs, and the copy stays",
    async () => {
      const { server, operator, working } = await boot("blob-store-app-token", {
        ...ownObjectStore(),
      });
      const app = new MarfaClient({
        baseUrl: server.apiUrl,
        apiKey: await approvedAppToken(server),
      });
      const upload = await working.uploadBlob(
        bytesOf("copies an app may not drop", 100),
        "text/plain",
      );
      expect(upload.status).toBe(201);
      const hash = upload.data.hash;
      await whenCopied(operator, [hash]);
      const stores = (await operator.listBlobStores()).data.data;
      const s3 = stores.find((store) => store.kind === "s3")!;

      // The witness: the management key reaches each operation the app is
      // refused.
      expect((await operator.listBlobStores()).status).toBe(200);
      expect((await operator.listBlobOrphans()).status).toBe(200);
      expect((await operator.listHousekeeping()).status).toBe(200);

      const refusals = {
        stores: await app.listBlobStores(),
        orphans: await app.listBlobOrphans(),
        drop: await app.deleteBlobLocation(hash, s3.id),
        run: await app.runHousekeeping("blob-replicate"),
      };
      for (const [name, refusal] of Object.entries(refusals)) {
        expect(refusal.status, name).toBe(403);
        expect(refusal.error?.error.code, name).toBe("forbidden");
      }
      expect(
        (await operator.listBlobLocations(hash)).data.data.map(
          (row) => row.kind,
        ),
      ).toHaveLength(2);

      // The same drop, from the management key, is the one the minimum allows.
      const dropped = await operator.deleteBlobLocation(hash, s3.id);
      expect(dropped.status).toBe(200);
    },
    FRESH_SERVER_TIMEOUT_MS,
  );
});
