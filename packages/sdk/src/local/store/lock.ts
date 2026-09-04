import { randomUUID } from "node:crypto";
import { linkSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";

/**
 * One writer per store.
 *
 * Two engines over one store file is not a corruption problem — SQLite in
 * WAL handles concurrent writers — it is a correctness one. Each would keep
 * its own idea of where the stream had reached, apply events the other had
 * already applied, and advance one shared cursor past what either of them
 * had actually taken. The store would look healthy and be missing rows
 * neither engine could name.
 *
 * The lock is the engine's own and is not an application's single-instance
 * lock. Those answer a different question — whether a second window should
 * open — and an app may legitimately want one while this refuses a second
 * writer over the same file.
 */

/**
 * Held stores in this process, by lock path.
 *
 * The lockfile alone would answer for a second process and not for a
 * second `openLocalStore` in this one, because a file this process created
 * looks to it exactly like a file it is entitled to take over. The
 * in-process set is what separates "my own lock" from "a lock I may
 * reclaim", and it is also the whole mechanism for `:memory:`, which has
 * no file to contend over and is shared process-wide.
 */
const heldInProcess = new Set<string>();

export interface StoreLock {
  /** Whether this caller may write. */
  readonly writer: boolean;
  /** Who holds it, when this caller does not. */
  readonly heldBy: LockHolder | undefined;
  release(): void;
}

export interface LockHolder {
  pid: number;
  /** Distinguishes this hold from any other, including a later hold by
   *  this same process. Without it, releasing means trusting a process id
   *  to identify a hold, and a process only ever holds one at a time by
   *  accident. */
  token: string;
  since: string;
  /**
   * When the machine the holder runs on was started.
   *
   * A process id is not an identity across a restart: the machine reboots,
   * the number is handed out again, and a liveness check on it answers yes
   * for a process that has nothing to do with this store — leaving it
   * read-only for ever with no way for anyone to work out why. Comparing
   * the boot the lock was written under against the current one settles
   * that without needing to inspect a process this one does not own.
   *
   * It does not cover a process id recycled *within* one boot, which is
   * far rarer and would need the holder's own start time — not something
   * a portable API will give for a process this one does not own.
   */
  bootedAt: number;
}

/** When this machine started, to the nearest second's worth of jitter. */
function machineBootedAt(): number {
  return Math.round(Date.now() - process.uptime() * 1000);
}

/** How far two readings of the boot instant may differ and still mean the
 *  same boot. `uptime` is sampled against a moving clock, so two processes
 *  never compute it identically. */
const BOOT_TOLERANCE_MS = 5_000;

/** Where the lock for a store lives. `:memory:` has no file, so it
 *  contends only in this process. */
function lockPathFor(storePath: string): string | undefined {
  if (storePath === ":memory:") return undefined;
  if (/^(https?|libsql):/.test(storePath)) return undefined;
  const file = storePath.startsWith("file:") ? storePath.slice(5) : storePath;
  return `${file.split("?")[0] ?? file}.lock`;
}

/** Whether a process is still there to hold anything. */
function alive(pid: number): boolean {
  try {
    // Signal 0 performs the permission and existence checks and delivers
    // nothing, which is the portable way to ask.
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // `EPERM` means the process exists and belongs to somebody else, which
    // is still a live holder. Only `ESRCH` says nothing is there.
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function readHolder(path: string): LockHolder | undefined {
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    const holder = parsed as Partial<LockHolder>;
    if (typeof holder.pid !== "number") return undefined;
    return {
      pid: holder.pid,
      token: holder.token ?? "unknown",
      since: holder.since ?? "unknown",
      bootedAt: holder.bootedAt ?? 0,
    };
  } catch {
    // A lockfile that will not parse is one nothing valid ever wrote —
    // the claim below puts the holder in place atomically, so there is no
    // half-written state to meet. Treating it as nobody's is right: the
    // alternative is a store nothing can ever open again.
    return undefined;
  }
}

/** Whether the process named by a holder can still be running. */
function stillHolding(holder: LockHolder): boolean {
  // Written under a different boot, so the process id names something
  // else now — or nothing. Checked before liveness, because liveness on a
  // reused number answers yes and would keep this store read-only for
  // good.
  if (Math.abs(holder.bootedAt - machineBootedAt()) > BOOT_TOLERANCE_MS) {
    return false;
  }
  return alive(holder.pid);
}

/**
 * Take the writer lock for a store, or report who has it.
 *
 * Never blocks and never waits. A second opener is told it cannot write
 * rather than being queued behind a holder that may never let go, because
 * the caller can do something useful with a read-only store and can do
 * nothing at all with a promise that has not settled.
 */
export function acquireStoreLock(storePath: string): StoreLock {
  const path = lockPathFor(storePath);
  const key = path ?? `memory:${storePath}`;

  if (heldInProcess.has(key)) {
    return {
      writer: false,
      heldBy: {
        pid: process.pid,
        token: "held-here",
        since: "this process",
        bootedAt: machineBootedAt(),
      },
      release: () => undefined,
    };
  }

  if (path === undefined) {
    heldInProcess.add(key);
    return {
      writer: true,
      heldBy: undefined,
      release: () => heldInProcess.delete(key),
    };
  }

  const token = randomUUID();

  /**
   * Take the lock, with the holder already in it.
   *
   * Written to a private file and then hard-linked into place, because
   * `link` fails when the target exists and carries the payload with it.
   * An exclusive create followed by a write is not the same thing: between
   * the two the file exists and is empty, and a second opener arriving
   * there finds a file it cannot read, concludes nobody holds it, removes
   * it and claims — so both believe they hold the lock and the first
   * writes into a file that is no longer linked to anything.
   */
  const claim = (): boolean => {
    const staging = `${path}.${String(process.pid)}.${token}.claim`;
    try {
      writeFileSync(
        staging,
        JSON.stringify({
          pid: process.pid,
          token,
          since: new Date().toISOString(),
          bootedAt: machineBootedAt(),
        }),
      );
      linkSync(staging, path);
      return true;
    } catch {
      return false;
    } finally {
      try {
        unlinkSync(staging);
      } catch {
        // Never created, or already gone. The link, if it was made, keeps
        // the content alive independently of this name.
      }
    }
  };

  if (!claim()) {
    const holder = readHolder(path);
    // A holder that is not running left the file behind when it died. Take
    // it over rather than refusing for ever: a crashed engine must not
    // make its own store permanently read-only.
    if (holder !== undefined && stillHolding(holder)) {
      return { writer: false, heldBy: holder, release: () => undefined };
    }
    try {
      unlinkSync(path);
    } catch {
      // Another opener got there first. Fall through and let the retry
      // decide, rather than assuming which of us won.
    }
    if (!claim()) {
      return {
        writer: false,
        heldBy: readHolder(path) ?? {
          pid: -1,
          token: "unknown",
          since: "unknown",
          bootedAt: 0,
        },
        release: () => undefined,
      };
    }
  }

  heldInProcess.add(key);
  return {
    writer: true,
    heldBy: undefined,
    release: () => {
      heldInProcess.delete(key);
      // Only this hold's own file. A lock taken over by something that
      // judged this process dead now belongs to whoever is writing, and
      // deleting it would let a third opener take a store two engines are
      // already using — which is the failure this whole file exists to
      // prevent, arriving on the way out.
      if (readHolder(path)?.token !== token) return;
      try {
        unlinkSync(path);
      } catch {
        // Taken over between the read above and here. Nothing to release.
      }
    },
  };
}
