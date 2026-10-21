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

/** What `sql` prints against the database on a stopped `volume`. */
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
    expect(
      query(fresh, "SELECT name FROM starts ORDER BY rowid;").split("\n"),
    ).toEqual(["first", "second", "fresh"]);
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
    const started = newestTxid(await replicaAt(`${fresh}/db/0000`));
    await write(copy, "after-move");
    await replicaPast(`${fresh}/db/0000`, started);
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
    const started = newestTxid(await replicaAt(`${prefix}/db/0000`, before));
    await write(copy, "after-override");
    await replicaPast(`${prefix}/db/0000`, started);
    expect(await replaced.stop()).toBe(0);
    expect(replaced.output()).toContain("MARFA_REPLACE_NEWER_REPLICA is set");
  });
});
