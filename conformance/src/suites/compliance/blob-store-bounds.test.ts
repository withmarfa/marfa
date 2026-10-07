import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import type { MarfaClient } from "../../client/api.js";
import {
  bootFreshServer,
  FRESH_SERVER_TIMEOUT_MS,
  type FreshServer,
} from "../../utils/fresh-server.js";
import {
  bytesOf,
  clientsFor,
  leaveBacklog,
  ownObjectStore,
  pastInstant,
  runJob,
  whenCopied,
} from "../../utils/own-blob-server.js";
import { getOperatorClient } from "../../utils/setup.js";

/**
 * The bounds of one run of `blob-replicate` and of `blob-integrity`, and the
 * order the integrity check takes its copies in.
 *
 * **Servers of their own, with the run's object store under prefixes of
 * their own.** A bound is a setting, and the run's server has the defaults.
 * Each server here is booted with the bound its tests are about and holds
 * only the blobs they upload. Replication is made to have a backlog by
 * uploading blobs, waiting for the server's own scheduler to copy them, and
 * dropping the object store's copies through the operator door, which wakes
 * nothing; the next run is then the first work the job does.
 *
 * The integrity job's first run on its own clock comes a minute after boot,
 * and these tests finish well inside it.
 */
const servers: FreshServer[] = [];

async function boot(
  label: string,
  settings: Record<string, string>,
): Promise<{
  server: FreshServer;
  operator: MarfaClient;
  working: MarfaClient;
}> {
  const server = await bootFreshServer(label, {
    ...ownObjectStore(),
    ...settings,
  });
  servers.push(server);
  return { server, ...clientsFor(server) };
}

afterAll(async () => {
  await Promise.all(servers.map((server) => server.stop()));
}, FRESH_SERVER_TIMEOUT_MS);

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

describe("a replication run that is bounded by count", () => {
  let operator: MarfaClient;
  let working: MarfaClient;

  beforeAll(async () => {
    ({ operator, working } = await boot("blob-store-count-bounds", {
      MARFA_BLOB_REPLICATE_BATCH: "2",
      MARFA_BLOB_INTEGRITY_BATCH: "1",
      MARFA_BLOB_CLEANUP_INTERVAL_MS: "0",
    }));
  }, FRESH_SERVER_TIMEOUT_MS);

  const sizes = [100, 200, 400];
  let hashes: string[] = [];

  it("copies at most the batch, answers what it did, and runs again on its own for the rest", async () => {
    hashes = await leaveBacklog(
      operator,
      working,
      sizes.map((size) => bytesOf(`blob of ${String(size)}`, size)),
    );
    for (const hash of hashes) {
      expect((await operator.listBlobLocations(hash)).data.data).toHaveLength(
        1,
      );
    }

    const run = await runJob(operator, "blob-replicate");

    expect(run.result.copied).toBe(2);
    expect(run.result.remaining).toBe(1);
    // The bytes of the two blobs it copied: each pair of sizes sums to a
    // different total.
    expect([300, 500, 600]).toContain(run.result.bytes);

    // No further run is asked for: the interval is an hour, so the last
    // copy is the one the server made by waking itself.
    await whenCopied(operator, hashes);
  });

  it("checks no more copies than the batch in one run, least recently checked first and across the stores", async () => {
    const stores = (await operator.listBlobStores()).data.data;
    // The order the check takes never-checked copies in: by hash, and the
    // two copies of one blob beside each other, whichever store they are in.
    const order = [...hashes].sort().flatMap((hash) =>
      stores
        .map((store) => store.id)
        .sort()
        .map((store) => ({ hash, store })),
    );
    const sizeOf = new Map(
      hashes.map((hash, index) => [hash, sizes[index]!] as const),
    );
    const stamped = async () => {
      const found = new Map<string, string>();
      for (const hash of hashes) {
        for (const row of (await operator.listBlobLocations(hash)).data.data) {
          if (row.verified_at !== null) {
            found.set(`${hash} ${row.store_id}`, row.verified_at);
          }
        }
      }
      return found;
    };

    // Every copy is new, so none is stamped. Each run checks one, and the
    // stamped ones are always the first of the order: the second run
    // finishes the first blob's other copy, where an order that took one
    // store after the other would move to another blob.
    expect((await stamped()).size).toBe(0);
    for (const [index, copy] of order.entries()) {
      const run = await runJob(operator, "blob-integrity");
      expect(run.result).toEqual({
        verified: 1,
        struck: 0,
        bytes: sizeOf.get(copy.hash),
      });
      const now = await stamped();
      expect([...now.keys()].sort(), `after run ${String(index + 1)}`).toEqual(
        order
          .slice(0, index + 1)
          .map((each) => `${each.hash} ${each.store}`)
          .sort(),
      );
    }

    // Every copy has been checked once, so the next run goes to the one
    // checked longest ago, and the one after to the next.
    for (const copy of order.slice(0, 2)) {
      const before = await stamped();
      const key = `${copy.hash} ${copy.store}`;
      await pastInstant(before.get(key)!);
      const run = await runJob(operator, "blob-integrity");
      expect(run.result.verified).toBe(1);
      const after = await stamped();
      expect(after.get(key)! > before.get(key)!).toBe(true);
      for (const [other, stamp] of before) {
        if (other !== key) expect(after.get(other)).toBe(stamp);
      }
    }
  });

  it("leaves blob-orphans out of the listing and answers 404 for it when the sweep is switched off", async () => {
    // The witness: the run's own server, with the sweep on, lists it.
    const sharedNames = (
      await getOperatorClient().listHousekeeping()
    ).data.data.map((row) => row.name);
    expect(sharedNames).toContain("blob-orphans");

    const names = (await operator.listHousekeeping()).data.data.map(
      (row) => row.name,
    );
    expect(names).toContain("blob-replicate");
    expect(names).toContain("blob-integrity");
    expect(names).not.toContain("blob-orphans");
    const run = await operator.runHousekeeping("blob-orphans");
    expect(run.status).toBe(404);
    expect(run.error?.error.code).toBe("housekeeping_job_not_found");
    const report = await operator.listBlobOrphans();
    expect(report.status).toBe(200);
    expect(report.data).toEqual({ data: [], next_cursor: null });
  });
});

describe("a replication run that is bounded by bytes", () => {
  let operator: MarfaClient;
  let working: MarfaClient;

  beforeAll(async () => {
    ({ operator, working } = await boot("blob-store-replication-bytes", {
      MARFA_BLOB_REPLICATE_BATCH_BYTES: "200",
    }));
  }, FRESH_SERVER_TIMEOUT_MS);

  it("copies a blob larger than the bound when it is the run's first, and nothing more", async () => {
    const hashes = await leaveBacklog(operator, working, [
      bytesOf("a blob larger than the bound", 300),
    ]);
    const run = await runJob(operator, "blob-replicate");
    expect(run.result).toEqual({ copied: 1, bytes: 300, remaining: 0 });
    await whenCopied(operator, hashes);
  });

  it("stops before the blob that would push the copied bytes past the bound", async () => {
    const hashes = await leaveBacklog(operator, working, [
      bytesOf("the first of two at the bound", 100),
      bytesOf("the second of two at the bound", 100),
      new TextEncoder().encode("x"),
    ]);

    const run = await runJob(operator, "blob-replicate");

    // Two blobs of 100 bytes reach the bound of 200 exactly, and the byte
    // after them would be the 201st.
    expect(run.result).toEqual({ copied: 2, bytes: 200, remaining: 1 });
    await whenCopied(operator, hashes);
  });
});

describe("an integrity run that is bounded by bytes", () => {
  let operator: MarfaClient;
  let working: MarfaClient;

  beforeAll(async () => {
    ({ operator, working } = await boot("blob-store-integrity-bytes", {
      MARFA_BLOB_INTEGRITY_BATCH_BYTES: "200",
    }));
  }, FRESH_SERVER_TIMEOUT_MS);

  async function uploadAndCopy(bytes: Uint8Array): Promise<string> {
    const upload = await working.uploadBlob(bytes, "text/plain");
    expect(upload.status, JSON.stringify(upload.error)).toBe(201);
    await whenCopied(operator, [upload.data.hash]);
    return upload.data.hash;
  }

  async function unverified(hash: string): Promise<number> {
    const rows = (await operator.listBlobLocations(hash)).data.data;
    return rows.filter((row) => row.verified_at === null).length;
  }

  it("checks a copy larger than the bound when it is the run's first, and nothing more", async () => {
    const big = await uploadAndCopy(
      bytesOf("a copy larger than the bound", 300),
    );
    for (const left of [1, 0]) {
      const run = await runJob(operator, "blob-integrity");
      expect(run.result).toEqual({ verified: 1, struck: 0, bytes: 300 });
      expect(await unverified(big)).toBe(left);
    }
  });

  it("stops before the copy that would push the bytes read past the bound", async () => {
    // Two blobs, the larger first in the order the check takes: its two
    // copies read exactly the bound, and the smaller one's first copy would
    // read one byte more.
    const candidates = Array.from({ length: 94 }, (_, i) =>
      new TextEncoder().encode(String.fromCharCode(0x21 + i)),
    );
    let larger = bytesOf("two copies that read the bound exactly", 100);
    let smaller = candidates.find((each) => sha256(each) > sha256(larger));
    while (smaller === undefined) {
      larger = bytesOf("two copies that read the bound exactly", 100);
      smaller = candidates.find((each) => sha256(each) > sha256(larger));
    }
    const first = await uploadAndCopy(larger);
    const second = await uploadAndCopy(smaller);

    const bound = await runJob(operator, "blob-integrity");
    expect(bound.result).toEqual({ verified: 2, struck: 0, bytes: 200 });
    expect(await unverified(first)).toBe(0);
    expect(await unverified(second)).toBe(2);

    const rest = await runJob(operator, "blob-integrity");
    expect(rest.result).toEqual({ verified: 2, struck: 0, bytes: 2 });
    expect(await unverified(second)).toBe(0);
  });
});
