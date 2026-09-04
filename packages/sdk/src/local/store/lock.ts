import {
  openSync,
  closeSync,
  readFileSync,
  unlinkSync,
  writeSync,
} from "node:fs";

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
  since: string;
}

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
    return { pid: holder.pid, since: holder.since ?? "unknown" };
  } catch {
    // An unreadable or truncated lockfile is one a process died in the
    // middle of writing. Treating it as nobody's is right: the alternative
    // is a store nothing can ever open again.
    return undefined;
  }
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
      heldBy: { pid: process.pid, since: "this process" },
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

  const claim = (): boolean => {
    try {
      // `wx` fails when the file exists, and it does so in one syscall —
      // which is what makes this a lock rather than a check followed by a
      // write that another process can land between.
      const fd = openSync(path, "wx");
      try {
        writeSync(
          fd,
          JSON.stringify({ pid: process.pid, since: new Date().toISOString() }),
        );
      } finally {
        closeSync(fd);
      }
      return true;
    } catch {
      return false;
    }
  };

  if (!claim()) {
    const holder = readHolder(path);
    // A holder that is not running left the file behind when it died. Take
    // it over rather than refusing for ever: a crashed engine must not
    // make its own store permanently read-only.
    if (holder !== undefined && alive(holder.pid)) {
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
        heldBy: readHolder(path) ?? { pid: -1, since: "unknown" },
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
      try {
        unlinkSync(path);
      } catch {
        // Already gone, or taken over by something that judged this
        // process dead. Either way there is nothing left to release.
      }
    },
  };
}
