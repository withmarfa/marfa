/**
 * What a store promises about itself, whatever the server is doing.
 *
 * No fixture and no network: every rule here is between a store and the
 * process that opened it.
 */
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir, uptime as osUptime } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  openLocalStore,
  ReadOnlyStoreError,
  StoreIdentityMismatchError,
  StoreUnrecoverableError,
  type LocalStore,
  type StoreRecovery,
} from "./store/index.js";
import { SINGLE_ACCOUNT, SINGLE_SPACE } from "./types.js";

let dir: string;
let path: string;
let open: LocalStore[];

const AT = "2026-09-01T00:00:00.000Z";

/**
 * The boot instant the lock actually records, read back out of a real
 * lockfile.
 *
 * Read rather than recomputed, and that is the whole point. A test that
 * recomputes the expression the code uses is testing that two copies of
 * one expression agree, which they do however wrong the expression is —
 * and inside a single process any such expression is self-consistent, so
 * every assertion built on a private copy stays green through a
 * substitution that breaks the code for two processes.
 */
async function recordedBootedAt(): Promise<number> {
  const store = await openLocalStore({ path, identity });
  try {
    const holder = JSON.parse(readFileSync(`${path}.lock`, "utf8")) as {
      bootedAt: number;
    };
    return holder.bootedAt;
  } finally {
    store.close();
  }
}

const identity = {
  origin: "http://localhost",
  spaceId: SINGLE_SPACE,
  accountId: SINGLE_ACCOUNT,
};

async function openAt(
  overrides: Partial<Parameters<typeof openLocalStore>[0]> = {},
): Promise<LocalStore> {
  const store = await openLocalStore({ path, identity, ...overrides });
  open.push(store);
  return store;
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "marfa-local-promises-"));
  path = join(dir, "store.db");
  open = [];
});

afterEach(() => {
  for (const store of open.splice(0)) {
    try {
      store.close();
    } catch {
      // Already closed by the scenario that was testing exactly that.
    }
  }
  rmSync(dir, { recursive: true, force: true });
});

describe("one writer per store", () => {
  it("gives a second opener a handle that reads and will not write", async () => {
    const first = await openAt();
    await first.mutations.createItem({
      type: "core.note",
      properties: { body: "written by the holder" },
    });

    const second = await openAt();

    expect(first.writer).toBe(true);
    expect(second.writer).toBe(false);

    // Reads work, and that is the point: a second window showing the data
    // is useful, a second window writing to it is not.
    expect(await second.outbox.count()).toBe(1);
    expect(await second.visible.listItems()).toHaveLength(1);

    // Every write refuses, the cursor included. That one is the reason for
    // the rule: two engines each keep their own idea of where the stream
    // has reached and would record both in the one place there is.
    await expect(
      second.mutations.createItem({
        type: "core.note",
        properties: { body: "from the second" },
      }),
    ).rejects.toThrow(ReadOnlyStoreError);
    await expect(second.syncState.setCursor(identity, "99")).rejects.toThrow(
      ReadOnlyStoreError,
    );
    expect((await first.syncState.read(identity))?.cursor).toBeNull();
  });

  it("hands the lock on when the holder closes", async () => {
    const first = await openAt();
    expect(first.writer).toBe(true);
    first.close();

    // A store that stayed read-only after its holder let go would make a
    // restart impossible, which is the ordinary case rather than the rare
    // one.
    const second = await openAt();
    expect(second.writer).toBe(true);
  });

  it("does not delete a lock it no longer holds", async () => {
    const first = await openAt();
    expect(first.writer).toBe(true);

    // The lock taken over by something that judged this process dead —
    // wrongly, or after a stall. Closing must not delete it: the file now
    // belongs to whoever is writing, and removing it would let a third
    // opener take a store two engines are already using.
    writeFileSync(
      `${path}.lock`,
      JSON.stringify({
        pid: process.pid + 1,
        token: "somebody-else",
        since: AT,
        bootedAt: await recordedBootedAt(),
      }),
    );
    first.close();

    expect(existsSync(`${path}.lock`)).toBe(true);
  });

  it("treats a lock written before this machine started as stale", async () => {
    // A process id says nothing on its own across a restart: the machine
    // reboots, the number is handed to something unrelated, and a
    // liveness check on it answers yes for ever. The boot the lock was
    // written under is what separates a holder that is still running from
    // a number that has been reused.
    writeFileSync(
      `${path}.lock`,
      JSON.stringify({
        pid: process.pid,
        token: "from-a-previous-boot",
        since: AT,
        bootedAt: (await recordedBootedAt()) - 86_400_000,
      }),
    );

    const store = await openAt();
    expect(store.writer).toBe(true);
  });

  it("takes over from a holder that is no longer running", async () => {
    // The lockfile a process leaves behind when it dies. Refusing for ever
    // on one would make a crash permanent: the engine's own store would be
    // read-only until somebody deleted a file they had no reason to know
    // about.
    writeFileSync(
      `${path}.lock`,
      JSON.stringify({
        pid: 999_999_999,
        token: "gone",
        since: AT,
        bootedAt: await recordedBootedAt(),
      }),
    );

    const store = await openAt();
    expect(store.writer).toBe(true);
  });

  it("records when the machine started, not when this process did", async () => {
    // Checked against an independent reading of the same fact rather than
    // against a copy of the code's own arithmetic. `process.uptime()` is
    // how long *this process* has run and reads as a plausible spelling of
    // the same idea; on a machine that has been up for days the two are
    // days apart, and every process on it computes a different one.
    //
    // That difference is not a race. `stillHolding` compares boots before
    // it ever asks whether the holder is alive, so a second opener that
    // started a minute after the holder computes a minute's "boot
    // difference", judges a live holder to be from a previous boot,
    // unlinks its lockfile and claims — leaving two writers on every
    // ordinary second launch.
    const recorded = await recordedBootedAt();
    const machine = Date.now() - osUptime() * 1000;
    expect(Math.abs(recorded - machine)).toBeLessThan(5_000);

    // On a machine booted moments ago the two readings coincide and this
    // cannot discriminate; on any machine that has been up longer than the
    // tolerance it separates them outright.
  });

  it("writes the holder and the file in one step", async () => {
    const first = await openAt();
    expect(first.writer).toBe(true);

    // The file exists only once it already carries who holds it. Created
    // empty and filled in afterwards, there is a window in which a second
    // opener finds a file it cannot read, concludes nobody holds it,
    // removes it and claims — leaving two writers and the first one
    // writing into an unlinked file.
    const holder = JSON.parse(readFileSync(`${path}.lock`, "utf8")) as {
      pid: number;
      token: string;
    };
    expect(holder.pid).toBe(process.pid);
    expect(holder.token).toEqual(expect.any(String));
  });
});

describe("a store knows whose it is", () => {
  it("refuses to open as somebody else", async () => {
    const first = await openAt();
    first.close();

    // Same file, another account. A store holds one corpus and one cursor;
    // opened as somebody else it would apply one account's events over
    // another's rows and leave a cursor describing neither.
    await expect(
      openLocalStore({
        path,
        identity: { ...identity, accountId: "another-account" },
      }),
    ).rejects.toThrow(StoreIdentityMismatchError);
  });

  it("refuses on a different origin as readily as a different account", async () => {
    const first = await openAt();
    first.close();

    await expect(
      openLocalStore({
        path,
        identity: { ...identity, origin: "https://elsewhere.example" },
      }),
    ).rejects.toThrow(StoreIdentityMismatchError);
  });

  it("opens as the identity it recorded", async () => {
    const first = await openAt();
    first.close();
    const again = await openAt();
    expect(again.identity).toEqual(identity);
  });
});

describe("a store this build cannot open", () => {
  /** Stamp the migrator's table with a migration from the future. */
  async function pretendNewer(store: LocalStore): Promise<void> {
    await store.raw.execute(
      "INSERT INTO __drizzle_migrations (hash, created_at) VALUES ('from-a-later-build', 9999999999999)",
    );
  }

  it("keeps the queue in a sidecar, rebuilds, and says so", async () => {
    const first = await openAt();
    await first.mutations.createItem({
      type: "core.note",
      properties: { body: "never sent" },
    });
    await first.deadLetters.record({
      id: "01a00000-0000-7000-8000-00000000000d",
      seq: 1,
      kind: "item.create",
      targetKind: "item",
      targetId: "01a00000-0000-7000-8000-00000000000e",
      payload: {},
      reason: "refused",
      code: "unknown_type",
      message: "refused earlier",
      httpStatus: 400,
      failedAt: "2026-09-01T00:00:00.000Z",
    });
    await pretendNewer(first);
    first.close();

    const reports: StoreRecovery[] = [];
    const rebuilt = await openAt({
      onRecovery: (recovery) => reports.push(recovery),
    });

    const report = reports[0];
    if (report === undefined) throw new Error("expected a recovery report");
    expect(report).toMatchObject({
      reason: "store_is_newer",
      outbox: 1,
      deadLetters: 1,
    });

    // The rescued work is on disk, and it is the only copy: the store it
    // came from has been set aside and the fresh one starts empty. An
    // engine that rebuilt without writing this would leave a person with
    // a working app and no way to know what went missing.
    const sidecar = JSON.parse(readFileSync(report.sidecarPath, "utf8")) as {
      outbox: unknown[];
      deadLetters: unknown[];
    };
    expect(sidecar.outbox).toHaveLength(1);
    expect(sidecar.deadLetters).toHaveLength(1);
    expect(existsSync(report.supersededPath)).toBe(true);

    expect(await rebuilt.outbox.count()).toBe(0);
    expect(rebuilt.writer).toBe(true);
  });

  it("refuses rather than rebuilding when it cannot be set aside", async () => {
    const first = await openAt();
    await first.mutations.createItem({
      type: "core.note",
      properties: { body: "never sent" },
    });
    await pretendNewer(first);
    first.close();

    // Something already at the name the sidecar needs — an earlier
    // rescue, which must not be overwritten. Whatever the obstacle, the
    // rule is the same: nothing is moved until the rescued work has
    // landed, so a failure here leaves the store exactly as it was.
    //
    // "Always recovers, sometimes silently loses everything" is worse than
    // "recovers when it can, otherwise fails loudly", because only the
    // second is something a consumer can act on.
    const now = () => "2026-09-01T00:00:00.000Z";
    const stamp = now().replace(/[:.]/g, "-");
    rmSync(`${path}.recovery-${stamp}.json`, { force: true });
    writeFileSync(`${path}.recovery-${stamp}.json`, "an earlier rescue");

    await expect(openLocalStore({ path, identity, now })).rejects.toThrow(
      StoreUnrecoverableError,
    );

    // The store is where it was, with nothing set aside — so the queue it
    // holds is still there to rescue once the obstacle is cleared. Checked
    // on the files rather than by opening again, because opening again
    // with a working clock would succeed and recover, which proves the
    // recovery rather than the refusal.
    expect(existsSync(path)).toBe(true);
    expect(readdirSync(dir).filter((n) => n.includes(".superseded-"))).toEqual(
      [],
    );
  });
});
