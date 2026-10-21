/**
 * What the image does when the volume already holds a database and the
 * bucket holds a replica of it: the instance chapter's
 * `instance/replica-not-older` rule. `harness.ts` says what each boot runs
 * and what it needs.
 *
 * Each test works under a prefix of its own and removes it at the end.
 */
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
} from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  boot,
  closeBucket,
  dataDir,
  keysUnder,
  newVolume,
  openBucket,
  pause,
  replicaAt,
  sqlitePath,
  start,
} from "./harness.js";

const run = `older-database/${randomBytes(4).toString("hex")}`;

beforeAll(() => {
  openBucket();
});

afterAll(async () => {
  await closeBucket([`${run}/`]);
});

const LTX_NAME = /([0-9a-f]{16})-([0-9a-f]{16})\.ltx$/;

/** The newest transaction any of `names` reaches, or 0 when none is an LTX file. */
function newestTxid(names: string[]): bigint {
  let newest = 0n;
  for (const name of names) {
    const max = LTX_NAME.exec(name)?.[2];
    if (max !== undefined && BigInt(`0x${max}`) > newest)
      newest = BigInt(`0x${max}`);
  }
  return newest;
}

/** The last transaction Litestream's record on `volume` says it replicated. */
function recordedTxid(volume: string): bigint {
  const dir = join(dataDir(volume), ".marfa.db-litestream", "ltx", "0");
  return existsSync(dir) ? newestTxid(readdirSync(dir)) : 0n;
}

/** What `sql` prints against the database on `volume`. */
function query(volume: string, sql: string): string {
  const result = spawnSync("sqlite3", [sqlitePath(volume), sql], {
    encoding: "utf8",
  });
  if (result.status !== 0) throw new Error(result.stderr);
  return result.stdout.trim();
}

/**
 * The database on `volume` folded into its file, and its log and shared
 * memory removed, as a restore by hand leaves one.
 */
function foldLog(volume: string): void {
  const path = sqlitePath(volume);
  query(volume, "PRAGMA wal_checkpoint(TRUNCATE);");
  // Some builds of SQLite keep an empty log after the last connection closes.
  expect(existsSync(`${path}-wal`) ? statSync(`${path}-wal`).size : 0).toBe(0);
  rmSync(`${path}-wal`, { force: true });
  rmSync(`${path}-shm`, { force: true });
}

/** Waits until the replica under `path` reaches a transaction after `txid`. */
async function replicaPast(path: string, txid: bigint): Promise<void> {
  const deadline = Date.now() + 20_000;
  while (newestTxid(await keysUnder(`${path}/`)) <= txid) {
    if (Date.now() > deadline)
      throw new Error(`the replica at ${path} did not pass ${String(txid)}`);
    await pause(250);
  }
}

/**
 * Waits until Litestream on `volume` has recorded every write made so far,
 * which it does within a second, and the replica under `path` holds them.
 */
async function caughtUp(volume: string, path: string): Promise<void> {
  const deadline = Date.now() + 20_000;
  for (;;) {
    const recorded = recordedTxid(volume);
    await pause(1_500);
    if (
      recordedTxid(volume) === recorded &&
      newestTxid(await keysUnder(`${path}/`)) >= recorded
    ) {
      return;
    }
    if (Date.now() > deadline)
      throw new Error(
        `the replica at ${path} did not catch up with the volume`,
      );
  }
}

/** Writes rows on the instance running on `volume` until its record passes `txid`. */
async function writePast(volume: string, txid: bigint): Promise<void> {
  for (let i = 0; recordedTxid(volume) <= txid; i++) {
    if (i === 20)
      throw new Error(`the record did not pass ${String(txid)} in 20 writes`);
    await write(volume, `past-${String(i)}`);
  }
}

/** The rows the stand-in server wrote on `volume`, one per start, in order. */
function starts(volume: string): string[] {
  return query(volume, "SELECT name FROM starts ORDER BY rowid;").split("\n");
}

/**
 * Litestream's record on `volume` with every level-0 file but the newest
 * removed, as its level-0 retention leaves a volume that has run for more
 * than a few minutes.
 */
function keepNewestLocalLtx(volume: string): void {
  const dir = join(dataDir(volume), ".marfa.db-litestream", "ltx", "0");
  const names = readdirSync(dir).filter((name) => LTX_NAME.test(name));
  const newest = newestTxid(names);
  expect(newest).toBeGreaterThan(1n);
  for (const name of names) {
    if (newestTxid([name]) !== newest) rmSync(join(dir, name));
  }
}

/**
 * Writes a row to the database of the instance running on `volume`, and
 * waits until Litestream has recorded the transaction.
 */
async function write(volume: string, name: string): Promise<void> {
  const before = recordedTxid(volume);
  query(volume, `INSERT INTO starts VALUES ('${name}');`);
  const deadline = Date.now() + 20_000;
  while (recordedTxid(volume) <= before) {
    if (Date.now() > deadline)
      throw new Error(`Litestream did not record the write ${name}`);
    await pause(100);
  }
}

/** A copy of everything on `volume`, Litestream's record included. */
function copyVolume(volume: string): string {
  const copy = newVolume();
  cpSync(dataDir(volume), dataDir(copy), { recursive: true });
  return copy;
}

/**
 * An instance that started twice under `prefix`, and a copy of its volume
 * taken between the two starts, which the replica has since moved past.
 * The first start writes `laterWrites` more rows after its first
 * transaction, each a transaction of its own.
 */
async function startedTwice(prefix: string, laterWrites = 0) {
  const volume = newVolume();
  const first = await boot(volume, "first", prefix);
  expect(first.bootedAs).toBe("fresh");
  await replicaAt(`${prefix}/db`);
  for (let i = 0; i < laterWrites; i++) await write(volume, `first-${i}`);
  expect(await first.stop()).toBe(0);

  const copy = copyVolume(volume);
  const copied = recordedTxid(copy);
  expect(copied).toBeGreaterThan(0n);

  const second = await boot(volume, "second", prefix);
  expect(second.bootedAs).toBe("first");
  await replicaPast(`${prefix}/db`, copied);
  expect(await second.stop()).toBe(0);
  return { volume, copy, copied };
}

/** Starts `volume` and expects the entrypoint to refuse it and leave the bucket as it was. */
async function expectRefused(volume: string, prefix: string, finding: string) {
  const before = await keysUnder(`${prefix}/`);
  const refused = await start(volume, "refused", prefix);
  expect(refused.started).toBe(false);
  if (refused.started) return;
  expect(refused.code).toBe(1);
  expect(refused.output).toContain(finding);
  expect(refused.output).toContain(
    "Replication has not started, and the bucket is unchanged.",
  );
  expect(refused.output).toContain('"Start a backup under a new prefix"');
  expect(refused.output).toContain("MARFA_REPLACE_NEWER_REPLICA=true");
  expect(await keysUnder(`${prefix}/`)).toEqual(before);
}

describe("deploy/entrypoint.sh with a database already on the volume", () => {
  it("starts a volume that last replicated the replica's newest transaction, and replicates its next writes", async () => {
    const prefix = `${run}/up-to-date`;
    const { volume } = await startedTwice(prefix);
    const before = await keysUnder(`${prefix}/db/`);

    const again = await boot(volume, "third", prefix);
    expect(again.bootedAs).toBe("first");
    await replicaPast(`${prefix}/db/0000`, newestTxid(before));
    expect(await again.stop()).toBe(0);
  });

  it("starts a volume that last replicated the replica's newest transaction after its log was moved into the database", async () => {
    const prefix = `${run}/log-folded`;
    const { volume } = await startedTwice(prefix);
    foldLog(volume);

    const again = await boot(volume, "third", prefix);
    expect(again.bootedAs).toBe("first");
    expect(await again.stop()).toBe(0);
  });

  it("restores the replica's newest state to a fresh volume", async () => {
    const prefix = `${run}/fresh`;
    await startedTwice(prefix);

    const fresh = newVolume();
    const restored = await boot(fresh, "fresh", prefix);
    expect(restored.bootedAs).toBe("first");
    expect(await restored.stop()).toBe(0);
    expect(starts(fresh)).toEqual(["first", "second", "fresh"]);
  });

  it("refuses a volume copied before the replica's newest transaction, and leaves the bucket unchanged", async () => {
    const prefix = `${run}/whole-copy`;
    const { copy, copied } = await startedTwice(prefix);
    expect(newestTxid(await keysUnder(`${prefix}/db/`))).toBeGreaterThan(
      copied,
    );

    await expectRefused(copy, prefix, "is older than the replica");
  });

  it("refuses an older database copied without Litestream's record, and leaves the bucket unchanged", async () => {
    const prefix = `${run}/database-only`;
    const { copy } = await startedTwice(prefix);
    foldLog(copy);
    const bare = newVolume();
    mkdirSync(dataDir(bare));
    copyFileSync(sqlitePath(copy), sqlitePath(bare));

    await expectRefused(bare, prefix, "has no record of replicating");
  });

  it("refuses an older database put in place of the one the volume replicated, and leaves the bucket unchanged", async () => {
    const prefix = `${run}/in-place`;
    const { volume, copy } = await startedTwice(prefix);
    foldLog(copy);
    const path = sqlitePath(volume);
    rmSync(`${path}-wal`, { force: true });
    rmSync(`${path}-shm`, { force: true });
    copyFileSync(sqlitePath(copy), path);

    await expectRefused(
      volume,
      prefix,
      "is not the one this volume last replicated",
    );
  });

  it("starts an older database under a new prefix that holds no replica, replicates its writes there, and leaves the old replica unchanged", async () => {
    const prefix = `${run}/old-prefix`;
    const fresh = `${run}/new-prefix`;
    const { copy } = await startedTwice(prefix, 2);
    keepNewestLocalLtx(copy);
    const old = await keysUnder(`${prefix}/`);

    const moved = await boot(copy, "moved", fresh);
    expect(moved.bootedAs).toBe("first");
    await replicaAt(`${fresh}/db/0000`);
    await write(copy, "after-move");
    await replicaPast(`${fresh}/db/0000`, recordedTxid(copy) - 1n);
    expect(await moved.stop()).toBe(0);
    expect(moved.output()).toContain("Removing Litestream's record");
    expect(await keysUnder(`${prefix}/`)).toEqual(old);
  });

  it("replicates an older database when MARFA_REPLACE_NEWER_REPLICA is true, and says so", async () => {
    const prefix = `${run}/override`;
    const { copy } = await startedTwice(prefix);
    const before = await keysUnder(`${prefix}/db/`);

    const replaced = await boot(copy, "replaced", prefix, {
      MARFA_REPLACE_NEWER_REPLICA: "true",
    });
    expect(replaced.bootedAs).toBe("first");
    await replicaAt(`${prefix}/db/0000`, before);
    await write(copy, "after-override");
    await caughtUp(copy, `${prefix}/db`);
    expect(await replaced.stop()).toBe(0);
    expect(replaced.output()).toContain("MARFA_REPLACE_NEWER_REPLICA is set");

    // The older database is now the replica's newest state: the second
    // start's row is gone from it, and the rows after the override are there.
    const fresh = newVolume();
    const restored = await boot(fresh, "fresh", prefix);
    expect(restored.bootedAs).toBe("first");
    expect(await restored.stop()).toBe(0);
    expect(starts(fresh)).toEqual([
      "first",
      "replaced",
      "after-override",
      "fresh",
    ]);
  });

  it("starts a volume replicated before the entrypoint named the replica beside the database, and names it", async () => {
    const prefix = `${run}/upgraded`;
    const { volume } = await startedTwice(prefix);
    const marker = `${sqlitePath(volume)}-replica`;
    // A volume an earlier image replicated holds the record and no marker.
    rmSync(marker, { force: true });
    const before = await keysUnder(`${prefix}/db/`);

    const again = await boot(volume, "third", prefix);
    expect(again.bootedAs).toBe("first");
    await replicaPast(`${prefix}/db/0000`, newestTxid(before));
    expect(await again.stop()).toBe(0);
    expect(readFileSync(marker, "utf8")).toBe(
      `endpoint=${process.env.S3_ENDPOINT ?? ""}\nbucket=${process.env.S3_BUCKET ?? ""}\nprefix=${prefix}\n`,
    );
  });

  it("refuses an older copy that replicated under another prefix until its record passed this replica, and leaves the bucket unchanged", async () => {
    const prefix = `${run}/switch-back`;
    const other = `${run}/switch-back-other`;
    const { copy } = await startedTwice(prefix);
    const newest = newestTxid(await keysUnder(`${prefix}/db/`));

    const moved = await boot(copy, "moved", other);
    await replicaAt(`${other}/db/0000`);
    await writePast(copy, newest);
    await caughtUp(copy, `${other}/db`);
    expect(await moved.stop()).toBe(0);

    await expectRefused(
      copy,
      prefix,
      `last replicated to the replica at ${other}/db`,
    );
  });

  it("restores the replica onto a volume whose database was deleted after it replicated another prefix further, and replicates its writes", async () => {
    const prefix = `${run}/restore-here`;
    const other = `${run}/restore-other`;
    const source = newVolume();
    const first = await boot(source, "first", prefix);
    await replicaAt(`${prefix}/db`);
    expect(await first.stop()).toBe(0);
    const newest = newestTxid(await keysUnder(`${prefix}/db/`));

    const volume = newVolume();
    const elsewhere = await boot(volume, "elsewhere", other);
    await replicaAt(`${other}/db/0000`);
    // Far enough past that the file after this replica's newest transaction
    // is one Litestream's retention removed from the record.
    await writePast(volume, newest + 2n);
    expect(await elsewhere.stop()).toBe(0);
    keepNewestLocalLtx(volume);
    const path = sqlitePath(volume);
    for (const file of [path, `${path}-wal`, `${path}-shm`]) {
      rmSync(file, { force: true });
    }
    const before = await keysUnder(`${prefix}/db/`);

    const restored = await boot(volume, "restored", prefix);
    expect(restored.bootedAs).toBe("first");
    await replicaAt(`${prefix}/db/0000`, before);
    await write(volume, "after-restore");
    await caughtUp(volume, `${prefix}/db`);
    expect(await restored.stop()).toBe(0);

    const fresh = newVolume();
    const again = await boot(fresh, "fresh", prefix);
    expect(again.bootedAs).toBe("first");
    expect(await again.stop()).toBe(0);
    expect(starts(fresh)).toEqual([
      "first",
      "restored",
      "after-restore",
      "fresh",
    ]);
    expect(restored.output()).toContain("Removing Litestream's record");
  });
});
