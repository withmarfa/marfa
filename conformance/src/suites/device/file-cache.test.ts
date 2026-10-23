import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CliDevice } from "../../device/cli-adapter.js";
import type { FileCache, Status } from "../../device/protocol.js";
import {
  KEY,
  fileOf,
  hashOf,
  requireBinary,
  scriptBlob,
  startHarness,
  type Harness,
} from "./harness.js";

let harness: Harness | undefined;
const scratch: string[] = [];

afterEach(async () => {
  await harness?.stop();
  harness = undefined;
  delete process.env.MARFA_TEST_FAULT;
  for (const folder of scratch.splice(0)) {
    rmSync(folder, { recursive: true, force: true });
  }
});

const MIB = 1024 * 1024;
const GIB = 1024 * MIB;
const TB = 1_000_000_000_000;

/** A harness whose device has its working copy made, as a first fetch needs. */
async function started(label: string): Promise<Harness> {
  const made = await startHarness(label);
  const status = await made.device.status();
  expect(status.ok, JSON.stringify(status)).toBe(true);
  return made;
}

/** Ten bytes that differ from every other name's. */
function ten(name: string): Buffer {
  return Buffer.from(name.padEnd(10, "."));
}

/** Runs `call` with the debug build told `fault`, such as what its volume looks like. */
async function withFault<T>(fault: string, call: () => Promise<T>): Promise<T> {
  process.env.MARFA_TEST_FAULT = fault;
  try {
    return await call();
  } finally {
    delete process.env.MARFA_TEST_FAULT;
  }
}

/** A volume of `size` bytes with `free` of them free. */
function volume(size: number, free: number): string {
  return `volume=${String(size)}:${String(free)}`;
}

/**
 * A volume of `size` bytes with `free` of them free, where the default budget
 * may fall below its 256 MiB minimum, so a fixture can see the default trim
 * bytes it fetched without fetching 256 MiB.
 */
function unbounded(size: number, free: number): string {
  return `${volume(size, free)},budget-minimum=0`;
}

async function cacheOf(device: CliDevice): Promise<FileCache> {
  const status = await device.status();
  if (!status.ok) throw new Error(`no status: ${JSON.stringify(status)}`);
  return (status.value as Status).file_cache;
}

function heldAt(device: CliDevice, hash: string): string {
  return `${device.store}.blobs/${hash.slice("sha256:".length)}`;
}

/** Fetches `bytes` as the server serves them, and answers where they are held. */
async function fetched(
  { server, device }: Harness,
  bytes: Buffer,
): Promise<string> {
  const hash = scriptBlob(server, bytes);
  const got = await device.blob(hash);
  expect(got.ok, `the fetch was refused: ${JSON.stringify(got)}`).toBe(true);
  // Reads are ordered by when they happened, which a filesystem tells apart
  // only past its timestamp's grain.
  await new Promise((resolve) => setTimeout(resolve, 30));
  return hash;
}

describe("the file budget", () => {
  it("gives the default budget from the volume's size and free space, counting what it holds", async () => {
    harness = await started("budget-default");
    const { device } = harness;
    const budgetOn = async (size: number, free: number): Promise<number> => {
      const cache = await withFault(volume(size, free), () => cacheOf(device));
      expect(cache.setting).toBe("default");
      expect(cache.volume_unreadable).toBe(false);
      return cache.budget ?? Number.NaN;
    };

    // A tenth of a large volume with room to spare.
    expect(await budgetOn(TB, TB / 2)).toBe(TB / 10);
    // Never under 2 GiB on a small one.
    expect(await budgetOn(10 * GIB, 8 * GIB)).toBe(2 * GIB);
    // Where the volume is nearly full, what leaves a twentieth of it free.
    expect(await budgetOn(TB, TB / 20 + 300 * MIB)).toBe(300 * MIB);
    // Never below 256 MiB.
    expect(await budgetOn(TB, TB / 20 + 7)).toBe(256 * MIB);
    expect(await budgetOn(TB, 1)).toBe(256 * MIB);

    // The bytes the cache holds count towards what a trim can hand back. The
    // fetch happens on the machine's own volume, where the default is wide.
    await fetched(harness, ten("held"));
    expect(await budgetOn(TB, TB / 20 + 300 * MIB)).toBe(300 * MIB + 10);
  });

  it("gives 2 GiB and says so where the volume cannot be read", async () => {
    harness = await started("budget-unreadable");
    const { device } = harness;
    // The witness: a volume that reads says nothing of the kind.
    const read = await cacheOf(device);
    expect(read.volume_unreadable).toBe(false);

    const unread = await withFault("volume-unreadable", () => cacheOf(device));
    expect(unread.setting).toBe("default");
    expect(unread.budget).toBe(2 * GIB);
    expect(unread.volume_unreadable).toBe(true);

    // A volume that answers a size of zero says nothing about itself.
    const zero = await withFault(volume(0, 0), () => cacheOf(device));
    expect(zero.budget).toBe(2 * GIB);
    expect(zero.volume_unreadable).toBe(true);
  });

  it("gives a set budget whatever the volume, to every process that opens the store", async () => {
    harness = await started("budget-set");
    const { device } = harness;
    const set = await withFault(volume(TB, TB / 2), () =>
      device.fileBudget("100"),
    );
    expect(set.ok, JSON.stringify(set)).toBe(true);

    // Each command is a process of its own.
    for (const size of [TB, 10 * GIB]) {
      const cache = await withFault(volume(size, size / 2), () =>
        cacheOf(device),
      );
      expect(cache.setting).toEqual({ bytes: 100 });
      expect(cache.budget).toBe(100);
    }

    const shown = await device.fileBudget();
    expect(shown.ok && shown.value.file_cache.budget).toBe(100);

    for (const refused of ["lots", "1.5", ""]) {
      const outcome = await device.fileBudget(refused);
      expect(outcome.ok, `${JSON.stringify(refused)} was taken`).toBe(false);
      if (!outcome.ok) expect(outcome.refusal.code).toBe("invalid");
    }
    expect((await cacheOf(device)).setting).toEqual({ bytes: 100 });

    const back = await device.fileBudget("default");
    expect(back.ok && back.value.file_cache.setting).toBe("default");
    expect((await cacheOf(device)).budget).not.toBe(100);
  });

  it("keeps every file fetched when told to, and reports no budget", async () => {
    harness = await started("budget-keep-all");
    const { device } = harness;
    expect((await device.fileBudget("keep-all")).ok).toBe(true);
    // A volume with no room, which the default would empty the cache for.
    const tight = unbounded(TB, 1);

    const hashes: string[] = [];
    await withFault(tight, async () => {
      for (const name of ["a", "b", "c"]) {
        hashes.push(await fetched(harness as Harness, ten(name)));
      }
    });
    for (const hash of hashes) {
      expect(existsSync(heldAt(device, hash))).toBe(true);
    }
    const cache = await withFault(tight, () => cacheOf(device));
    expect(cache.setting).toBe("keep_all");
    expect(cache.budget).toBeNull();
    expect(cache.held).toBe(30);

    // The witness: the same volume under the default budget empties them.
    const back = await withFault(tight, () => device.fileBudget("default"));
    expect(back.ok && back.value.file_cache.held).toBe(0);
    for (const hash of hashes) {
      expect(existsSync(heldAt(device, hash))).toBe(false);
    }
  });
});

describe("a trim to the file budget", () => {
  it("runs after a fetch, takes the bytes read longest ago first and stops when the rest fit", async () => {
    harness = await started("trim-fetch");
    const { device } = harness;
    expect((await device.fileBudget("25")).ok).toBe(true);

    const a = await fetched(harness, ten("a"));
    const b = await fetched(harness, ten("b"));
    // The witness: twenty bytes fit, and a trim that took anything here would
    // also take them below.
    expect(existsSync(heldAt(device, a))).toBe(true);
    expect(existsSync(heldAt(device, b))).toBe(true);

    // Reading `a` again makes `b` the one read longest ago.
    expect((await device.blob(a)).ok).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 30));
    const c = await fetched(harness, ten("c"));

    expect(
      existsSync(heldAt(device, b)),
      "the bytes read longest ago were kept",
    ).toBe(false);
    expect(
      existsSync(heldAt(device, a)),
      "the trim went on past the budget, or took by when the bytes were fetched",
    ).toBe(true);
    expect(existsSync(heldAt(device, c))).toBe(true);
    expect((await cacheOf(device)).held).toBe(20);
  });

  it("runs after an upload is queued", async () => {
    harness = await started("trim-upload");
    const { device } = harness;
    expect((await device.fileBudget("15")).ok).toBe(true);
    const a = await fetched(harness, ten("a"));
    expect(existsSync(heldAt(device, a))).toBe(true);

    const queued = await device.putBlob(fileOf("note.txt", ten("n")));
    expect(queued.ok, JSON.stringify(queued)).toBe(true);
    expect(
      existsSync(heldAt(device, a)),
      "queueing an upload took no fetched bytes from a cache over its budget",
    ).toBe(false);
  });

  it("runs when asked, and the default budget it fits is the volume's at that moment", async () => {
    harness = await started("trim-asked");
    const { device } = harness;
    const hashes: string[] = [];
    // On a volume with room, so that the machine's own disk being full cannot
    // trim the first fetch away.
    await withFault(volume(TB, TB / 2), async () => {
      for (const name of ["a", "b", "c"]) {
        hashes.push(await fetched(harness as Harness, ten(name)));
      }
    });

    // The volume has since filled to leave room for 15 of the 30 bytes.
    const narrow = unbounded(TB, TB / 20 - 15);
    const shown = await withFault(narrow, () => cacheOf(device));
    expect(shown.budget).toBe(15);
    expect(shown.held).toBe(30);
    for (const hash of hashes) {
      expect(
        existsSync(heldAt(device, hash)),
        "a state report trimmed the cache",
      ).toBe(true);
    }

    const asked = await withFault(narrow, () =>
      device.fileBudget(undefined, { trim: true }),
    );
    expect(asked.ok && asked.value.trimmed_bytes).toBe(20);
    expect(hashes.map((hash) => existsSync(heldAt(device, hash)))).toEqual([
      false,
      false,
      true,
    ]);
  });

  it("runs when the budget is set, so a lowered one gives the space back", async () => {
    harness = await started("trim-set");
    const { device } = harness;
    const a = await fetched(harness, ten("a"));
    const b = await fetched(harness, ten("b"));
    const c = await fetched(harness, ten("c"));
    const set = await device.fileBudget("20");
    expect(set.ok, JSON.stringify(set)).toBe(true);
    if (!set.ok) return;
    expect(set.value.trimmed_bytes).toBe(10);
    expect(set.value.file_cache.held).toBe(20);
    expect(existsSync(heldAt(device, a))).toBe(false);
    expect(existsSync(heldAt(device, b))).toBe(true);

    // Asked to trim as well, it reports what setting the budget took, since
    // the trim after it finds nothing left to take.
    const both = await device.fileBudget("10", { trim: true });
    expect(both.ok && both.value.trimmed_bytes).toBe(10);
    expect(existsSync(heldAt(device, b))).toBe(false);
    expect(existsSync(heldAt(device, c))).toBe(true);

    // The witness: showing the budget takes nothing and reports nothing.
    const shown = await device.fileBudget();
    expect(shown.ok && shown.value.trimmed_bytes).toBeNull();
  });

  it("keeps the bytes a queued upload names, under a budget of zero", async () => {
    harness = await started("trim-keeps-upload");
    const { device } = harness;
    const bytes = ten("only copy");
    const queued = await device.putBlob(fileOf("note.txt", bytes));
    expect(queued.ok, JSON.stringify(queued)).toBe(true);
    const fetchedOnce = await fetched(harness, ten("a"));
    expect(existsSync(heldAt(device, fetchedOnce))).toBe(true);

    expect((await device.fileBudget("0")).ok).toBe(true);
    // The witness: the same trim took the bytes that nothing names.
    expect(existsSync(heldAt(device, fetchedOnce))).toBe(false);
    expect(
      existsSync(heldAt(device, hashOf(bytes))),
      "a trim took the bytes of an upload the server does not hold yet",
    ).toBe(true);
    expect(readFileSync(heldAt(device, hashOf(bytes)))).toEqual(bytes);

    // Nor does a trim after a fetch.
    await fetched(harness, ten("b"));
    expect(readFileSync(heldAt(device, hashOf(bytes)))).toEqual(bytes);
  });

  it("keeps the bytes being read, under a budget of zero", async () => {
    harness = await started("trim-keeps-read");
    const { device } = harness;
    expect((await device.fileBudget("0")).ok).toBe(true);
    const bytes = ten("read");
    const hash = scriptBlob(harness.server, bytes);
    const got = await device.blob(hash);
    expect(got.ok, JSON.stringify(got)).toBe(true);
    if (!got.ok) return;
    expect(
      readFileSync(got.value.path),
      "the bytes a caller was about to read were taken",
    ).toEqual(bytes);

    // The witness: the next ask takes them, and keeps its own.
    const next = ten("next");
    const nextHash = scriptBlob(harness.server, next);
    expect((await device.blob(nextHash)).ok).toBe(true);
    expect(existsSync(heldAt(device, hash))).toBe(false);
    expect(readFileSync(heldAt(device, nextHash))).toEqual(next);
  });
});

describe.runIf(process.platform === "darwin")(
  "backups of the file cache on a Mac",
  () => {
    const excluded = (path: string): boolean => {
      const said = execFileSync("tmutil", ["isexcluded", path], {
        encoding: "utf8",
      });
      expect(said).toMatch(/\[(In|Ex)cluded\]/);
      return said.includes("[Excluded]");
    };

    it("keeps the bytes it fetched out of backups, and the bytes of an upload in them", async () => {
      // The system excludes its own temporary folders, so the store has to sit
      // under the home folder for the verdict to be the device's.
      const area = mkdtempSync(join(homedir(), ".marfa-conformance-backup-"));
      scratch.push(area);
      harness = await started("backup");
      const device = new CliDevice({
        binary: requireBinary(),
        store: join(area, "core.sqlite"),
        url: harness.server.url,
        key: KEY,
      });
      expect((await device.status()).ok).toBe(true);

      const upload = ten("upload");
      const queued = await device.putBlob(fileOf("note.txt", upload));
      expect(queued.ok, JSON.stringify(queued)).toBe(true);
      const hash = scriptBlob(harness.server, ten("fetched"));
      expect((await device.blob(hash)).ok).toBe(true);

      // The mark is on each fetched file, which tmutil reports.
      expect(
        excluded(heldAt(device, hash)),
        "tmutil does not exclude the fetched file",
      ).toBe(true);
      expect(
        excluded(heldAt(device, hashOf(upload))),
        "the only copy of an upload is kept out of backups",
      ).toBe(false);
      expect(
        excluded(`${device.store}.blobs`),
        "the folder that holds uploads is kept out of backups",
      ).toBe(false);
      expect((await cacheOf(device)).backup_mark_failure).toBeNull();
    });

    it("says in its state report when fetched bytes cannot be kept out of backups", async () => {
      harness = await started("backup-refused");
      const { device } = harness;
      // The witness: a fetch that marks its file reports nothing.
      await fetched(harness, ten("marked"));
      expect((await cacheOf(device)).backup_mark_failure).toBeNull();

      const refused = scriptBlob(harness.server, ten("refused"));
      const got = await withFault("backup-mark-refused", () =>
        device.blob(refused),
      );
      expect(got.ok, "the bytes were refused with the mark").toBe(true);
      const said = (await cacheOf(device)).backup_mark_failure;
      expect(said).toEqual(expect.any(String));
      expect(said).not.toBe("");

      // Until a fetch marks its file again.
      await fetched(harness, ten("again"));
      expect((await cacheOf(device)).backup_mark_failure).toBeNull();
    });
  },
);
