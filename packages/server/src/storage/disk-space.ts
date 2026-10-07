import { statfs } from "node:fs/promises";
import { Transform } from "node:stream";
import { ErrorCode, MarfaError } from "@withmarfa/shared";
import { TransactionFailure } from "./sqlite/transaction-control.js";

/** The bytes a writer may add to the volume that holds `path`. */
export type AvailableBytes = (path: string) => Promise<number>;

/**
 * `statfs` as Node gives it, in blocks of `f_bsize`. A filesystem whose
 * `f_bsize` is not its fragment size, which ZFS is one of, is overstated
 * here; Node does not expose `f_frsize`.
 */
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

/**
 * How much a stream writes between two looks at the volume. A look is a
 * system call, so it is not made per chunk. Bodies in flight can each be
 * this far ahead of their last look, so each is counted at this much
 * against the room.
 */
export const RESERVE_CHECK_EVERY_BYTES = 4 * 1024 * 1024;

/** The finest a look is made, however small the reserve. */
const LEAST_LOOK_EVERY_BYTES = 64 * 1024;

/**
 * The room an instance keeps free on the volume its uploads and restores
 * write into, so that one body cannot take the last of it.
 *
 * The database sits on that volume in the shipped image. A write that finds
 * none left fails, and so does the next one, whatever it is. The reserve is
 * what the rest of the instance keeps writing with while an oversized body
 * is refused.
 *
 * Bodies arrive together, and each would find the same free space, so the
 * reserve counts what the bodies it has admitted have yet to write.
 */
export class DiskReserve {
  /** Bytes admitted bodies declared and have not yet written. */
  private owed = 0;
  /** Bodies admitted and not yet closed. */
  private open = 0;
  /** Admissions waiting their turn. */
  private line: Promise<void> = Promise.resolve();

  constructor(
    private readonly volume: string,
    readonly bytes: number,
    private readonly available: AvailableBytes = availableBytesOn,
  ) {}

  private get lookEvery(): number {
    return Math.max(
      LEAST_LOOK_EVERY_BYTES,
      Math.min(RESERVE_CHECK_EVERY_BYTES, Math.floor(this.bytes / 2)),
    );
  }

  /**
   * Refuses unless `declared` more bytes, and what the bodies already
   * admitted have yet to write, leave the reserve free. A body that knows
   * how many bytes are coming says so before the first is written; one that
   * does not says `0`, which refuses only a volume already inside the
   * reserve. Close what it returns when the body has been written or has
   * failed.
   */
  admit(declared = 0): Promise<Admission> {
    // One at a time, because each reads the room and then takes some of it:
    // two reading together would each find the same room.
    const turn = this.line.then(async () => {
      if (this.bytes > 0) {
        const free = await this.available(this.volume);
        if (free - this.room(declared, 1) < this.bytes) {
          throw this.refusal(free);
        }
      }
      this.owed += declared;
      this.open += 1;
      return new Admission(this, declared);
    });
    this.line = turn.then(
      () => undefined,
      () => undefined,
    );
    return turn;
  }

  /** What is spoken for ahead of the next byte written. */
  private room(declared: number, joining: number): number {
    return this.owed + declared + (this.open + joining) * this.lookEvery;
  }

  /** @internal What the admitted bodies still owe, for an admission to pay down. */
  pay(bytes: number): void {
    this.owed = Math.max(0, this.owed - bytes);
  }

  /** @internal */
  leave(): void {
    this.open = Math.max(0, this.open - 1);
  }

  /** @internal */
  get interval(): number {
    return this.lookEvery;
  }

  /** @internal */
  async look(): Promise<void> {
    if (this.bytes === 0) return;
    const free = await this.available(this.volume);
    // What the volume shows already includes what has been written, so only
    // what is still owed, and the slack of every body in flight, comes off.
    if (free - this.room(0, 0) < this.bytes) throw this.refusal(free);
  }

  private refusal(free: number): MarfaError {
    return new MarfaError(
      ErrorCode.INSUFFICIENT_STORAGE,
      "The disk that holds this instance's data has no room for this request and the reserve the instance keeps free. Nothing was kept.",
      { reserve_bytes: this.bytes, available_bytes: free },
    );
  }
}

/** One body's place against the reserve. */
export class Admission {
  private owes: number;
  private closed = false;

  constructor(
    private readonly reserve: DiskReserve,
    declared: number,
  ) {
    this.owes = declared;
  }

  /**
   * A pass-through that looks at the volume as the bytes go by and fails the
   * stream when what is left falls inside the reserve. Placed in front of
   * the file the bytes are written to, so a body that has no length at all,
   * or that a decompressor inflates as it goes, is stopped on the way and
   * not when the volume is full.
   */
  guard(): Transform {
    let sinceLook = 0;
    return new Transform({
      transform: (chunk: Buffer, _encoding, callback) => {
        const paid = Math.min(chunk.length, this.owes);
        this.owes -= paid;
        this.reserve.pay(paid);
        sinceLook += chunk.length;
        if (this.reserve.bytes === 0 || sinceLook < this.reserve.interval) {
          callback(null, chunk);
          return;
        }
        sinceLook = 0;
        this.reserve.look().then(
          () => {
            callback(null, chunk);
          },
          (err: unknown) => {
            callback(err instanceof Error ? err : new Error(String(err)));
          },
        );
      },
    });
  }

  /** Gives back what was admitted and not written. Safe to call twice. */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.reserve.pay(this.owes);
    this.owes = 0;
    this.reserve.leave();
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
