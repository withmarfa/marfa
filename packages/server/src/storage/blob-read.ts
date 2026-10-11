import { pipeline, Readable, Transform } from "node:stream";

export const DEFAULT_BLOB_READ_IDLE_TIMEOUT_MS = 30_000;

/** Backpressure alone cannot release a response whose caller abandoned it. */
export function boundBlobRead(
  source: Readable,
  idleTimeoutMs = DEFAULT_BLOB_READ_IDLE_TIMEOUT_MS,
): Readable {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let sourceFinished = false;
  const clear = () => {
    if (timer) clearTimeout(timer);
    timer = undefined;
  };
  const refresh = () => {
    if (sourceFinished) return;
    clear();
    timer = setTimeout(() => {
      const error = Object.assign(
        new Error("Blob read idle deadline exceeded"),
        {
          code: "ERR_BLOB_READ_IDLE",
        },
      );
      output.destroy(error);
    }, idleTimeoutMs);
    timer.unref();
  };
  const output = new Transform({
    readableHighWaterMark: 64 * 1024,
    writableHighWaterMark: 64 * 1024,
    transform(chunk: Buffer, _encoding, callback) {
      refresh();
      callback(null, chunk);
    },
  });
  // An abandoned stream has no caller to observe an error. Its next reader
  // still receives the stored stream error, without an uncaught event.
  output.on("error", () => {
    // The idle deadline must not throw in a caller that dropped the body.
  });
  const finish = () => {
    sourceFinished = true;
    clear();
  };
  source.once("end", finish);
  source.once("close", finish);
  output.once("close", clear);
  refresh();
  try {
    pipeline(source, output, () => {
      clear();
    });
  } catch (error) {
    clear();
    source.destroy();
    output.destroy();
    throw error;
  }
  return output;
}
