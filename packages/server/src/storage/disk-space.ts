import { statfs } from "node:fs/promises";
import { Transform } from "node:stream";
import { ErrorCode, MarfaError } from "@withmarfa/shared";

/** The bytes a writer may add to the volume that holds `path`. */
export type AvailableBytes = (path: string) => Promise<number>;

export const availableBytesOn: AvailableBytes = async (path) => {
  const stats = await statfs(path);
  return stats.bavail * stats.bsize;
};

/**
 * How much a stream writes between two looks at the volume. A look is a
 * system call, so it is not made per chunk; the reserve is far larger than
 * this, so the free space can fall this far past the line between looks.
 */
export const RESERVE_CHECK_EVERY_BYTES = 4 * 1024 * 1024;

/**
 * The room an instance keeps free on the volume its uploads and restores
 * write into, so that one body cannot take the last of it.
 *
 * The database sits on that volume in the shipped image. A write that finds
 * none left fails as an untyped fault, and so does the next one, whatever it
 * is. The reserve is what the rest of the instance keeps writing with
 * while an oversized body is refused.
 */
export class DiskReserve {
  constructor(
    private readonly volume: string,
    readonly bytes: number,
    private readonly available: AvailableBytes = availableBytesOn,
  ) {}

  /**
   * Refuses unless `incoming` more bytes leave the reserve free. A caller
   * that knows how many bytes are coming asks before the first is written;
   * one that does not asks with `0`, which refuses only a volume already
   * inside the reserve.
   */
  async admit(incoming = 0): Promise<void> {
    if (this.bytes === 0) return;
    const free = await this.available(this.volume);
    if (free - incoming < this.bytes) throw this.refusal(free, incoming);
  }

  /**
   * A pass-through that looks at the volume as the bytes go by and fails the
   * stream when what is left falls inside the reserve. Placed in front of
   * the file the bytes are written to, so a body that is larger than its
   * header said, or that has no length at all, or that a decompressor
   * inflates as it goes, is stopped on the way and not when the volume is
   * full.
   */
  guard(): Transform {
    let sinceLook = 0;
    return new Transform({
      transform: (chunk: Buffer, _encoding, callback) => {
        sinceLook += chunk.length;
        if (this.bytes === 0 || sinceLook < RESERVE_CHECK_EVERY_BYTES) {
          callback(null, chunk);
          return;
        }
        sinceLook = 0;
        this.admit().then(
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

  private refusal(free: number, incoming: number): MarfaError {
    return new MarfaError(
      ErrorCode.INSUFFICIENT_STORAGE,
      "The disk that holds this instance's data has no room for this request and the reserve the instance keeps free. Nothing was kept.",
      {
        reserve_bytes: this.bytes,
        available_bytes: free,
        ...(incoming > 0 && { incoming_bytes: incoming }),
      },
    );
  }
}

/** The driver and operating-system codes for a volume with no room left. */
const FULL_CODES = new Set(["ENOSPC", "EDQUOT"]);

/**
 * The typed refusal for a write the volume turned away, wherever in the
 * error's `cause` chain the operating system's or the database's own code
 * sits, or `undefined` for any other fault.
 *
 * The chain, because the query layer wraps what the driver threw and the
 * code is on the original. Bounded because a chain is data and may cycle.
 */
export function diskFull(err: unknown): MarfaError | undefined {
  for (let step: unknown = err, depth = 0; depth < 8; depth++) {
    if (step instanceof MarfaError) return undefined;
    if (step === null || typeof step !== "object") return undefined;
    const code = (step as { code?: unknown }).code;
    if (
      typeof code === "string" &&
      (FULL_CODES.has(code) || code.startsWith("SQLITE_FULL"))
    ) {
      return new MarfaError(
        ErrorCode.INSUFFICIENT_STORAGE,
        "The disk that holds this instance's data is full. Nothing was kept.",
      );
    }
    step = (step as { cause?: unknown }).cause;
  }
  return undefined;
}
