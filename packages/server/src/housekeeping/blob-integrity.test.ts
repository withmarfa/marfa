/**
 * The integrity check stamps a copy found present and intact and strikes
 * one found missing or altered, so replication can put it back. A second
 * disk store stands in for the bucket in most of these, checked the way a
 * disk is, by re-hashing; the object store's own check, by name and size,
 * is driven through a stub of that kind.
 */
import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Readable } from "node:stream";
import { describe, it, expect, afterEach, vi } from "vitest";
import { createTestContext, withSecondStore } from "../test-utils.js";
import type { TestContext } from "../test-utils.js";
import type { BlobStore } from "../storage/blob-store.js";
import { storeChecks } from "../storage/blob-layer.js";
import { withBlobUploadLock } from "../storage/blob-upload-lock.js";
import { BlobIntegrityChecker } from "./blob-integrity.js";
import { BlobReplicator } from "./blob-replicate.js";

let ctx: TestContext | undefined;

afterEach(async () => {
  await ctx?.cleanup();
  ctx = undefined;
});

async function upload(c: TestContext, content: string): Promise<string> {
  const res = await c.app.request("/blobs", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${c.workingKey}`,
      "Content-Type": "application/octet-stream",
    },
    body: new TextEncoder().encode(content),
  });
  expect(res.status).toBe(201);
  return ((await res.json()) as { hash: string }).hash;
}

/** `work`'s value, or a rejection once `ms` pass without it settling. */
async function settlesWithin<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          reject(new Error(`still running after ${String(ms)} ms`));
        }, ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/** Where a disk store keeps one hash: four hex characters of directory,
 *  then the hex. */
function diskPath(locator: string, hash: string): string {
  const hex = hash.slice("sha256:".length);
  return join(locator, hex.slice(0, 4), hex);
}

/** Silences the process's stdout for a check that strikes, and hands back
 *  the JSON lines it wrote. */
function quiet(): {
  restore: () => void;
  lines: () => Record<string, unknown>[];
} {
  const write = process.stdout.write.bind(process.stdout);
  const lines: Record<string, unknown>[] = [];
  process.stdout.write = (chunk: unknown) => {
    try {
      lines.push(JSON.parse(String(chunk)) as Record<string, unknown>);
    } catch {
      /* not a log line */
    }
    return true;
  };
  return {
    restore: () => {
      process.stdout.write = write;
    },
    lines: () => lines,
  };
}

describe("BlobIntegrityChecker.runOnce", () => {
  it("stamps every intact copy, strikes an altered one and a missing one, and audits each strike", async () => {
    ctx = await createTestContext();
    const { stores, second } = await withSecondStore(ctx);
    const altered = await upload(ctx, "will be overwritten on disk");
    const missing = await upload(ctx, "will be removed from the second store");
    const sound = await upload(ctx, "left alone");
    await new BlobReplicator(ctx.storage, stores, {
      maxBlobs: 100,
      maxBytes: 1024 * 1024,
    }).runOnce();

    const now = new Date();
    const checker = new BlobIntegrityChecker(
      ctx.storage,
      stores,
      { maxRows: 100, maxBytes: 1024 * 1024 },
      () => now,
    );
    // Before anything is wrong: every copy stamped, nothing struck.
    expect(await checker.runOnce()).toMatchObject({ verified: 6, struck: 0 });
    for (const hash of [altered, missing, sound]) {
      const copies = await ctx.storage.blobs.listCopies(hash);
      expect(copies).toHaveLength(2);
      for (const copy of copies) {
        expect(copy.verified_at).toBe(now.toISOString());
      }
    }

    // A corrupt copy on the disk, the same length as the bytes it replaces
    // so only the digest can tell, and a copy gone from the second store.
    await writeFile(
      diskPath(ctx.blobs.disk.locator, altered),
      "will be overwritten on DISK",
    );
    await rm(diskPath(second.locator, missing));
    const silenced = quiet();
    let result;
    try {
      result = await checker.runOnce();
    } finally {
      silenced.restore();
    }
    expect(result).toMatchObject({ verified: 4, struck: 2 });
    // The error line, one per strike, naming the copy.
    const struckLines = silenced
      .lines()
      .filter((line) => line.message === "blob.copy_struck");
    expect(struckLines.map((line) => line.level)).toEqual(["error", "error"]);
    expect(struckLines.map((line) => line.hash).sort()).toEqual(
      [altered, missing].sort(),
    );
    expect(
      (await ctx.storage.blobs.listCopies(altered)).map((l) => l.store_id),
    ).toEqual([second.id]);
    expect(
      (await ctx.storage.blobs.listCopies(missing)).map((l) => l.store_id),
    ).toEqual([ctx.blobs.disk.id]);
    expect(await ctx.storage.blobs.listCopies(sound)).toHaveLength(2);
    const audits = await ctx.storage.audit.list({
      action: "blob.copy_struck",
      limit: 10,
    });
    expect(audits.data.map((row) => row.resource_id).sort()).toEqual(
      [altered, missing].sort(),
    );

    // Replication puts both back from the copy that survived, and the next
    // check finds the whole set intact again.
    await new BlobReplicator(ctx.storage, stores, {
      maxBlobs: 100,
      maxBytes: 1024 * 1024,
    }).runOnce();
    expect(await checker.runOnce()).toMatchObject({ verified: 6, struck: 0 });
    const read = await ctx.blobs.disk.get(altered);
    const chunks: Buffer[] = [];
    for await (const chunk of read!.stream) chunks.push(chunk as Buffer);
    expect(Buffer.concat(chunks).toString("utf8")).toBe(
      "will be overwritten on disk",
    );
  });

  it("checks the least recently checked first, within its bounds", async () => {
    ctx = await createTestContext();
    const { stores } = await withSecondStore(ctx);
    const first = await upload(ctx, "checked first");
    const second = await upload(ctx, "checked second");
    let now = new Date();
    const checker = new BlobIntegrityChecker(
      ctx.storage,
      stores,
      { maxRows: 1, maxBytes: 1024 * 1024 },
      () => now,
    );
    // One row per store per run: the disk holds both, the second store
    // holds neither yet, so the first run stamps one disk copy.
    expect(await checker.runOnce()).toMatchObject({ verified: 1, struck: 0 });
    const stampedFirst = (await ctx.storage.blobs.listCopies(first))[0];
    const stampedSecond = (await ctx.storage.blobs.listCopies(second))[0];
    const stamped = [stampedFirst, stampedSecond].filter(
      (l) => l?.verified_at !== null,
    );
    expect(stamped).toHaveLength(1);
    // The next run takes the one never checked, not the one just stamped.
    const t0 = now.toISOString();
    now = new Date(now.getTime() + 1_000);
    expect(await checker.runOnce()).toMatchObject({ verified: 1, struck: 0 });
    const stampOf = async (hash: string) =>
      (await ctx!.storage.blobs.listCopies(hash))[0]?.verified_at;
    const t1 = now.toISOString();
    expect([await stampOf(first), await stampOf(second)].sort()).toEqual([
      t0,
      t1,
    ]);
    // Then the older stamp moves and the newer stays: least recently
    // checked, not first registered.
    const oldest = (await stampOf(first)) === t0 ? first : second;
    const newest = oldest === first ? second : first;
    now = new Date(now.getTime() + 1_000);
    expect(await checker.runOnce()).toMatchObject({ verified: 1, struck: 0 });
    expect(await stampOf(oldest)).toBe(now.toISOString());
    expect(await stampOf(newest)).toBe(t1);

    // By bytes: a copy that would cross the bound waits for the next run,
    // unless it is the run's first.
    const large = await upload(ctx, "z".repeat(5_000));
    const byBytes = new BlobIntegrityChecker(
      ctx.storage,
      stores,
      { maxRows: 100, maxBytes: 100 },
      () => now,
    );
    // The large copy is never checked, so it is first, and goes alone.
    expect(await byBytes.runOnce()).toMatchObject({
      verified: 1,
      bytes: 5_000,
    });
    expect((await ctx.storage.blobs.listCopies(large))[0]?.verified_at).toBe(
      now.toISOString(),
    );
  });

  it("reaches every store in turn when one store's copies fill the byte bound", async () => {
    // Two copies of each of two blobs, in two stores, and a bound that
    // admits one copy per run: four runs stamp all four, in order of
    // staleness across the stores rather than store by store.
    ctx = await createTestContext();
    const { stores, second } = await withSecondStore(ctx);
    const one = await upload(ctx, "shared by both stores, one");
    const two = await upload(ctx, "shared by both stores, two");
    await new BlobReplicator(ctx.storage, stores, {
      maxBlobs: 100,
      maxBytes: 1024 * 1024,
    }).runOnce();
    let now = new Date();
    const checker = new BlobIntegrityChecker(
      ctx.storage,
      stores,
      { maxRows: 100, maxBytes: 1 },
      () => now,
    );
    const stampOf = async (hash: string, storeId: string) =>
      (await ctx!.storage.blobs.listCopies(hash)).find(
        (l) => l.store_id === storeId,
      )?.verified_at ?? null;
    const copies = [
      [one, ctx.blobs.disk.id],
      [two, ctx.blobs.disk.id],
      [one, second.id],
      [two, second.id],
    ] as const;
    for (const [hash, storeId] of copies) {
      expect(await stampOf(hash, storeId)).toBeNull();
    }
    const stamps: string[] = [];
    for (let i = 0; i < 4; i++) {
      now = new Date(now.getTime() + 1_000);
      expect(await checker.runOnce()).toMatchObject({ verified: 1 });
      stamps.push(now.toISOString());
    }
    // Every copy in both stores carries one of the four stamps, each once.
    const carried = [];
    for (const [hash, storeId] of copies) {
      carried.push(await stampOf(hash, storeId));
    }
    expect(carried.sort()).toEqual([...stamps].sort());
    // And the second store was reached within the first two runs: the
    // never-checked copies went in one order across both stores, so a
    // store's backlog cannot hold the other back.
    const secondStoreFirst = [
      await stampOf(one, second.id),
      await stampOf(two, second.id),
    ].some((at) => at === stamps[0] || at === stamps[1]);
    expect(secondStoreFirst).toBe(true);
  });

  it("asks an object store for a copy by name and size, and strikes one it cannot answer for", async () => {
    ctx = await createTestContext();
    const good = await upload(ctx, "present in the object store");
    const gone = await upload(ctx, "missing from the object store");
    const wrong = await upload(ctx, "a different size in the object store");
    // A stub of the object store's kind: `has` is what the check asks it,
    // and `get` is never called on it.
    const answers = new Map<string, { size_bytes: number } | null>([
      [good, { size_bytes: "present in the object store".length }],
      [gone, null],
      [wrong, { size_bytes: 1 }],
    ]);
    let fetched = 0;
    let asked = 0;
    const deleted: string[] = [];
    const stub: BlobStore = {
      id: "stub-object-store",
      kind: "s3",
      locator: "s3://stub/blobs",
      attach: () => Promise.resolve(),
      put: () => Promise.resolve(),
      get: () => {
        fetched += 1;
        return Promise.resolve({
          stream: Readable.from([]),
          size_bytes: 0,
          offset: 0,
          length: 0,
        });
      },
      has: (hash) => {
        asked += 1;
        return Promise.resolve(answers.get(hash) ?? null);
      },
      delete: (hash) => {
        deleted.push(hash);
        return Promise.resolve();
      },
    };
    await ctx.storage.blobs.attachStore({
      id: stub.id,
      kind: stub.kind,
      locator: stub.locator,
    });
    for (const hash of [good, gone, wrong]) {
      await ctx.storage.blobs.recordCopy(hash, stub.id);
    }
    const all = [ctx.blobs.disk, stub];
    const checker = new BlobIntegrityChecker(
      ctx.storage,
      { stores: all, byId: (id) => all.find((s) => s.id === id) },
      { maxRows: 100, maxBytes: 1024 * 1024 },
    );
    const silenced = quiet();
    let result;
    try {
      result = await checker.runOnce();
    } finally {
      silenced.restore();
    }
    // Three disk copies and the good stub copy stamped; the missing and
    // the wrong-sized stub copies struck, and their names discarded. Asked
    // by name three times, never read: the counters are the witness for
    // each other.
    expect(result).toMatchObject({ verified: 4, struck: 2 });
    expect(asked).toBe(3);
    expect(fetched).toBe(0);
    expect(deleted.sort()).toEqual([gone, wrong].sort());
    const stubHolds = async (hash: string) =>
      (await ctx!.storage.blobs.listCopies(hash)).some(
        (l) => l.store_id === stub.id,
      );
    expect(await stubHolds(good)).toBe(true);
    expect(await stubHolds(gone)).toBe(false);
    expect(await stubHolds(wrong)).toBe(false);
  });

  it("neither stamps nor strikes a copy in a store that cannot answer, and checks the rest", async () => {
    ctx = await createTestContext();
    const held = await upload(ctx, "held on disk and in an unreachable store");
    const stub: BlobStore = {
      id: "unreachable-object-store",
      kind: "s3",
      locator: "s3://unreachable/blobs",
      attach: () => Promise.resolve(),
      put: () => Promise.resolve(),
      get: () => Promise.reject(new Error("store unreachable")),
      has: () => Promise.reject(new Error("store unreachable")),
      delete: () => Promise.reject(new Error("store unreachable")),
    };
    await ctx.storage.blobs.attachStore({
      id: stub.id,
      kind: stub.kind,
      locator: stub.locator,
    });
    await ctx.storage.blobs.recordCopy(held, stub.id);
    const all = [ctx.blobs.disk, stub];
    const checker = new BlobIntegrityChecker(
      ctx.storage,
      { stores: all, byId: (id) => all.find((s) => s.id === id) },
      { maxRows: 100, maxBytes: 1024 * 1024 },
    );
    const silenced = quiet();
    let result;
    try {
      result = await checker.runOnce();
    } finally {
      silenced.restore();
    }
    expect(result).toMatchObject({ verified: 1, struck: 0 });
    const copies = await ctx.storage.blobs.listCopies(held);
    expect(copies.find((l) => l.store_id === stub.id)?.verified_at).toBeNull();
    expect(
      copies.find((l) => l.store_id === ctx!.blobs.disk.id)?.verified_at,
    ).not.toBeNull();
  });

  it("neither stamps nor strikes a disk copy whose read ends short", async () => {
    ctx = await createTestContext();
    const content = "bytes whose read ends early";
    const hash = await upload(ctx, content);
    const get = ctx.blobs.disk.get.bind(ctx.blobs.disk);
    vi.spyOn(ctx.blobs.disk, "get").mockImplementation(
      async (wanted, ...rest) =>
        wanted === hash
          ? {
              stream: Readable.from([Buffer.from(content.slice(0, 5))]),
              size_bytes: content.length,
              offset: 0,
              length: content.length,
            }
          : get(wanted, ...rest),
    );
    const checker = new BlobIntegrityChecker(ctx.storage, ctx.blobs, {
      maxRows: 100,
      maxBytes: 1024 * 1024,
    });
    const silenced = quiet();
    let result;
    try {
      result = await checker.runOnce();
    } finally {
      silenced.restore();
    }
    expect(result).toMatchObject({ struck: 0 });
    const [copy] = await ctx.storage.blobs.listCopies(hash);
    expect(copy?.verified_at).toBeNull();
  });

  it("calls off a disk read that does not open in time, and neither stamps nor strikes the copy", async () => {
    ctx = await createTestContext();
    const hash = await upload(ctx, "bytes a hanging disk holds");
    let open = 0;
    vi.spyOn(ctx.blobs.disk, "get").mockImplementation(
      (_hash, _range, signal) => {
        open++;
        return new Promise<never>((_, reject) => {
          signal?.addEventListener("abort", () => {
            open--;
            reject(signal.reason as Error);
          });
        });
      },
    );
    const timeout = storeChecks.timeoutMs;
    storeChecks.timeoutMs = 50;
    const silenced = quiet();
    let result;
    try {
      result = await new BlobIntegrityChecker(ctx.storage, ctx.blobs, {
        maxRows: 100,
        maxBytes: 1024 * 1024,
      }).runOnce();
    } finally {
      silenced.restore();
      storeChecks.timeoutMs = timeout;
    }
    expect(result).toMatchObject({ verified: 0, struck: 0, unreachable: 1 });
    expect(open).toBe(0);
    const [copy] = await ctx.storage.blobs.listCopies(hash);
    expect(copy?.verified_at).toBeNull();
  });

  it("counts an object store that does not answer in time as unreachable, strikes nothing, and lets every lock go", async () => {
    ctx = await createTestContext();
    const held = [
      await upload(ctx, "first copy a hanging object store holds"),
      await upload(ctx, "second copy a hanging object store holds"),
    ];
    let asked = 0;
    let open = 0;
    const deleted: string[] = [];
    const stub: BlobStore = {
      id: "hanging-object-store",
      kind: "s3",
      locator: "s3://hanging/blobs",
      attach: () => Promise.resolve(),
      put: () => Promise.resolve(),
      get: () => Promise.reject(new Error("the check never reads")),
      has: (_hash, signal) => {
        asked++;
        open++;
        return new Promise<never>((_, reject) => {
          signal?.addEventListener("abort", () => {
            open--;
            reject(new Error("request aborted"));
          });
        });
      },
      delete: (hash) => {
        deleted.push(hash);
        return Promise.resolve();
      },
    };
    await ctx.storage.blobs.attachStore({
      id: stub.id,
      kind: stub.kind,
      locator: stub.locator,
    });
    for (const hash of held) {
      await ctx.storage.blobs.recordCopy(hash, stub.id);
    }
    const all = [ctx.blobs.disk, stub];
    const timeout = storeChecks.timeoutMs;
    storeChecks.timeoutMs = 50;
    const silenced = quiet();
    let result;
    try {
      result = await settlesWithin(
        new BlobIntegrityChecker(
          ctx.storage,
          { stores: all, byId: (id) => all.find((s) => s.id === id) },
          { maxRows: 100, maxBytes: 1024 * 1024 },
        ).runOnce(),
        5_000,
      );
    } finally {
      silenced.restore();
      storeChecks.timeoutMs = timeout;
    }
    // The disk's two copies stamped; the hanging store asked once, its
    // request called off, and named unreachable rather than missing.
    expect(result).toMatchObject({ verified: 2, struck: 0, unreachable: 1 });
    expect(asked).toBe(1);
    expect(open).toBe(0);
    expect(deleted).toEqual([]);
    expect(
      silenced
        .lines()
        .filter((line) => line.message === "blob.store_unreachable")
        .map((line) => line.store_id),
    ).toEqual([stub.id]);
    expect(
      silenced.lines().filter((line) => line.message === "blob.copy_struck"),
    ).toEqual([]);
    for (const hash of held) {
      const copies = await ctx.storage.blobs.listCopies(hash);
      expect(copies.find((l) => l.store_id === stub.id)?.verified_at).toBe(
        null,
      );
      // The lock the check took for the copy is free again.
      expect(
        await settlesWithin(
          withBlobUploadLock(hash, () => Promise.resolve("free")),
          1_000,
        ),
      ).toBe("free");
    }
  });

  it("counts a store whose delete of a struck copy does not answer as unreachable, and asks it nothing more in the run", async () => {
    ctx = await createTestContext();
    const held = [
      await upload(ctx, "first copy a store has lost"),
      await upload(ctx, "second copy a store has lost"),
    ];
    let asked = 0;
    const deletes: string[] = [];
    let release: () => void = () => undefined;
    const late = new Promise<void>((resolve) => {
      release = resolve;
    });
    // Holds no copy, so each check strikes one, and its delete hangs.
    const stub: BlobStore = {
      id: "store-whose-delete-hangs",
      kind: "s3",
      locator: "s3://hanging-delete/blobs",
      attach: () => Promise.resolve(),
      put: () => Promise.resolve(),
      get: () => Promise.reject(new Error("the check never reads")),
      has: () => {
        asked++;
        return Promise.resolve(null);
      },
      delete: (hash) => {
        deletes.push(hash);
        return late;
      },
    };
    await ctx.storage.blobs.attachStore({
      id: stub.id,
      kind: stub.kind,
      locator: stub.locator,
    });
    for (const hash of held) {
      await ctx.storage.blobs.recordCopy(hash, stub.id);
    }
    const all = [ctx.blobs.disk, stub];
    const timeout = storeChecks.timeoutMs;
    storeChecks.timeoutMs = 50;
    const silenced = quiet();
    let result;
    try {
      result = await settlesWithin(
        new BlobIntegrityChecker(
          ctx.storage,
          { stores: all, byId: (id) => all.find((s) => s.id === id) },
          { maxRows: 100, maxBytes: 1024 * 1024 },
        ).runOnce(),
        5_000,
      );
    } finally {
      silenced.restore();
      storeChecks.timeoutMs = timeout;
    }
    // One copy struck, its delete given up on, and the store asked about
    // nothing else; the disk's two copies stamped.
    expect(result).toMatchObject({ verified: 2, struck: 1, unreachable: 1 });
    expect(asked).toBe(1);
    expect(deletes).toHaveLength(1);
    const struck = deletes[0]!;
    expect(
      (await ctx.storage.blobs.listCopies(struck)).map((l) => l.store_id),
    ).toEqual([ctx.blobs.disk.id]);
    // The copy stays struck, with its deletion queued for a later run.
    expect(await ctx.storage.blobs.listPendingCopyDeletions(10)).toEqual([
      { hash: struck, store_id: stub.id },
    ]);
    expect(
      silenced
        .lines()
        .filter((line) => line.message === "blob.store_unreachable")
        .map((line) => line.store_id),
    ).toEqual([stub.id]);
    release();
  });

  it("counts no strike for a row dropped between the listing and the check", async () => {
    // The listing named a copy; by the time the check reaches it an
    // operator has dropped the row. Nothing was found wrong with a copy
    // the log claims, so nothing is logged, audited or discarded.
    ctx = await createTestContext();
    const { stores, second } = await withSecondStore(ctx);
    const hash = await upload(ctx, "dropped under the check");
    await new BlobReplicator(ctx.storage, stores, {
      maxBlobs: 100,
      maxBytes: 1024 * 1024,
    }).runOnce();
    await rm(diskPath(second.locator, hash));
    const registry = ctx.storage.blobs;
    const listToVerify = registry.listToVerify.bind(registry);
    registry.listToVerify = async (storeIds, limit) => {
      const rows = await listToVerify(storeIds, limit);
      // The drop lands after the listing was taken.
      await registry.removeCopy(hash, second.id);
      return rows;
    };
    const deletes: string[] = [];
    const del = second.delete.bind(second);
    second.delete = (h) => {
      deletes.push(h);
      return del(h);
    };
    const silenced = quiet();
    let result;
    try {
      result = await new BlobIntegrityChecker(ctx.storage, stores, {
        maxRows: 100,
        maxBytes: 1024 * 1024,
      }).runOnce();
    } finally {
      silenced.restore();
      registry.listToVerify = listToVerify;
    }
    expect(result).toMatchObject({ verified: 1, struck: 0 });
    expect(
      silenced.lines().filter((l) => l.message === "blob.copy_struck"),
    ).toEqual([]);
    expect(
      (await ctx.storage.audit.list({ action: "blob.copy_struck", limit: 10 }))
        .data,
    ).toEqual([]);
    expect(deletes).toEqual([]);
    // The witness: the same missing copy with its row in place is struck.
    await ctx.storage.blobs.recordCopy(hash, second.id);
    const again = quiet();
    let struck;
    try {
      struck = await new BlobIntegrityChecker(ctx.storage, stores, {
        maxRows: 100,
        maxBytes: 1024 * 1024,
      }).runOnce();
    } finally {
      again.restore();
      second.delete = del;
    }
    expect(struck).toMatchObject({ struck: 1 });
    expect(deletes).toEqual([hash]);
  });
});

describe("BlobIntegrityChecker.runOnce on a store that cannot be reached", () => {
  const bounds = { maxRows: 100, maxBytes: 1024 * 1024 };

  async function download(c: TestContext, hash: string): Promise<Response> {
    return c.app.request(`/blobs/${hash}`, {
      headers: { Authorization: `Bearer ${c.managementKey}` },
    });
  }

  /** Runs the check with the process's log lines held back. */
  async function check(checker: BlobIntegrityChecker) {
    const silenced = quiet();
    try {
      return { result: await checker.runOnce(), lines: silenced.lines() };
    } finally {
      silenced.restore();
    }
  }

  it("strikes nothing while the folder is gone, and the blob reads again when it returns", async () => {
    ctx = await createTestContext();
    const hash = await upload(ctx, "on a drive that is unplugged");
    const checker = new BlobIntegrityChecker(ctx.storage, ctx.blobs, bounds);
    expect((await check(checker)).result).toMatchObject({
      verified: 1,
      struck: 0,
      unreachable: 0,
    });

    const folder = ctx.blobs.disk.locator;
    await rename(folder, `${folder}.away`);
    const during = await check(checker);
    expect(during.result).toEqual({
      verified: 0,
      struck: 0,
      bytes: 0,
      unreachable: 1,
    });
    expect(
      during.lines
        .filter((line) => line.message === "blob.store_unreachable")
        .map((line) => line.store_id),
    ).toEqual([ctx.blobs.disk.id]);
    expect(
      during.lines.filter((line) => line.message === "blob.copy_struck"),
    ).toEqual([]);
    // The record stands, and the read says the store did not answer, not
    // that the blob is gone.
    expect(await ctx.storage.blobs.listCopies(hash)).toHaveLength(1);
    expect(
      (await ctx.storage.audit.list({ action: "blob.copy_struck", limit: 10 }))
        .data,
    ).toEqual([]);
    const refused = await download(ctx, hash);
    expect(refused.status).toBe(503);
    expect(
      ((await refused.json()) as { error: { code: string } }).error.code,
    ).toBe("blob_store_unavailable");

    await rename(`${folder}.away`, folder);
    const read = await download(ctx, hash);
    expect(read.status).toBe(200);
    expect(await read.text()).toBe("on a drive that is unplugged");
    expect((await check(checker)).result).toMatchObject({
      verified: 1,
      struck: 0,
      unreachable: 0,
    });
  });

  it("strikes nothing from a mount point left empty, with no marker", async () => {
    ctx = await createTestContext();
    const hash = await upload(ctx, "on a drive that did not mount");
    const checker = new BlobIntegrityChecker(ctx.storage, ctx.blobs, bounds);

    const folder = ctx.blobs.disk.locator;
    await rename(folder, `${folder}.away`);
    await mkdir(folder);
    expect((await check(checker)).result).toMatchObject({
      struck: 0,
      unreachable: 1,
    });
    expect(await ctx.storage.blobs.listCopies(hash)).toHaveLength(1);

    await rm(folder, { recursive: true });
    await rename(`${folder}.away`, folder);
    expect((await download(ctx, hash)).status).toBe(200);
  });

  it("strikes a copy missing from a store that is present, which is what the unreachable store is spared", async () => {
    ctx = await createTestContext();
    const hash = await upload(ctx, "removed from a disk that is there");
    const checker = new BlobIntegrityChecker(ctx.storage, ctx.blobs, bounds);
    await rm(diskPath(ctx.blobs.disk.locator, hash));

    const { result } = await check(checker);
    expect(result).toMatchObject({ struck: 1, unreachable: 0 });
    expect(await ctx.storage.blobs.listCopies(hash)).toEqual([]);
  });

  it("goes on to the other stores, and does not let the unreachable one fill the run's rows", async () => {
    ctx = await createTestContext();
    const { stores, second } = await withSecondStore(ctx);
    const hashes = [
      await upload(ctx, "one of three"),
      await upload(ctx, "two of three"),
      await upload(ctx, "three of three"),
    ];
    await new BlobReplicator(ctx.storage, stores, {
      maxBlobs: 100,
      maxBytes: 1024 * 1024,
    }).runOnce();

    const folder = ctx.blobs.disk.locator;
    await rename(folder, `${folder}.away`);
    // Six copies, three rows a run: if the disk's copies took the rows, the
    // second store would be left with fewer than its three.
    const { result } = await check(
      new BlobIntegrityChecker(ctx.storage, stores, {
        maxRows: 3,
        maxBytes: 1024 * 1024,
      }),
    );
    expect(result).toMatchObject({ verified: 3, struck: 0, unreachable: 1 });
    for (const hash of hashes) {
      const copies = await ctx.storage.blobs.listCopies(hash);
      expect(copies).toHaveLength(2);
      expect(
        copies.find((copy) => copy.store_id === second.id)?.verified_at,
      ).not.toBeNull();
      expect(
        copies.find((copy) => copy.store_id === ctx!.blobs.disk.id)
          ?.verified_at,
      ).toBeNull();
    }
    // Served from the store that answers while the disk is away.
    expect((await download(ctx, hashes[0]!)).status).toBe(200);
  });
});
