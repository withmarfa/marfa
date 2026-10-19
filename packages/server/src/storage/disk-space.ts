import { statSync, statfsSync } from "node:fs";
import { open, statfs } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { Writable } from "node:stream";
import { ErrorCode, MarfaError } from "@withmarfa/shared";
import { freeFault, type Volume } from "../control/faults.js";
import { TransactionFailure } from "./sqlite/transaction-control.js";

export type AvailableBytes = (path: string) => Promise<number>;
const volumeBytes: AvailableBytes = async (path) => {
  const stats = await statfs(path);
  return stats.bavail * stats.bsize;
};
let probe: AvailableBytes = volumeBytes;

/** Lets a test say how much room there is. `undefined` restores the volume. */
export function setAvailableBytesProbe(next: AvailableBytes | undefined): void {
  probe = next ?? volumeBytes;
}
export const availableBytesOn: AvailableBytes = (path) => probe(path);

class VolumeLedger {
  owed = 0;
  private line: Promise<void> = Promise.resolve();

  async acquire(): Promise<() => void> {
    const before = this.line;
    let release!: () => void;
    this.line = new Promise<void>((resolve) => {
      release = resolve;
    });
    await before;
    return release;
  }
}

const volumes = new Map<number, VolumeLedger>();

/** Resolve the actual device, including symlinks and paths not created yet. */
function volumeAt(path: string) {
  let parent = resolve(path);
  for (;;) {
    try {
      const device = statSync(parent).dev;
      let ledger = volumes.get(device);
      if (!ledger) {
        ledger = new VolumeLedger();
        volumes.set(device, ledger);
      }
      return { ledger, path: parent, block: statfsSync(parent).bsize };
    } catch (error) {
      if (
        (error as NodeJS.ErrnoException).code !== "ENOENT" ||
        dirname(parent) === parent
      )
        throw error;
      parent = dirname(parent);
    }
  }
}

/** Every reserve user on a device shares one ledger, including paths on different mounts of it. */
export class DiskReserve {
  private readonly volume;
  constructor(
    path: string,
    readonly bytes: number,
    private readonly available: AvailableBytes = availableBytesOn,
    private readonly kind: Volume = "blobs",
  ) {
    this.volume = volumeAt(path);
  }

  private free(): Promise<number> {
    const set = freeFault(this.kind);
    return set === undefined
      ? this.available(this.volume.path)
      : Promise.resolve(set);
  }

  private refusal(free: number): MarfaError {
    return new MarfaError(
      ErrorCode.INSUFFICIENT_STORAGE,
      "The disk has no room for this write and the configured reserve.",
      { reserve_bytes: this.bytes, available_bytes: free },
    );
  }

  round(bytes: number): number {
    return Math.ceil(bytes / this.volume.block) * this.volume.block;
  }

  async admit(declared = 0): Promise<Admission> {
    if (!Number.isSafeInteger(declared) || declared < 0) declared = 0;
    const release = await this.volume.ledger.acquire();
    try {
      const bytes = this.bytes === 0 ? 0 : this.round(declared);
      await this.check(bytes);
      this.volume.ledger.owed += bytes;
      return new Admission(this, bytes);
    } finally {
      release();
    }
  }

  private async check(extra: number): Promise<void> {
    if (this.bytes === 0) return;
    const free = await this.free();
    if (free - this.volume.ledger.owed - extra < this.bytes)
      throw this.refusal(free);
  }

  async look(): Promise<void> {
    const release = await this.volume.ledger.acquire();
    try {
      await this.check(0);
    } finally {
      release();
    }
  }

  /** The OS write and its payment settle before another writer samples free space. */
  async write(
    held: number,
    bytes: number,
    write: () => Promise<void>,
  ): Promise<number> {
    const release = await this.volume.ledger.acquire();
    try {
      await this.check(Math.max(0, bytes - held));
      await write();
      const paid = Math.min(held, bytes);
      this.pay(paid);
      return paid;
    } finally {
      release();
    }
  }

  pay(bytes: number): void {
    this.volume.ledger.owed -= bytes;
  }

  scratch(): ScratchBudget {
    let held = 0;
    let release: (() => void) | undefined;
    let closed = false;
    const isClosed = () => closed;
    return {
      acquire: async () => {
        const unlock = await this.volume.ledger.acquire();
        if (isClosed()) {
          unlock();
          throw new Error("Scratch budget is closed");
        }
        release = unlock;
        try {
          if (this.bytes === 0) return Number.MAX_SAFE_INTEGER;
          const free = await this.free();
          if (isClosed()) throw new Error("Scratch budget is closed");
          const room =
            Math.floor(
              Math.max(
                0,
                free - this.bytes - (this.volume.ledger.owed - held),
              ) / this.volume.block,
            ) * this.volume.block;
          // An operation holds the remaining growth capacity only until it settles.
          this.volume.ledger.owed += room - held;
          held = room;
          return room;
        } catch (error) {
          release = undefined;
          unlock();
          throw error;
        }
      },
      settle: (pending) => {
        if (isClosed()) return;
        const next = this.bytes === 0 ? 0 : this.round(pending);
        this.volume.ledger.owed += next - held;
        held = next;
        release?.();
        release = undefined;
      },
      close: () => {
        closed = true;
        this.pay(held);
        held = 0;
        release?.();
        release = undefined;
      },
    };
  }
}

/** SQLite keeps dirty pages in memory until commit; they still owe disk space. */
export interface ScratchBudget {
  acquire(): Promise<number>;
  settle(pending: number): void;
  close(): void;
}

export class Admission {
  private closed = false;
  private written = 0;
  constructor(
    private readonly reserve: DiskReserve,
    private owes: number,
  ) {}

  async write(bytes: number, write: () => Promise<void>): Promise<void> {
    if (this.closed) throw new Error("Disk admission is closed");
    const growth =
      this.reserve.round(this.written + bytes) -
      this.reserve.round(this.written);
    const paid = await this.reserve.write(this.owes, growth, write);
    this.owes -= paid;
    this.written += bytes;
  }

  /** Payment follows the file write, never the upstream stream's delivery. */
  writer(path: string): Writable {
    const file = open(path, "wx");
    let position = 0;
    const writer = new Writable({
      write: (chunk: Buffer, _encoding, callback) => {
        this.write(chunk.length, async () => {
          const handle = await file;
          let offset = 0;
          while (offset < chunk.length) {
            const { bytesWritten } = await handle.write(
              chunk,
              offset,
              chunk.length - offset,
              position,
            );
            if (bytesWritten === 0)
              throw new Error("Spool write made no progress");
            offset += bytesWritten;
            position += bytesWritten;
          }
        }).then(
          () => {
            callback();
          },
          (error: unknown) => {
            callback(error instanceof Error ? error : new Error(String(error)));
          },
        );
      },
      destroy: (error, callback) => {
        file
          .then((handle) => handle.close())
          .then(
            () => {
              callback(error);
            },
            (failure: unknown) => {
              callback(
                error ??
                  (failure instanceof Error
                    ? failure
                    : new Error(String(failure))),
              );
            },
          );
      },
    });
    // The writes and `destroy` answer a failed open.
    file.catch(() => undefined);
    return writer;
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.reserve.pay(this.owes);
    this.owes = 0;
  }
}

/** The driver and operating-system codes for a volume with no room left. */
const FULL_CODES = new Set(["ENOSPC", "EDQUOT"]);

/**
 * The typed refusal for a write the volume turned away, wherever in the
 * error's `cause` chain the operating system's or the database's own code
 * sits, or `undefined` for any other fault.
 *
 * A commit the volume turned away leaves the write's outcome unknown
 * (`TransactionFailure`), and the refusal says so rather than promising
 * nothing was kept.
 *
 * The chain, because the query layer wraps what the driver threw and the
 * code is on the original. Bounded because a chain is data and may cycle.
 */
export function diskFull(err: unknown): MarfaError | undefined {
  let unknown = false;
  for (let step: unknown = err, depth = 0; depth < 8; depth++) {
    if (step instanceof MarfaError) return undefined;
    if (step === null || typeof step !== "object") return undefined;
    if (step instanceof TransactionFailure) {
      unknown ||= step.control.outcome === "unknown";
    }
    const code = (step as { code?: unknown }).code;
    if (
      typeof code === "string" &&
      (FULL_CODES.has(code) || code.startsWith("SQLITE_FULL"))
    ) {
      return unknown
        ? new MarfaError(
            ErrorCode.INSUFFICIENT_STORAGE,
            "The disk that holds this instance's data is full, and the write may have landed before it was. Read what you changed before you repeat it.",
            { write_outcome: "unknown" },
          )
        : new MarfaError(
            ErrorCode.INSUFFICIENT_STORAGE,
            "The disk that holds this instance's data is full.",
          );
    }
    step = (step as { cause?: unknown }).cause;
  }
  return undefined;
}
