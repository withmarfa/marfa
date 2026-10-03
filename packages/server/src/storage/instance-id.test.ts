/**
 * The identity is minted once and then never moves.
 *
 * Every door that shows it calls `ensureInstanceId`, so "the root, `/config`
 * and the manifest agree" is a property of this function rather than of the
 * three call sites — but only while it is idempotent. A read-then-write
 * spelling would pass every one of those doors' own tests and still hand two
 * concurrent callers two different names, which is what the concurrent case
 * below is for.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { isValidId } from "@withmarfa/shared";
import { createSqliteStorage } from "./sqlite/index.js";
import { ensureInstanceId, INSTANCE_ID_KEY } from "./instance-id.js";
import { readInstanceConfig, writeInstanceConfig } from "./instance-config.js";
import type { SettingsStore, Storage } from "./interface.js";

const dirs: string[] = [];
const open: Storage[] = [];

async function freshStorage(): Promise<{ storage: Storage; path: string }> {
  const dir = mkdtempSync(join(tmpdir(), "marfa-instance-id-"));
  dirs.push(dir);
  const path = join(dir, "marfa.db");
  const storage = await createSqliteStorage(path);
  open.push(storage);
  return { storage, path };
}

afterEach(async () => {
  for (const storage of open.splice(0)) {
    try {
      await storage.close();
    } catch {
      // Best-effort; the directory below goes either way.
    }
  }
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

/**
 * Two views of one store, sequenced into the interleaving that tells an
 * atomic claim apart from an overwrite.
 *
 * The order forced is: both callers read and find nothing, then the leader
 * writes and reads back, then the follower writes and reads back. Under
 * `claim` the follower's insert does nothing and it reads the leader's
 * value; under `set` it overwrites, and the two callers have returned two
 * different names for one instance.
 *
 * It has to be forced. `Promise.all` over one store does not produce it —
 * the driver serializes the statements, so both writes land before either
 * read-back and the two callers agree on the last writer's value whichever
 * spelling is used. That is why the obvious concurrency test passes against
 * the very mutation it looks like it is for.
 */
function sequencedPair(inner: SettingsStore): [SettingsStore, SettingsStore] {
  let arrived = 0;
  let openBoth!: () => void;
  const bothRead = new Promise<void>((resolve) => {
    openBoth = resolve;
  });
  let leaderDone!: () => void;
  const leaderFinished = new Promise<void>((resolve) => {
    leaderDone = resolve;
  });

  const reachBoth = async (): Promise<void> => {
    arrived += 1;
    if (arrived >= 2) openBoth();
    await bothRead;
  };

  const view = (isLeader: boolean): SettingsStore => {
    let reads = 0;
    return {
      ...inner,
      get: async (key: string) => {
        reads += 1;
        const value = await inner.get(key);
        if (reads === 1) await reachBoth();
        if (reads === 2 && isLeader) leaderDone();
        return value;
      },
      set: async (key: string, value: string) => {
        if (!isLeader) await leaderFinished;
        return inner.set(key, value);
      },
      claim: async (key: string, value: string) => {
        if (!isLeader) await leaderFinished;
        return inner.claim(key, value);
      },
      release: (key: string) => inner.release(key),
    };
  };

  return [view(true), view(false)];
}

describe("the instance identity", () => {
  it("initializes identity at boot and answers the same one through ensured and pinned reads", async () => {
    const { storage } = await freshStorage();
    const bootIdentity = await storage.settings.get(INSTANCE_ID_KEY);
    expect(isValidId(bootIdentity!)).toBe(true);
    expect(await ensureInstanceId(storage.settings)).toBe(bootIdentity);
    expect(await storage.runInReadSnapshot((pin) => pin.instanceId)).toBe(
      bootIdentity,
    );
    expect(await storage.settings.get(INSTANCE_ID_KEY)).toBe(bootIdentity);
  });

  it("ensureInstanceId mints and persists an identity when its settings store has none", async () => {
    const { storage } = await freshStorage();
    await storage.settings.release(INSTANCE_ID_KEY);
    expect(await storage.settings.get(INSTANCE_ID_KEY)).toBeNull();
    const minted = await ensureInstanceId(storage.settings);
    expect(isValidId(minted)).toBe(true);
    expect(await ensureInstanceId(storage.settings)).toBe(minted);
    expect(await storage.settings.get(INSTANCE_ID_KEY)).toBe(minted);
  });

  it("survives a reopen of the same database", async () => {
    // What makes it the deployment's name rather than the process's. A
    // per-process id would satisfy every same-run assertion in the suite and
    // rename the instance on every restart.
    const { storage, path } = await freshStorage();
    const minted = await ensureInstanceId(storage.settings);
    await storage.close();
    open.splice(open.indexOf(storage), 1);

    const reopened = await createSqliteStorage(path);
    open.push(reopened);
    expect(await ensureInstanceId(reopened.settings)).toBe(minted);
  });

  it("hands two callers that both found nothing the same name", async () => {
    // The replica case, driven rather than hoped for. Two processes boot
    // against one database, both read no row, and then both write — and a
    // read-then-write spelling lets each return the value it generated, so
    // the instance answers two names and whichever an archive recorded is
    // wrong.
    //
    // `sequencedPair` forces the interleaving, and its own comment says
    // why nothing less does. The plain `Promise.all` version of this test
    // passed against `set` as happily as against `claim`.
    const { storage } = await freshStorage();
    await storage.settings.release(INSTANCE_ID_KEY);
    expect(await storage.settings.get(INSTANCE_ID_KEY)).toBeNull();
    const [leader, follower] = sequencedPair(storage.settings);
    const [a, b] = await Promise.all([
      ensureInstanceId(leader),
      ensureInstanceId(follower),
    ]);
    expect(a).toBe(b);
    expect(await storage.settings.get(INSTANCE_ID_KEY)).toBe(a);
  });

  it("survives the wholesale clear of the instance configuration", async () => {
    // Why it is its own settings key. `PUT /config` is a full replacement,
    // so an identity held inside the configuration object would leave with
    // the first `{}` anyone sent — and an instance that can lose its name to
    // an ordinary configuration write has no identity at all.
    const { storage } = await freshStorage();
    const minted = await ensureInstanceId(storage.settings);
    await writeInstanceConfig(storage.settings, { audit_retention_days: 45 });
    expect(await readInstanceConfig(storage.settings)).toEqual({
      audit_retention_days: 45,
    });

    await writeInstanceConfig(storage.settings, {});
    // The witness: the clear reached the configuration, so the identity
    // below is surviving something rather than sitting beside a no-op.
    expect(await readInstanceConfig(storage.settings)).toEqual({});
    expect(await ensureInstanceId(storage.settings)).toBe(minted);
  });
});
